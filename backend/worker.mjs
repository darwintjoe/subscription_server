const ACCESS_TTL_SECONDS = 60 * 60;
const REFRESH_TTL_SECONDS = 60 * 60 * 24 * 30;
const DURATIONS = ["1_day", "6_months", "12_months"];
const PURCHASE_DURATIONS = ["6_months", "12_months"];
const PAYMENT_METHODS = ["qris", "card"];
const FLOW_TYPES = ["direct_subscribe", "reseller_code", "bulk_printed_card"];
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const USER_STATUSES = ["active", "inactive"];
const USER_ROLES = ["admin", "reseller"];
const STORE_USERS_KEY = "users";
const STORE_CONFIG_KEY = "config";
const STORE_QUEUE_KEY = "backup_queue";
const STORE_LAST_BATCH_KEY = "last_sent_batch";
const DEFAULT_PAYMENT_METHODS = {
  qris: { enabled: true, provider: "xendit" },
  card: { enabled: true, provider: "stripe" },
};

export default {
  async fetch(request, env, ctx) {
    try {
      if (request.method === "OPTIONS") {
        return corsPreflight(request);
      }
      const response = await router(request, env, ctx);
      return withCors(request, response);
    } catch (error) {
      return withCors(request, json({ error: "internal_error", detail: error.message }, 500));
    }
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runScheduledBackupV2(env));
  },
};

async function router(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const db = requireDb(env);

  if (request.method === "GET" && path === "/health") {
    return json({ ok: true, service: "subscription-server", storage: "kv+d1" });
  }

  if (request.method === "POST" && path === "/v1/auth/google/callback") {
    const limited = await enforceRateLimit(request, db, "auth_google_callback", 20, 60);
    if (limited) return limited;
    return handleGoogleCallbackV2(request, env);
  }

  if (request.method === "GET" && path === "/v1/auth/google/start") {
    const limited = await enforceRateLimit(request, db, "auth_google_start", 20, 60);
    if (limited) return limited;
    return handleGoogleStart(request, env);
  }

  if (request.method === "GET" && path === "/v1/auth/google/callback") {
    const limited = await enforceRateLimit(request, db, "auth_google_oauth_callback", 20, 60);
    if (limited) return limited;
    return handleGoogleOauthCallbackV2(request, env);
  }

  if (request.method === "POST" && path === "/v1/auth/refresh") {
    return handleRefreshV2(request, env);
  }

  if (request.method === "GET" && path === "/v1/me") {
    const auth = await requireAuthV2(request, env);
    if (auth.response) return auth.response;
    return json({ user: sanitizeUser(auth.user) });
  }

  if (request.method === "POST" && path === "/v1/pricing/quote") {
    return handlePricingQuoteV2(request, env);
  }

  if (request.method === "POST" && path === "/v1/client/subscription/quote") {
    return handleClientSubscriptionQuoteV2(request, env);
  }

  if (request.method === "POST" && path === "/v1/client/subscription/direct") {
    return handleDirectSubscribeV2(request, env, db);
  }

  if (request.method === "POST" && path === "/v1/client/subscription/redeem") {
    const limited = await enforceRateLimit(request, db, "client_codes_redeem", 10, 60);
    if (limited) return limited;
    return handleRedeemCodeV2(request, env, db);
  }

  if (request.method === "POST" && path === "/v1/codes/issue") {
    const auth = await optionalAuthV2(request, env);
    return handleIssueCodeV2(request, env, db, auth.user || null);
  }

  if (request.method === "POST" && path === "/v1/codes/redeem") {
    const limited = await enforceRateLimit(request, db, "codes_redeem", 10, 60);
    if (limited) return limited;
    const auth = await optionalAuthV2(request, env);
    return handleRedeemCodeV2(request, env, db, auth.user || null);
  }

  if (request.method === "GET" && path === "/v1/admin/config") {
    const auth = await requireAdminV2(request, env);
    if (auth.response) return auth.response;
    const config = await getAppConfigV2(env);
    return json({ config });
  }

  if (request.method === "PUT" && path === "/v1/admin/config") {
    const auth = await requireAdminV2(request, env);
    if (auth.response) return auth.response;
    return handleUpdateConfigV2(request, env, auth.user);
  }

  if (request.method === "GET" && path === "/v1/admin/users") {
    const auth = await requireAdminV2(request, env);
    if (auth.response) return auth.response;
    const users = await listUsersV2(env);
    return json({ users });
  }

  if (request.method === "PUT" && path.startsWith("/v1/admin/users/")) {
    const auth = await requireAdminV2(request, env);
    if (auth.response) return auth.response;
    const userId = decodeURIComponent(path.split("/")[4] || "");
    return handleUpdateUserV2(request, env, auth.user, userId);
  }

  if (request.method === "GET" && path === "/v1/admin/reports/summary") {
    const auth = await requireAdminV2(request, env);
    if (auth.response) return auth.response;
    return json(await buildAdminSummaryV2(env, db));
  }

  if (request.method === "GET" && path === "/v1/admin/codes") {
    const auth = await requireAdminV2(request, env);
    if (auth.response) return auth.response;
    const codes = await listCodesV2(db);
    return json({ codes });
  }

  if (request.method === "POST" && path === "/v1/admin/code-batches") {
    const auth = await requireAdminV2(request, env);
    if (auth.response) return auth.response;
    return handleCreateCodeBatchV2(request, env, db, auth.user);
  }

  if (request.method === "POST" && path === "/v1/admin/backup") {
    const auth = await requireAdminV2(request, env);
    if (auth.response) return auth.response;
    return handleManualBackupV2(env);
  }

  return json({ error: "not_found" }, 404);
}

async function handleGoogleCallback(request, env, db) {
  const body = await readJson(request);
  if (!body.id_token) return json({ error: "id_token_required" }, 400);

  const googleUser = await verifyGoogleIdentity(body.id_token, env);
  let user = await getUserByGoogleSub(db, googleUser.sub);
  const appConfig = await getAppConfig(db);

  if (!user) {
    user = await createUser(db, googleUser, ["reseller"]);
    user = await promoteFirstUserToAdmin(db, user);

    await appendAuditEvent(db, {
      eventType: "user.created",
      entityType: "user",
      entityId: user.id,
      actorUserRef: user.id,
      actorRole: highestRole(user.roles),
      payload: { email: user.email, roles: user.roles },
    });
  } else {
    user = await updateUserProfile(db, user.id, googleUser);
  }

  const session = await createSession(db, user.id);
  return json({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_in: ACCESS_TTL_SECONDS,
    user: sanitizeUser(user),
    auth_mode: appConfig.google_oauth_mode,
    onboarding_rule: appConfig.onboarding_rule,
  });
}

async function handleGoogleStart(request, env) {
  if (!env.GOOGLE_CLIENT_ID) return json({ error: "missing_GOOGLE_CLIENT_ID" }, 500);
  if (!env.GOOGLE_CLIENT_SECRET) return json({ error: "missing_GOOGLE_CLIENT_SECRET" }, 500);

  const url = new URL(request.url);
  const redirectUrl = url.searchParams.get("redirect_url") || deriveDefaultAppUrl(request);
  const state = b64url(new TextEncoder().encode(JSON.stringify({ redirect_url: redirectUrl })));
  const googleUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  googleUrl.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  googleUrl.searchParams.set("redirect_uri", deriveGoogleRedirectUri(request));
  googleUrl.searchParams.set("response_type", "code");
  googleUrl.searchParams.set("scope", "openid email profile");
  googleUrl.searchParams.set("access_type", "offline");
  googleUrl.searchParams.set("prompt", "consent");
  googleUrl.searchParams.set("state", state);

  return Response.redirect(googleUrl.toString(), 302);
}

async function handleGoogleOauthCallback(request, env, db) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  if (error) return oauthBounce(deriveReturnUrlFromState(state, request), { error });
  if (!code) return oauthBounce(deriveReturnUrlFromState(state, request), { error: "code_required" });

  try {
    const tokenData = await exchangeAuthorizationCode(request, env, code);
    const googleUser = await fetchGoogleUserProfile(tokenData.access_token);
    let user = await getUserByGoogleSub(db, googleUser.sub);
    const appConfig = await getAppConfig(db);

    if (!user) {
      user = await createUser(db, googleUser, ["reseller"]);
      user = await promoteFirstUserToAdmin(db, user);

      await appendAuditEvent(db, {
        eventType: "user.created",
        entityType: "user",
        entityId: user.id,
        actorUserRef: user.id,
        actorRole: highestRole(user.roles),
        payload: { email: user.email, roles: user.roles },
      });
    } else {
      user = await updateUserProfile(db, user.id, googleUser);
    }

    const session = await createSession(db, user.id);
    return oauthBounce(deriveReturnUrlFromState(state, request), {
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_in: ACCESS_TTL_SECONDS,
      auth_mode: "google_oauth_only",
      onboarding_rule: "first_user_admin",
      user: sanitizeUser(user),
    });
  } catch (exchangeError) {
    return oauthBounce(deriveReturnUrlFromState(state, request), { error: exchangeError.message });
  }
}

async function handleRefresh(request, db) {
  const body = await readJson(request);
  if (!body.refresh_token) return json({ error: "refresh_token_required" }, 400);
  const row = await db.prepare(`
    SELECT s.id, s.user_id, s.refresh_expires_at, u.email, u.display_name, u.picture_url, u.roles_json
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.refresh_token = ?
  `).bind(body.refresh_token).first();
  if (!row) return json({ error: "invalid_refresh_token" }, 401);
  if (Date.parse(row.refresh_expires_at) <= Date.now()) return json({ error: "refresh_token_expired" }, 401);

  const session = await createSession(db, row.user_id);
  return json({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_in: ACCESS_TTL_SECONDS,
    user: sanitizeUser(mapUserRow(row)),
  });
}

async function handleCreatePaymentIntent(request, db, user) {
  const body = await readJson(request);
  if (!FLOW_TYPES.includes(body.flow_type)) return json({ error: "invalid_flow_type" }, 400);
  if (!PURCHASE_DURATIONS.includes(body.duration_code)) return json({ error: "invalid_duration" }, 400);
  if (!PAYMENT_METHODS.includes(body.payment_method)) return json({ error: "invalid_payment_method" }, 400);

  const config = await getAppConfig(db);
  const methodConfig = config.payment_methods[body.payment_method];
  if (!methodConfig || !methodConfig.enabled) return json({ error: "payment_method_disabled" }, 409);

  const country = String(body.country_code || "").toUpperCase();
  const quote = resolveQuote(config.pricing, country, body.duration_code);
  const id = crypto.randomUUID();
  const channel = normalizeChannel(body.channel, user);
  const intent = {
    id,
    order_id: crypto.randomUUID(),
    actor_user_ref: user ? user.id : null,
    actor_role: user ? highestRole(user.roles) : "guest",
    actor_email: user ? user.email : null,
    channel,
    flow_type: body.flow_type,
    duration_code: body.duration_code,
    payment_method: body.payment_method,
    provider: methodConfig.provider,
    country_code: country || null,
    currency: quote.currency,
    amount_minor: quote.amount_minor,
    status: "pending",
    provider_ref: null,
    provider_payload_json: JSON.stringify({ checkout_url: `https://pay.example.com/${id}` }),
    metadata_json: JSON.stringify({ source: "api", request: body }),
  };

  await db.prepare(`
    INSERT INTO payment_intents (
      id, order_id, actor_user_ref, actor_role, actor_email, channel, flow_type, duration_code,
      payment_method, provider, country_code, currency, amount_minor, status, provider_ref,
      provider_payload_json, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    intent.id,
    intent.order_id,
    intent.actor_user_ref,
    intent.actor_role,
    intent.actor_email,
    intent.channel,
    intent.flow_type,
    intent.duration_code,
    intent.payment_method,
    intent.provider,
    intent.country_code,
    intent.currency,
    intent.amount_minor,
    intent.status,
    intent.provider_ref,
    intent.provider_payload_json,
    intent.metadata_json,
  ).run();

  await appendAuditEvent(db, {
    eventType: "payment_intent.created",
    entityType: "payment_intent",
    entityId: intent.id,
    actorUserRef: user ? user.id : null,
    actorRole: user ? highestRole(user.roles) : "guest",
    payload: intent,
  });

  return json(serializePaymentIntent(intent), 201);
}

async function handleGetPaymentIntent(id, db, user) {
  const row = await db.prepare(`SELECT * FROM payment_intents WHERE id = ?`).bind(id).first();
  if (!row) return json({ error: "intent_not_found" }, 404);
  if (!isAdmin(user) && row.actor_user_ref !== user.id) return json({ error: "forbidden" }, 403);
  return json(serializePaymentIntent(row));
}

async function handlePaymentWebhook(request, db, path) {
  const body = await readJson(request);
  const paymentIntentId = body.payment_intent_id;
  if (!paymentIntentId) return json({ error: "payment_intent_id_required" }, 400);
  const intent = await db.prepare(`SELECT * FROM payment_intents WHERE id = ?`).bind(paymentIntentId).first();
  if (!intent) return json({ error: "intent_not_found" }, 404);

  const provider = path === "/v1/webhooks/payments/mock" ? "mock" : path.split("/").pop();
  const paidAt = new Date().toISOString();
  await db.prepare(`
    UPDATE payment_intents
    SET status = 'paid', provider_ref = COALESCE(?, provider_ref), paid_at = ?, updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    WHERE id = ?
  `).bind(body.provider_ref || provider + ":" + paymentIntentId, paidAt, paymentIntentId).run();

  await appendAuditEvent(db, {
    eventType: "payment_intent.paid",
    entityType: "payment_intent",
    entityId: paymentIntentId,
    actorUserRef: null,
    actorRole: "system",
    payload: { provider, payment_intent_id: paymentIntentId },
  });

  return json({ accepted: true, status: "paid", payment_intent_id: paymentIntentId });
}

async function handleIssueCode(request, env, ctx, db, user) {
  const body = await readJson(request);
  if (!body.payment_intent_id) return json({ error: "payment_intent_id_required" }, 400);

  const intent = await db.prepare(`SELECT * FROM payment_intents WHERE id = ?`).bind(body.payment_intent_id).first();
  if (!intent) return json({ error: "intent_not_found" }, 404);
  if (intent.status !== "paid") return json({ error: "payment_not_paid" }, 409);
  if (user && !isAdmin(user) && intent.actor_user_ref && intent.actor_user_ref !== user.id) return json({ error: "forbidden" }, 403);

  const existing = await db.prepare(`SELECT id, code_value, status, redeem_expires_at FROM codes WHERE payment_ref = ?`).bind(intent.id).first();
  if (existing) {
    return json({
      code_id: existing.id,
      code_value: existing.code_value,
      status: existing.status,
      redeem_expires_at: existing.redeem_expires_at,
    });
  }

  const flow = body.flow_type || intent.flow_type;
  const durationCode = body.duration_code || intent.duration_code;
  const codeId = crypto.randomUUID();
  const now = Date.now();
  const redeemExpiresAt = flow === "reseller_code" ? new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString() : null;
  const payload = {
    code_id: codeId,
    app_id: "sellmore",
    duration_code: durationCode,
    flow_type: flow,
    iat: now,
    exp: redeemExpiresAt ? Date.parse(redeemExpiresAt) : null,
    payment_ref: intent.id,
  };
  const codeValue = await createReadableCodeValue(db, durationCode);
  const status = flow === "direct_subscribe" ? "redeemed" : "issued";
  const redeemedAt = flow === "direct_subscribe" ? new Date().toISOString() : null;

  await createCodeRecord(db, {
    codeId,
    codeValue,
    flow,
    durationCode,
    status,
    paymentRef: intent.id,
    issuedByUserRef: user ? user.id : null,
    redeemExpiresAt,
    redeemedAt,
    redeemedByUserRef: status === "redeemed" && user ? user.id : null,
    metadataJson: JSON.stringify(payload),
  });

  if (status === "redeemed") {
    await createCodeRedemption(db, {
      redemptionId: crypto.randomUUID(),
      codeId,
      redeemedByUserRef: user ? user.id : null,
      redeemedContext: "direct_subscribe_auto_redeem",
    });
  }

  const response = {
    code_id: codeId,
    code_value: codeValue,
    status,
    redeem_expires_at: redeemExpiresAt,
  };

  await appendAuditEvent(db, {
    eventType: "code.issued",
    entityType: "code",
    entityId: codeId,
    actorUserRef: user ? user.id : null,
    actorRole: user ? highestRole(user.roles) : "guest",
    payload: { ...response, payment_intent_id: intent.id, order_id: intent.order_id },
  });

  ctx.waitUntil(appendCodeBackup(env, db, "code_issued", { code: response, intent, actor: user }));
  return json(response, 201);
}

async function handleRedeemCode(request, env, ctx, db, user) {
  const body = await readJson(request);
  if (!body.code_value) return json({ error: "code_value_required" }, 400);

  const codeValue = normalizeCodeValue(body.code_value);
  if (isLegacySignedCode(codeValue)) {
    const decoded = await verifyCode(codeValue, env.CODE_PUBLIC_JWK);
    if (!decoded.valid) return json({ error: "invalid_code_signature" }, 409);
  } else if (!isReadableCodeFormat(codeValue)) {
    return json({ error: "invalid_code_format" }, 409);
  }

  const rec = await getCodeByValue(db, codeValue);
  if (!rec) return json({ error: "code_not_found" }, 404);
  if (rec.status === "redeemed") return json({ error: "already_redeemed" }, 409);
  if (rec.redeem_expires_at && Date.now() > Date.parse(rec.redeem_expires_at)) return json({ error: "CODE_EXPIRED" }, 409);

  const redeemedAt = new Date().toISOString();
  const updated = await markCodeRedeemed(db, {
    codeId: rec.id,
    redeemedAt,
    redeemedByUserRef: user ? user.id : null,
  });
  if (!updated) return json({ error: "already_redeemed" }, 409);

  await createCodeRedemption(db, {
    redemptionId: crypto.randomUUID(),
    codeId: rec.id,
    redeemedByUserRef: user ? user.id : null,
    redeemedContext: user ? "api_redeem" : "anonymous_redeem",
  });

  await appendAuditEvent(db, {
    eventType: "code.redeemed",
    entityType: "code",
    entityId: rec.id,
    actorUserRef: user ? user.id : null,
    actorRole: user ? highestRole(user.roles) : "anonymous",
    payload: { code_id: rec.id, redeemed_at: redeemedAt },
  });

  ctx.waitUntil(appendCodeBackup(env, db, "code_redeemed", { code: rec, redeemed_at: redeemedAt, actor: user }));
  return json({ code_id: rec.id, status: "redeemed", redeemed_at: redeemedAt });
}

async function handleIssueTestCode(request, env, ctx, db) {
  const body = await readJson(request);
  if (String(body.keyword || "").trim().toLowerCase() !== "keren") {
    return json({ error: "invalid_test_keyword" }, 403);
  }

  const codeId = crypto.randomUUID();
  const now = Date.now();
  const redeemExpiresAt = new Date(now + 24 * 60 * 60 * 1000).toISOString();
  const payload = {
    code_id: codeId,
    app_id: "sellmore",
    duration_code: "1_day",
    flow_type: "reseller_code",
    iat: now,
    exp: Date.parse(redeemExpiresAt),
    payment_ref: null,
    test_code: true,
  };
  const codeValue = await createReadableCodeValue(db, "1_day");

  await createCodeRecord(db, {
    codeId,
    codeValue,
    flow: "reseller_code",
    durationCode: "1_day",
    status: "issued",
    paymentRef: null,
    issuedByUserRef: null,
    redeemExpiresAt,
    redeemedAt: null,
    redeemedByUserRef: null,
    metadataJson: JSON.stringify(payload),
  });

  const response = {
    code_id: codeId,
    code_value: codeValue,
    status: "issued",
    redeem_expires_at: redeemExpiresAt,
    duration_code: "1_day",
  };

  await appendAuditEvent(db, {
    eventType: "code.test_issued",
    entityType: "code",
    entityId: codeId,
    actorUserRef: null,
    actorRole: "guest",
    payload: response,
  });

  ctx.waitUntil(appendCodeBackup(env, db, "code_test_issued", { code: response }));
  return json(response, 201);
}

async function handleUpdateConfig(request, db, user) {
  const body = await readJson(request);
  const currentConfig = await getAppConfig(db);
  let nextPricing;
  let nextPayments;
  try {
    nextPricing = validatePricingConfig(body.pricing || body.pricing_json);
    nextPayments = validatePaymentMethods(body.payment_methods || body.payment_methods_json);
  } catch (error) {
    return json({ error: error.message }, 400);
  }

  const googleOauthMode = body.google_oauth_mode || "google_oauth_only";
  const onboardingRule = body.onboarding_rule || "first_user_admin";
  if (googleOauthMode !== "google_oauth_only") return json({ error: "google_oauth_only_supported" }, 400);
  if (onboardingRule !== "first_user_admin") return json({ error: "first_user_admin_supported" }, 400);

  await db.prepare(`
    UPDATE app_config
    SET pricing_json = ?, payment_methods_json = ?, google_oauth_mode = ?, onboarding_rule = ?,
        sheet_backup_enabled = ?, sheet_script_url = ?, sheet_spreadsheet_prefix = ?,
        sheet_owner_user_id = ?, sheet_owner_email = ?, updated_by_user_ref = ?,
        updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    WHERE id = 'default'
  `).bind(
    JSON.stringify(nextPricing),
    JSON.stringify(nextPayments),
    googleOauthMode,
    onboardingRule,
    body.sheet_backup_enabled ? 1 : 0,
    body.sheet_script_url !== undefined ? body.sheet_script_url || null : currentConfig.sheet_script_url,
    body.sheet_spreadsheet_prefix || currentConfig.sheet_spreadsheet_prefix || "Subscription",
    body.sheet_owner_user_id !== undefined ? body.sheet_owner_user_id || null : currentConfig.sheet_owner_user_id,
    body.sheet_owner_email !== undefined ? body.sheet_owner_email || null : currentConfig.sheet_owner_email,
    user.id,
  ).run();

  await appendAuditEvent(db, {
    eventType: "config.updated",
    entityType: "app_config",
    entityId: "default",
    actorUserRef: user.id,
    actorRole: highestRole(user.roles),
    payload: { pricing: nextPricing, payment_methods: nextPayments },
  });

  return json({ ok: true, config: await getAppConfig(db) });
}

async function handleUpdateRoles(request, db, actor, userId) {
  const body = await readJson(request);
  const roles = Array.isArray(body.roles) ? Array.from(new Set(body.roles.filter((role) => role === "admin" || role === "reseller"))) : [];
  if (!roles.length) return json({ error: "roles_required" }, 400);

  await db.prepare(`
    UPDATE users
    SET roles_json = ?, updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    WHERE id = ?
  `).bind(JSON.stringify(roles), userId).run();

  const user = await getUserById(db, userId);
  if (!user) return json({ error: "user_not_found" }, 404);

  await appendAuditEvent(db, {
    eventType: "user.roles_updated",
    entityType: "user",
    entityId: userId,
    actorUserRef: actor.id,
    actorRole: highestRole(actor.roles),
    payload: { roles },
  });

  return json({ ok: true, user: sanitizeUser(user) });
}

async function handleCreateCodeBatch(request, db, user) {
  const body = await readJson(request);
  if (!Number.isInteger(body.quantity) || body.quantity < 1) return json({ error: "invalid_quantity" }, 400);
  if (!PURCHASE_DURATIONS.includes(body.duration_code)) return json({ error: "invalid_duration" }, 400);

  const batch = {
    id: crypto.randomUUID(),
    created_by_user_ref: user.id,
    quantity: body.quantity,
    duration_code: body.duration_code,
    expiry_policy: "fixed_12_months",
    notes: body.notes || null,
    metadata_json: JSON.stringify({ created_via: "admin_console" }),
  };

  await db.prepare(`
    INSERT INTO code_batches (id, created_by_user_ref, quantity, duration_code, expiry_policy, notes, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    batch.id,
    batch.created_by_user_ref,
    batch.quantity,
    batch.duration_code,
    batch.expiry_policy,
    batch.notes,
    batch.metadata_json,
  ).run();

  await appendAuditEvent(db, {
    eventType: "code_batch.created",
    entityType: "code_batch",
    entityId: batch.id,
    actorUserRef: user.id,
    actorRole: highestRole(user.roles),
    payload: batch,
  });

  return json(batch, 201);
}

async function requireAuth(request, db) {
  const header = request.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return { response: json({ error: "unauthorized" }, 401) };
  const row = await db.prepare(`
    SELECT s.id AS session_id, s.access_expires_at, u.id, u.email, u.display_name, u.picture_url, u.roles_json
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.access_token = ?
  `).bind(token).first();
  if (!row) return { response: json({ error: "unauthorized" }, 401) };
  if (Date.parse(row.access_expires_at) <= Date.now()) return { response: json({ error: "access_token_expired" }, 401) };
  return { user: mapUserRow(row), sessionId: row.session_id };
}

async function optionalAuth(request, db) {
  const header = request.headers.get("authorization") || "";
  if (!header.startsWith("Bearer ")) return { user: null };
  const auth = await requireAuth(request, db);
  return auth.response ? { user: null } : auth;
}

async function requireAdmin(request, db) {
  const auth = await requireAuth(request, db);
  if (auth.response) return auth;
  if (!isAdmin(auth.user)) return { response: json({ error: "forbidden" }, 403) };
  return auth;
}

function requireDb(env) {
  if (!env.DB) throw new Error("d1_not_configured");
  return env.DB;
}

async function enforceRateLimit(request, db, bucketName, maxRequests, windowSeconds) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const windowStartedAt = nowSeconds - (nowSeconds % windowSeconds);
  const bucketKey = `${bucketName}:${getRateLimitClientKey(request)}:${windowStartedAt}`;
  const expiresAt = new Date((windowStartedAt + windowSeconds) * 1000).toISOString();

  await db.prepare(`
    INSERT INTO rate_limits (bucket_key, window_started_at, request_count, expires_at)
    VALUES (?, ?, 1, ?)
    ON CONFLICT(bucket_key) DO UPDATE SET
      request_count = rate_limits.request_count + 1,
      expires_at = excluded.expires_at
  `).bind(bucketKey, windowStartedAt, expiresAt).run();

  const row = await db.prepare(`
    SELECT request_count
    FROM rate_limits
    WHERE bucket_key = ?
  `).bind(bucketKey).first();

  await maybeCleanupExpiredRateLimits(db, nowSeconds);

  const requestCount = Number(row?.request_count || 0);
  if (requestCount <= maxRequests) return null;

  const retryAfterSeconds = Math.max(1, windowStartedAt + windowSeconds - nowSeconds);
  return new Response(JSON.stringify({
    error: "rate_limited",
    retry_after_seconds: retryAfterSeconds,
  }), {
    status: 429,
    headers: {
      "content-type": "application/json",
      "retry-after": String(retryAfterSeconds),
    },
  });
}

function getRateLimitClientKey(request) {
  const cloudflareIp = String(request.headers.get("CF-Connecting-IP") || "").trim();
  if (cloudflareIp) return cloudflareIp;

  const forwardedFor = String(request.headers.get("x-forwarded-for") || "").split(",")[0].trim();
  return forwardedFor || "unknown";
}

async function maybeCleanupExpiredRateLimits(db, nowSeconds) {
  const sample = crypto.getRandomValues(new Uint8Array(1))[0];
  if ((sample & 63) !== 0) return;

  await db.prepare(`
    DELETE FROM rate_limits
    WHERE expires_at < ?
  `).bind(new Date(nowSeconds * 1000).toISOString()).run();
}

async function handleGoogleCallbackV2(request, env) {
  const body = await readJson(request);
  if (!body.id_token) return json({ error: "id_token_required" }, 400);

  const googleUser = await verifyGoogleIdentity(body.id_token, env);
  const user = await upsertGoogleUserV2(env, googleUser, request);
  if (user.status !== "active") return json({ error: "user_inactive" }, 403);
  const config = await getAppConfigV2(env);
  const session = await createSessionTokensV2(env, user);
  return json({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_in: ACCESS_TTL_SECONDS,
    user: sanitizeUser(user),
    auth_mode: config.google_oauth_mode,
    onboarding_rule: config.onboarding_rule,
  });
}

async function handleGoogleOauthCallbackV2(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  if (error) return oauthBounce(deriveReturnUrlFromState(state, request), { error });
  if (!code) return oauthBounce(deriveReturnUrlFromState(state, request), { error: "code_required" });

  try {
    const tokenData = await exchangeAuthorizationCode(request, env, code);
    const googleUser = await fetchGoogleUserProfile(tokenData.access_token);
    const user = await upsertGoogleUserV2(env, googleUser, request);
    if (user.status !== "active") return oauthBounce(deriveReturnUrlFromState(state, request), { error: "user_inactive" });
    const config = await getAppConfigV2(env);
    const session = await createSessionTokensV2(env, user);
    return oauthBounce(deriveReturnUrlFromState(state, request), {
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_in: ACCESS_TTL_SECONDS,
      auth_mode: config.google_oauth_mode,
      onboarding_rule: config.onboarding_rule,
      user: sanitizeUser(user),
    });
  } catch (exchangeError) {
    return oauthBounce(deriveReturnUrlFromState(state, request), { error: exchangeError.message });
  }
}

async function handleRefreshV2(request, env) {
  const body = await readJson(request);
  if (!body.refresh_token) return json({ error: "refresh_token_required" }, 400);
  let payload;
  try {
    payload = await verifySignedTokenV2(env, body.refresh_token, "refresh");
  } catch (error) {
    return json({ error: error.message }, 401);
  }
  const users = await loadUsersStore(env);
  const user = users[payload.email];
  if (!user || user.status !== "active") return json({ error: "user_inactive" }, 401);
  const session = await createSessionTokensV2(env, user);
  return json({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_in: ACCESS_TTL_SECONDS,
    user: sanitizeUser(user),
  });
}

async function handlePricingQuoteV2(request, env) {
  const body = await readJson(request);
  const duration = body.duration_code;
  if (!PURCHASE_DURATIONS.includes(duration)) return json({ error: "invalid_duration" }, 400);
  const auth = await optionalAuthV2(request, env);
  const audience = auth.user && auth.user.role === "reseller" ? "reseller" : "app";
  const config = await getAppConfigV2(env);
  const country = detectRequestCountry(request);
  const quote = resolveQuoteV2(config.active, country, duration, audience);
  return json({
    country_code: country === "fallback" ? null : country,
    used_fallback: !config.active.pricing[country],
    duration_code: duration,
    currency: quote.currency,
    amount_minor: quote.amount_minor,
    audience,
    adjustment: quote.adjustment,
  });
}

async function handleClientSubscriptionQuoteV2(request, env) {
  const config = await getAppConfigV2(env);
  const country = detectRequestCountry(request);
  const quote = resolveQuoteV2(config.active, country, "12_months", "app");
  return json({
    country_code: country === "fallback" ? null : country,
    used_fallback: !config.active.pricing[country],
    duration_code: "12_months",
    currency: quote.currency,
    amount_minor: quote.amount_minor,
    audience: "app",
    adjustment: quote.adjustment,
    client_flow: "direct_subscribe",
  });
}

async function handleDirectSubscribeV2(request, env, db) {
  const body = await readJson(request);
  return handleIssueCodeV2(new Request(request.url, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify({
      duration_code: "12_months",
      source: "direct",
      external_payment_id: body.external_payment_id,
      payment_method: body.payment_method,
      currency: body.currency,
      amount_minor: body.amount_minor,
    }),
  }), env, db, null);
}

async function handleIssueCodeV2(request, env, db, user) {
  const body = await readJson(request);
  const durationCode = String(body.duration_code || "");
  const source = String(body.source || (user && user.role === "reseller" ? "reseller" : "direct"));
  const externalPaymentId = String(body.external_payment_id || "").trim();
  if (!PURCHASE_DURATIONS.includes(durationCode)) return json({ error: "invalid_duration" }, 400);
  if (!["direct", "reseller", "gift_card"].includes(source)) return json({ error: "invalid_source" }, 400);
  if (!externalPaymentId) return json({ error: "external_payment_id_required" }, 400);
  if (source === "gift_card") return json({ error: "gift_card_issue_requires_batch" }, 409);

  const existing = await db.prepare(`
    SELECT id, code_value, flow_type, duration_code, status, payment_ref, redeem_expires_at, redeemed_at, created_at
    FROM codes WHERE payment_ref = ?
  `).bind(externalPaymentId).first();
  if (existing) {
    return json(source === "direct" ? await serializeDirectSubscriptionV2(existing, env) : serializeCodeRowV2(existing));
  }

  const codeId = crypto.randomUUID();
  const codeValue = await createReadableCodeValue(db, durationCode);
  const now = new Date();
  const redeemedAt = source === "direct" ? now.toISOString() : null;
  const redeemExpiresAt = source === "reseller" ? new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString() : null;
  const flow = source === "direct" ? "direct_subscribe" : "reseller_code";
  const status = source === "direct" ? "redeemed" : "issued";
  await createCodeRecord(db, {
    codeId,
    codeValue,
    flow,
    durationCode,
    status,
    paymentRef: externalPaymentId,
    issuedByUserRef: user ? user.id : null,
    redeemExpiresAt,
    redeemedAt,
    redeemedByUserRef: source === "direct" ? "app_client" : null,
    metadataJson: JSON.stringify({ source }),
  });
  if (source === "direct") {
    await createCodeRedemption(db, {
      redemptionId: crypto.randomUUID(),
      codeId,
      redeemedByUserRef: "app_client",
      redeemedContext: "direct_subscribe_auto_redeem",
    });
  }
  await enqueueRegularRowV2(env, {
    event_type: source === "direct" ? "direct_subscribe" : "reseller_code_issued",
    source,
    code_value: codeValue,
    duration_code: durationCode,
    external_payment_id: externalPaymentId,
    payment_method: body.payment_method || null,
    currency: body.currency || null,
    amount_minor: body.amount_minor ?? null,
    payment_country: detectRequestCountry(request),
    actor_email: user ? user.email : null,
    status,
    generated_at: now.toISOString(),
    redeemed_at: redeemedAt,
  });
  const row = { id: codeId, code_value: codeValue, flow_type: flow, duration_code: durationCode, status, payment_ref: externalPaymentId, redeem_expires_at: redeemExpiresAt, redeemed_at: redeemedAt, created_at: now.toISOString() };
  return json(source === "direct" ? await serializeDirectSubscriptionV2(row, env) : serializeCodeRowV2(row), 201);
}

async function handleRedeemCodeV2(request, env, db, user = null) {
  const body = await readJson(request);
  const codeValue = normalizeCodeValue(body.code_value);
  if (!isReadableCodeFormat(codeValue)) return json({ error: "invalid_code_format" }, 409);
  const rec = await db.prepare(`SELECT id, code_value, flow_type, duration_code, status, payment_ref, redeem_expires_at, redeemed_at, created_at FROM codes WHERE code_value = ?`).bind(codeValue).first();
  if (!rec) return json({ error: "code_not_found" }, 404);
  if (rec.status === "redeemed") return json({ error: "already_redeemed" }, 409);
  if (rec.redeem_expires_at && Date.now() > Date.parse(rec.redeem_expires_at)) return json({ error: "expired_code" }, 409);
  const redeemedAt = new Date().toISOString();
  const updated = await markCodeRedeemed(db, { codeId: rec.id, redeemedAt, redeemedByUserRef: user ? user.id : "app_client" });
  if (!updated) return json({ error: "already_redeemed" }, 409);
  await createCodeRedemption(db, {
    redemptionId: crypto.randomUUID(),
    codeId: rec.id,
    redeemedByUserRef: user ? user.id : "app_client",
    redeemedContext: user ? "api_redeem" : "client_code_redeem",
  });
  await enqueueRegularRowV2(env, {
    event_type: "code_redeemed",
    source: mapSourceFromFlowTypeV2(rec.flow_type),
    code_value: rec.code_value,
    duration_code: rec.duration_code,
    external_payment_id: rec.payment_ref,
    payment_country: detectRequestCountry(request),
    actor_email: user ? user.email : null,
    status: "redeemed",
    generated_at: rec.created_at,
    redeemed_at: redeemedAt,
  });
  return json({
    ok: true,
    code_value: rec.code_value,
    duration_code: rec.duration_code,
    redeemed_at: redeemedAt,
    subscription_token: await issueSubscriptionTokenV2(env, rec.duration_code, redeemedAt),
  });
}

async function handleUpdateConfigV2(request, env, actor) {
  const current = await getAppConfigV2(env);
  const body = await readJson(request);
  const next = validateCombinedConfigV2({
    google_oauth_mode: current.google_oauth_mode,
    onboarding_rule: current.onboarding_rule,
    sheet_backup_enabled: body.sheet_backup_enabled !== undefined ? body.sheet_backup_enabled : current.sheet_backup_enabled,
    sheet_script_url: body.sheet_script_url !== undefined ? body.sheet_script_url : current.sheet_script_url,
    sheet_owner_email: body.sheet_owner_email !== undefined ? body.sheet_owner_email : current.sheet_owner_email,
    active: body.active || current.active,
    upcoming: body.upcoming !== undefined ? body.upcoming : current.upcoming,
    backup: { ...current.backup, ...(body.backup || {}) },
  });
  await putStoreJson(env, STORE_CONFIG_KEY, next);
  return json({ ok: true, config: next, updated_by: actor.email });
}

async function handleUpdateUserV2(request, env, actor, userId) {
  const body = await readJson(request);
  if (userId === actor.email) return json({ error: "self_modification_forbidden" }, 409);
  const users = await loadUsersStore(env);
  const user = users[userId];
  if (!user) return json({ error: "user_not_found" }, 404);
  const role = body.role !== undefined ? String(body.role) : user.role;
  const status = body.status !== undefined ? String(body.status) : user.status;
  if (!USER_ROLES.includes(role)) return json({ error: "invalid_role" }, 400);
  if (!USER_STATUSES.includes(status)) return json({ error: "invalid_status" }, 400);
  users[userId] = { ...user, role, status, updated_at: new Date().toISOString() };
  await putStoreJson(env, STORE_USERS_KEY, users);
  return json({ ok: true, user: sanitizeUser(users[userId]) });
}

async function handleCreateCodeBatchV2(request, env, db, user) {
  const body = await readJson(request);
  if (!Number.isInteger(body.quantity) || body.quantity < 1) return json({ error: "invalid_quantity" }, 400);
  if (!PURCHASE_DURATIONS.includes(body.duration_code)) return json({ error: "invalid_duration" }, 400);
  const batch = {
    id: crypto.randomUUID(),
    created_by_user_ref: user.id,
    quantity: body.quantity,
    duration_code: body.duration_code,
    expiry_policy: "fixed_12_months",
    notes: body.notes || null,
    metadata_json: JSON.stringify({ created_via: "admin_console", source: "gift_card_batch" }),
  };
  await db.prepare(`
    INSERT INTO code_batches (id, created_by_user_ref, quantity, duration_code, expiry_policy, notes, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(batch.id, batch.created_by_user_ref, batch.quantity, batch.duration_code, batch.expiry_policy, batch.notes, batch.metadata_json).run();
  const codes = [];
  for (let index = 0; index < batch.quantity; index += 1) {
    const codeId = crypto.randomUUID();
    const codeValue = await createReadableCodeValue(db, batch.duration_code);
    await createCodeRecord(db, {
      codeId,
      codeValue,
      flow: "bulk_printed_card",
      durationCode: batch.duration_code,
      status: "issued",
      paymentRef: `gift-batch:${batch.id}`,
      issuedByUserRef: user.id,
      redeemExpiresAt: null,
      redeemedAt: null,
      redeemedByUserRef: null,
      metadataJson: JSON.stringify({ source: "gift_card", batch_id: batch.id }),
    });
    await db.prepare(`INSERT INTO code_batch_items (batch_id, code_id) VALUES (?, ?)`).bind(batch.id, codeId).run();
    codes.push(codeValue);
  }
  await enqueueBulkRowV2(env, {
    event_type: "gift_card_batch_issued",
    batch_id: batch.id,
    note: batch.notes,
    quantity: batch.quantity,
    duration_code: batch.duration_code,
    actor_email: user.email,
    generated_at: new Date().toISOString(),
    codes,
  });
  return json({ ok: true, batch_id: batch.id, quantity: batch.quantity, duration_code: batch.duration_code, codes }, 201);
}

async function handleManualBackupV2(env) {
  const config = await getAppConfigV2(env);
  if (!config.sheet_backup_enabled) return json({ error: "sheet_backup_disabled" }, 409);
  if (!config.sheet_script_url) return json({ error: "sheet_script_url_required" }, 409);

  const queue = await getStoreJson(env, STORE_QUEUE_KEY, { regular: [], bulk: [] });
  if (!(queue.regular?.length || queue.bulk?.length)) return json({ ok: true, sent: false, detail: "queue_empty" });

  const result = await flushQueueToSheetsV2(env, config, queue);
  if (result.sent_regular.length || result.sent_bulk.length) {
    const sentAt = result.sent_at;
    await putStoreJson(env, STORE_LAST_BATCH_KEY, {
      sent_at: sentAt,
      regular: result.sent_regular,
      bulk: result.sent_bulk,
    });
    config.backup.last_backup_at = sentAt;
    config.backup.last_sent_batch_at = sentAt;
    await putStoreJson(env, STORE_CONFIG_KEY, config);
  }

  await putStoreJson(env, STORE_QUEUE_KEY, {
    regular: result.remaining_regular,
    bulk: result.remaining_bulk,
  });

  if (result.errors.length && !(result.sent_regular.length || result.sent_bulk.length)) {
    return json({
      ok: false,
      sent: false,
      errors: result.errors,
      regular_rows: 0,
      bulk_rows: 0,
    }, 502);
  }

  return json({
    ok: result.errors.length === 0,
    sent: result.sent_regular.length > 0 || result.sent_bulk.length > 0,
    partial: result.errors.length > 0,
    last_backup_at: result.sent_at,
    regular_rows: result.sent_regular.length,
    bulk_rows: result.sent_bulk.length,
    remaining_regular_rows: result.remaining_regular.length,
    remaining_bulk_rows: result.remaining_bulk.length,
    errors: result.errors,
  });
}

async function runScheduledBackupV2(env) {
  const config = await getAppConfigV2(env);
  if (!config.sheet_backup_enabled || !config.sheet_script_url) return;
  const queue = await getStoreJson(env, STORE_QUEUE_KEY, { regular: [], bulk: [] });
  if (!(queue.regular?.length || queue.bulk?.length)) return;

  const result = await flushQueueToSheetsV2(env, config, queue);
  if (!(result.sent_regular.length || result.sent_bulk.length)) return;

  await putStoreJson(env, STORE_LAST_BATCH_KEY, {
    sent_at: result.sent_at,
    regular: result.sent_regular,
    bulk: result.sent_bulk,
  });
  await putStoreJson(env, STORE_QUEUE_KEY, {
    regular: result.remaining_regular,
    bulk: result.remaining_bulk,
  });

  config.backup.last_backup_at = result.sent_at;
  config.backup.last_sent_batch_at = result.sent_at;
  await putStoreJson(env, STORE_CONFIG_KEY, config);
}

async function requireAuthV2(request, env) {
  const token = getBearerTokenV2(request);
  if (!token) return { response: json({ error: "unauthorized" }, 401) };
  let payload;
  try {
    payload = await verifySignedTokenV2(env, token, "access");
  } catch (error) {
    return { response: json({ error: error.message }, 401) };
  }
  const users = await loadUsersStore(env);
  const user = users[payload.email];
  if (!user || user.status !== "active") return { response: json({ error: "user_inactive" }, 401) };
  return { user: mapStoredUserV2(user) };
}

async function optionalAuthV2(request, env) {
  const token = getBearerTokenV2(request);
  if (!token) return { user: null };
  const auth = await requireAuthV2(request, env);
  return auth.response ? { user: null } : auth;
}

async function requireAdminV2(request, env) {
  const auth = await requireAuthV2(request, env);
  if (auth.response) return auth;
  if (!auth.user.roles.includes("admin")) return { response: json({ error: "forbidden" }, 403) };
  return auth;
}

async function listUsersV2(env) {
  const users = await loadUsersStore(env);
  return Object.values(users).sort((a, b) => a.email.localeCompare(b.email)).map((user) => sanitizeUser(mapStoredUserV2(user)));
}

async function buildAdminSummaryV2(env, db) {
  const queue = await getStoreJson(env, STORE_QUEUE_KEY, { regular: [], bulk: [] });
  const users = await loadUsersStore(env);
  const countRow = await db.prepare(`SELECT COUNT(*) AS count FROM codes`).first();
  const lastBatch = await getStoreJson(env, STORE_LAST_BATCH_KEY, { regular: [], bulk: [] });
  return {
    cards: {
      subscriptions_sold: Number(countRow?.count || 0),
      revenue_total: summarizeTopCurrencyV2(lastBatch.regular || []),
      pending_backup_today: (queue.regular || []).length + (queue.bulk || []).length,
      active_resellers: Object.values(users).filter((user) => user.role === "reseller" && user.status === "active").length,
    },
  };
}

async function listCodesV2(db) {
  const rows = await db.prepare(`
    SELECT id, code_value, flow_type, duration_code, status, payment_ref, redeem_expires_at, redeemed_at, created_at
    FROM codes ORDER BY created_at DESC LIMIT 200
  `).all();
  return (rows.results || []).map((row) => serializeCodeRowV2(row));
}

async function getAppConfigV2(env) {
  const config = validateCombinedConfigV2(await getStoreJson(env, STORE_CONFIG_KEY, defaultConfigV2()));
  if (config.upcoming && Date.parse(config.upcoming.effective_at) <= Date.now()) {
    const next = { ...config, active: config.upcoming.config, upcoming: null };
    await putStoreJson(env, STORE_CONFIG_KEY, next);
    return next;
  }
  return config;
}

async function loadUsersStore(env) {
  return await getStoreJson(env, STORE_USERS_KEY, {});
}

async function upsertGoogleUserV2(env, googleUser, request) {
  const users = await loadUsersStore(env);
  const email = String(googleUser.email || "").toLowerCase();
  const now = new Date().toISOString();
  const country = detectRequestCountry(request);
  if (users[email]) {
    users[email] = { ...users[email], name: googleUser.name || users[email].name || email, country, updated_at: now };
  } else {
    users[email] = { name: googleUser.name || email, email, country, role: Object.keys(users).length === 0 ? "admin" : "reseller", status: "active", created_at: now, updated_at: now };
  }
  await putStoreJson(env, STORE_USERS_KEY, users);
  return mapStoredUserV2(users[email]);
}

async function createSessionTokensV2(env, user) {
  return {
    access_token: await signTokenV2(env, { typ: "access", email: user.email, role: user.role || highestRole(user.roles), exp: Math.floor(Date.now() / 1000) + ACCESS_TTL_SECONDS }),
    refresh_token: await signTokenV2(env, { typ: "refresh", email: user.email, role: user.role || highestRole(user.roles), exp: Math.floor(Date.now() / 1000) + REFRESH_TTL_SECONDS }),
  };
}

async function issueSubscriptionTokenV2(env, durationCode, redeemedAt) {
  const expiry = computeExpiryV2(durationCode, redeemedAt);
  return signTokenV2(env, { typ: "subscription", ver: "v1", exp: Math.floor(Date.parse(expiry) / 1000) });
}

async function signTokenV2(env, payload) {
  const serialized = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await signValueV2(env, serialized);
  return `${serialized}.${signature}`;
}

async function verifySignedTokenV2(env, token, expectedType) {
  const parts = String(token || "").split(".");
  if (parts.length !== 2) throw new Error("invalid_token");
  const [serialized, signature] = parts;
  const expectedSignature = await signValueV2(env, serialized);
  if (signature !== expectedSignature) throw new Error("invalid_token");
  const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(serialized)));
  if (payload.typ !== expectedType) throw new Error("invalid_token_type");
  if (Number(payload.exp || 0) <= Math.floor(Date.now() / 1000)) throw new Error(`${expectedType}_token_expired`);
  return payload;
}

async function signValueV2(env, value) {
  const secret = env.TOKEN_SECRET || env.GOOGLE_CLIENT_SECRET || "dev-only-token-secret";
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return b64url(new Uint8Array(sig));
}

function getBearerTokenV2(request) {
  const header = String(request.headers.get("authorization") || "");
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

async function getStoreJson(env, key, fallback) {
  if (!env.APP_STORE) return fallback;
  const raw = await env.APP_STORE.get(key);
  return raw ? JSON.parse(raw) : fallback;
}

async function putStoreJson(env, key, value) {
  if (!env.APP_STORE) throw new Error("app_store_not_configured");
  await env.APP_STORE.put(key, JSON.stringify(value));
}

function defaultConfigV2() {
  return {
    google_oauth_mode: "google_oauth_only",
    onboarding_rule: "first_user_admin",
    sheet_backup_enabled: false,
    sheet_script_url: null,
    sheet_owner_email: null,
    active: {
      payment_methods: DEFAULT_PAYMENT_METHODS,
      pricing: {
        ID: { "6_months": { currency: "IDR", amount_minor: 699000 }, "12_months": { currency: "IDR", amount_minor: 999000 } },
        MY: { "6_months": { currency: "MYR", amount_minor: 199 }, "12_months": { currency: "MYR", amount_minor: 299 } },
        SG: { "6_months": { currency: "SGD", amount_minor: 69 }, "12_months": { currency: "SGD", amount_minor: 99 } },
        TH: { "6_months": { currency: "THB", amount_minor: 1499 }, "12_months": { currency: "THB", amount_minor: 1999 } },
        fallback: { "6_months": { currency: "USD", amount_minor: 6900 }, "12_months": { currency: "USD", amount_minor: 9900 } },
      },
      reseller_discounts: {},
      promotions: [],
    },
    upcoming: null,
    backup: { timezone: "UTC+7", daily_run_time: "03:00", last_backup_at: null, sheet_prefix: "Subscription", last_sent_batch_at: null },
  };
}

function validateCombinedConfigV2(input) {
  return {
    google_oauth_mode: "google_oauth_only",
    onboarding_rule: "first_user_admin",
    sheet_backup_enabled: Boolean(input.sheet_backup_enabled),
    sheet_script_url: input.sheet_script_url ? String(input.sheet_script_url) : null,
    sheet_owner_email: input.sheet_owner_email ? String(input.sheet_owner_email).toLowerCase() : null,
    active: validateConfigPayloadV2(input.active || {}),
    upcoming: input.upcoming ? { effective_at: new Date(input.upcoming.effective_at).toISOString(), config: validateConfigPayloadV2(input.upcoming.config || {}) } : null,
    backup: {
      timezone: String(input.backup?.timezone || "UTC+7"),
      daily_run_time: String(input.backup?.daily_run_time || "03:00"),
      last_backup_at: input.backup?.last_backup_at || null,
      sheet_prefix: String(input.backup?.sheet_prefix || "Subscription"),
      last_sent_batch_at: input.backup?.last_sent_batch_at || null,
    },
  };
}

function validateConfigPayloadV2(input) {
  const pricing = validatePricingConfig(input.pricing || defaultConfigV2().active.pricing);
  const payment_methods = validatePaymentMethods(input.payment_methods || DEFAULT_PAYMENT_METHODS);
  return {
    pricing,
    payment_methods,
    reseller_discounts: input.reseller_discounts || {},
    promotions: Array.isArray(input.promotions) ? input.promotions : [],
  };
}

function resolveQuoteV2(activeConfig, countryCode, duration, audience) {
  const selectedCountry = activeConfig.pricing[countryCode] ? countryCode : "fallback";
  const base = activeConfig.pricing[selectedCountry][duration];
  const candidates = [];
  if (audience === "reseller" && activeConfig.reseller_discounts?.[selectedCountry]) {
    const discount = activeConfig.reseller_discounts[selectedCountry];
    candidates.push({ amount_minor: applyAdjustmentV2(base.amount_minor, discount), adjustment: { kind: "reseller_discount", ...discount } });
  }
  for (const promotion of activeConfig.promotions || []) {
    if (!promotion.targets?.includes(audience)) continue;
    if (!promotion.countries?.includes(selectedCountry)) continue;
    if (promotion.starts_at && Date.now() < Date.parse(promotion.starts_at)) continue;
    if (promotion.ends_at && Date.now() > Date.parse(promotion.ends_at)) continue;
    candidates.push({ amount_minor: applyAdjustmentV2(base.amount_minor, promotion), adjustment: { kind: "promotion", id: promotion.id, type: promotion.type } });
  }
  let selected = { amount_minor: base.amount_minor, adjustment: null };
  for (const candidate of candidates) if (candidate.amount_minor < selected.amount_minor) selected = candidate;
  return { currency: base.currency, amount_minor: selected.amount_minor, adjustment: selected.adjustment };
}

function applyAdjustmentV2(baseAmountMinor, adjustment) {
  if (adjustment.type === "fixed") return Math.max(0, baseAmountMinor - Number(adjustment.value_minor || 0));
  return Math.max(0, Math.round(baseAmountMinor * (100 - Number(adjustment.value || 0)) / 100));
}

function detectRequestCountry(request) {
  const raw = String(request.headers.get("CF-IPCountry") || request.headers.get("x-vercel-ip-country") || request.headers.get("x-country-code") || "").trim().toUpperCase();
  if (!raw || raw === "XX" || raw === "T1") return "fallback";
  return /^[A-Z]{2}$/.test(raw) ? raw : "fallback";
}

function mapStoredUserV2(user) {
  return {
    id: user.email,
    email: user.email,
    display_name: user.name,
    picture_url: null,
    country: user.country,
    role: user.role,
    roles: [user.role],
    status: user.status,
  };
}

async function enqueueRegularRowV2(env, row) {
  const queue = await getStoreJson(env, STORE_QUEUE_KEY, { regular: [], bulk: [] });
  queue.regular.push({ id: crypto.randomUUID(), queued_at: new Date().toISOString(), ...row });
  await putStoreJson(env, STORE_QUEUE_KEY, queue);
}

async function enqueueBulkRowV2(env, row) {
  const queue = await getStoreJson(env, STORE_QUEUE_KEY, { regular: [], bulk: [] });
  queue.bulk.push({ id: crypto.randomUUID(), queued_at: new Date().toISOString(), ...row });
  await putStoreJson(env, STORE_QUEUE_KEY, queue);
}

async function flushQueueToSheetsV2(env, config, queue) {
  const sentAt = new Date().toISOString();
  const sentRegular = [];
  const sentBulk = [];
  const remainingRegular = [...(queue.regular || [])];
  const remainingBulk = [...(queue.bulk || [])];
  const errors = [];

  if (remainingRegular.length) {
    try {
      await postRowsToSheetScriptV2(config.sheet_script_url, {
        mode: "regular",
        spreadsheet_title: buildSheetSpreadsheetTitleV2(config, false, sentAt),
        sheet_title: buildSheetMonthTitleV2(sentAt, config.backup?.timezone || "UTC+7"),
        owner_email: config.sheet_owner_email || null,
        rows: remainingRegular.map(mapRegularSheetRowV2),
      });
      sentRegular.push(...remainingRegular);
      remainingRegular.length = 0;
    } catch (error) {
      errors.push({ bucket: "regular", detail: error.message });
    }
  }

  if (remainingBulk.length) {
    try {
      await postRowsToSheetScriptV2(config.sheet_script_url, {
        mode: "bulk_gift_card",
        spreadsheet_title: buildSheetSpreadsheetTitleV2(config, true, sentAt),
        sheet_title: buildSheetMonthTitleV2(sentAt, config.backup?.timezone || "UTC+7"),
        owner_email: config.sheet_owner_email || null,
        rows: remainingBulk.flatMap(expandBulkSheetRowsV2),
      });
      sentBulk.push(...remainingBulk);
      remainingBulk.length = 0;
    } catch (error) {
      errors.push({ bucket: "bulk", detail: error.message });
    }
  }

  return {
    sent_at: sentAt,
    sent_regular: sentRegular,
    sent_bulk: sentBulk,
    remaining_regular: remainingRegular,
    remaining_bulk: remainingBulk,
    errors,
  };
}

async function postRowsToSheetScriptV2(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`sheet_script_http_${response.status}${body ? `:${body.slice(0, 200)}` : ""}`);
  }
  const data = await response.json().catch(() => ({}));
  if (data && data.ok === false) {
    throw new Error(data.error || "sheet_script_rejected");
  }
  return data;
}

function buildSheetSpreadsheetTitleV2(config, isBulk, isoDate) {
  const year = getBackupDatePartsV2(isoDate, config.backup?.timezone || "UTC+7").year;
  const prefix = config.sheet_spreadsheet_prefix || config.backup?.sheet_prefix || "Subscription";
  return isBulk ? `${prefix} Gift Card Issuance ${year}` : `${prefix} ${year}`;
}

function buildSheetMonthTitleV2(isoDate, timezoneLabel) {
  return getBackupDatePartsV2(isoDate, timezoneLabel).month;
}

function getBackupDatePartsV2(isoDate, timezoneLabel) {
  const date = new Date(isoDate);
  const offsetMinutes = parseTimezoneOffsetMinutesV2(timezoneLabel);
  const shifted = new Date(date.getTime() + offsetMinutes * 60 * 1000);
  return {
    year: shifted.getUTCFullYear(),
    month: String(shifted.getUTCMonth() + 1).padStart(2, "0"),
  };
}

function parseTimezoneOffsetMinutesV2(timezoneLabel) {
  const match = String(timezoneLabel || "UTC+7").match(/^UTC([+-])(\d{1,2})(?::?(\d{2}))?$/i);
  if (!match) return 7 * 60;
  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number(match[2] || 0);
  const minutes = Number(match[3] || 0);
  return sign * (hours * 60 + minutes);
}

function mapRegularSheetRowV2(row) {
  return {
    id: row.id,
    queued_at: row.queued_at,
    event_type: row.event_type || "",
    code_source: row.source || "",
    code_value: row.code_value || "",
    duration_code: row.duration_code || "",
    status: row.status || "",
    external_payment_id: row.external_payment_id || "",
    country: row.payment_country || "",
    currency: row.currency || "",
    amount: row.amount_minor != null ? row.amount_minor : "",
    actor_email: row.actor_email || "",
    customer_ref: row.customer_ref || "",
    generated_at: row.generated_at || "",
    redeemed_at: row.redeemed_at || "",
    note: row.note || "",
  };
}

function expandBulkSheetRowsV2(row) {
  const codes = Array.isArray(row.codes) && row.codes.length ? row.codes : [""];
  return codes.map((codeValue) => ({
    id: row.id,
    queued_at: row.queued_at,
    batch_id: row.batch_id || "",
    batch_note: row.note || "",
    duration_code: row.duration_code || "",
    quantity: row.quantity != null ? row.quantity : "",
    code_value: codeValue,
    issued_by_email: row.actor_email || "",
    generated_at: row.generated_at || "",
  }));
}

function serializeCodeRowV2(row) {
  return {
    id: row.id,
    code_value: row.code_value,
    source: mapSourceFromFlowTypeV2(row.flow_type),
    duration_code: row.duration_code,
    status: row.status,
    external_payment_id: row.payment_ref,
    redeem_expires_at: row.redeem_expires_at || null,
    redeemed_at: row.redeemed_at || null,
    created_at: row.created_at || null,
  };
}

async function serializeDirectSubscriptionV2(row, env) {
  const redeemedAt = row.redeemed_at || new Date().toISOString();
  const subscribedUntil = computeExpiryV2(row.duration_code, redeemedAt);
  return {
    ok: true,
    subscription_token: await issueSubscriptionTokenV2(env, row.duration_code, redeemedAt),
    subscribed_until: subscribedUntil,
    code_value: row.code_value,
    duration_code: row.duration_code,
    redeemed_at: redeemedAt,
  };
}

function mapSourceFromFlowTypeV2(flowType) {
  if (flowType === "direct_subscribe") return "direct";
  if (flowType === "bulk_printed_card") return "gift_card";
  return "reseller";
}

function summarizeTopCurrencyV2(rows) {
  const totals = {};
  for (const row of rows) {
    if (!row.currency) continue;
    if (!totals[row.currency]) totals[row.currency] = { count: 0, amount_minor: 0 };
    totals[row.currency].count += 1;
    totals[row.currency].amount_minor += Number(row.amount_minor || 0);
  }
  let best = null;
  let bestCurrency = null;
  for (const [currency, value] of Object.entries(totals)) {
    if (!best || value.count > best.count) {
      best = value;
      bestCurrency = currency;
    }
  }
  return best ? `${bestCurrency} ${best.amount_minor}` : "-";
}

function computeExpiryV2(durationCode, fromIso) {
  const date = new Date(fromIso);
  date.setUTCMonth(date.getUTCMonth() + (durationCode === "6_months" ? 6 : 12));
  return date.toISOString();
}

async function getAppConfig(db) {
  const row = await db.prepare(`SELECT * FROM app_config WHERE id = 'default'`).first();
  if (!row) throw new Error("app_config_missing");
  return {
    pricing: JSON.parse(row.pricing_json),
    payment_methods: JSON.parse(row.payment_methods_json),
    google_oauth_mode: row.google_oauth_mode,
    onboarding_rule: row.onboarding_rule,
    sheet_backup_enabled: Boolean(row.sheet_backup_enabled),
    sheet_script_url: row.sheet_script_url,
    sheet_spreadsheet_prefix: row.sheet_spreadsheet_prefix,
    sheet_owner_user_id: row.sheet_owner_user_id,
    sheet_owner_email: row.sheet_owner_email,
    updated_by_user_ref: row.updated_by_user_ref,
    updated_at: row.updated_at,
  };
}

function resolveQuote(pricing, countryCode, duration) {
  const market = pricing[countryCode] || pricing.fallback;
  const quote = market[duration] || pricing.fallback[duration];
  return { currency: quote.currency, amount_minor: Number(quote.amount_minor) };
}

function validatePricingConfig(input) {
  const pricing = typeof input === "string" ? JSON.parse(input) : input;
  if (!pricing || typeof pricing !== "object" || !pricing.fallback) throw new Error("invalid_pricing_config");
  for (const market of Object.keys(pricing)) {
    if (market !== "fallback" && !/^[A-Z]{2}$/.test(market)) throw new Error("invalid_market_code_" + market);
    for (const duration of PURCHASE_DURATIONS) {
      const item = pricing[market] && pricing[market][duration];
      if (!item) throw new Error("missing_pricing_" + market + "_" + duration);
      if (!/^[A-Z]{3}$/.test(String(item.currency || ""))) throw new Error("invalid_currency_" + market + "_" + duration);
      if (!Number.isFinite(Number(item.amount_minor)) || Number(item.amount_minor) < 0) throw new Error("invalid_amount_" + market + "_" + duration);
    }
  }
  return pricing;
}

function validatePaymentMethods(input) {
  const methods = typeof input === "string" ? JSON.parse(input) : input;
  const next = {};
  for (const method of PAYMENT_METHODS) {
    const current = methods && methods[method] ? methods[method] : DEFAULT_PAYMENT_METHODS[method];
    next[method] = {
      enabled: Boolean(current.enabled),
      provider: String(current.provider || DEFAULT_PAYMENT_METHODS[method].provider),
    };
  }
  return next;
}

function normalizeChannel(channel, user) {
  if (channel === "api" || channel === "reseller" || channel === "admin") return channel;
  if (!user) return "reseller";
  if (isAdmin(user)) return "admin";
  if (user.roles.includes("reseller")) return "reseller";
  return "api";
}

async function verifyGoogleIdentity(idToken, env) {
  if (env.ALLOW_DEV_AUTH === "true" && idToken.startsWith("dev:")) {
    const email = idToken.slice(4).trim().toLowerCase();
    return {
      sub: "dev-" + email,
      email,
      name: email.split("@")[0],
      picture: null,
    };
  }

  const response = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(idToken));
  if (!response.ok) throw new Error("google_token_verification_failed");
  const data = await response.json();
  if (!data.sub || !data.email) throw new Error("google_identity_incomplete");
  if (env.GOOGLE_CLIENT_ID && data.aud !== env.GOOGLE_CLIENT_ID) throw new Error("google_audience_mismatch");
  return {
    sub: data.sub,
    email: String(data.email).toLowerCase(),
    name: data.name || data.email,
    picture: data.picture || null,
  };
}

async function exchangeAuthorizationCode(request, env, code) {
  if (!env.GOOGLE_CLIENT_ID) throw new Error("missing_GOOGLE_CLIENT_ID");
  if (!env.GOOGLE_CLIENT_SECRET) throw new Error("missing_GOOGLE_CLIENT_SECRET");

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: deriveGoogleRedirectUri(request),
      grant_type: "authorization_code",
    }),
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "google_code_exchange_failed");
  if (!data.access_token) throw new Error("google_access_token_missing");
  return data;
}

async function fetchGoogleUserProfile(accessToken) {
  const response = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { authorization: "Bearer " + accessToken },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "google_userinfo_failed");
  if (!data.sub || !data.email) throw new Error("google_userinfo_incomplete");
  return {
    sub: data.sub,
    email: String(data.email).toLowerCase(),
    name: data.name || data.email,
    picture: data.picture || null,
  };
}

function deriveGoogleRedirectUri(request) {
  const url = new URL(request.url);
  return `${url.origin}/v1/auth/google/callback`;
}

function deriveDefaultAppUrl(request) {
  const url = new URL(request.url);
  return `${url.origin}/frontend/admin/`;
}

function deriveReturnUrlFromState(state, request) {
  if (!state) return deriveDefaultAppUrl(request);
  try {
    const decoded = JSON.parse(new TextDecoder().decode(b64urlDecode(state)));
    return decoded.redirect_url || deriveDefaultAppUrl(request);
  } catch (error) {
    return deriveDefaultAppUrl(request);
  }
}

function oauthBounce(returnUrl, payload) {
  const safeReturnUrl = returnUrl || "/";
  const fragment = new URLSearchParams();
  for (const [key, value] of Object.entries(payload)) {
    fragment.set(key, typeof value === "string" ? value : JSON.stringify(value));
  }
  const location = safeReturnUrl + (safeReturnUrl.includes("#") ? "&" : "#") + fragment.toString();
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${escapeHtmlAttr(location)}"></head><body>Redirecting...</body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

async function createUser(db, googleUser, roles) {
  const user = {
    id: crypto.randomUUID(),
    google_sub: googleUser.sub,
    email: googleUser.email,
    display_name: googleUser.name || googleUser.email,
    picture_url: googleUser.picture || null,
    roles_json: JSON.stringify(roles),
  };
  await db.prepare(`
    INSERT INTO users (id, google_sub, email, display_name, picture_url, roles_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    user.id,
    user.google_sub,
    user.email,
    user.display_name,
    user.picture_url,
    user.roles_json,
  ).run();
  return mapUserRow(user);
}

async function promoteFirstUserToAdmin(db, user) {
  const claim = await db.prepare(`
    UPDATE app_config
    SET sheet_owner_user_id = ?, sheet_owner_email = ?, updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    WHERE id = 'default' AND sheet_owner_user_id IS NULL
  `).bind(user.id, user.email).run();

  if (!(claim.meta && claim.meta.changes)) {
    return user;
  }

  await db.prepare(`
    UPDATE users
    SET roles_json = ?, updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    WHERE id = ?
  `).bind(JSON.stringify(["admin"]), user.id).run();

  return {
    ...user,
    roles: ["admin"],
  };
}

async function updateUserProfile(db, userId, googleUser) {
  await db.prepare(`
    UPDATE users
    SET email = ?, display_name = ?, picture_url = ?, updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    WHERE id = ?
  `).bind(
    googleUser.email,
    googleUser.name || googleUser.email,
    googleUser.picture || null,
    userId,
  ).run();
  return getUserById(db, userId);
}

async function getUserByGoogleSub(db, googleSub) {
  const row = await db.prepare(`SELECT * FROM users WHERE google_sub = ?`).bind(googleSub).first();
  return row ? mapUserRow(row) : null;
}

async function getUserById(db, userId) {
  const row = await db.prepare(`SELECT * FROM users WHERE id = ?`).bind(userId).first();
  return row ? mapUserRow(row) : null;
}

async function listUsers(db) {
  const rows = await db.prepare(`SELECT * FROM users ORDER BY created_at ASC`).all();
  return (rows.results || []).map((row) => sanitizeUser(mapUserRow(row)));
}

async function createSession(db, userId) {
  const now = Date.now();
  const accessExpiresAt = new Date(now + ACCESS_TTL_SECONDS * 1000).toISOString();
  const refreshExpiresAt = new Date(now + REFRESH_TTL_SECONDS * 1000).toISOString();
  const session = {
    id: crypto.randomUUID(),
    access_token: crypto.randomUUID(),
    refresh_token: crypto.randomUUID(),
    access_expires_at: accessExpiresAt,
    refresh_expires_at: refreshExpiresAt,
  };
  await db.prepare(`
    INSERT INTO sessions (id, user_id, access_token, refresh_token, access_expires_at, refresh_expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    session.id,
    userId,
    session.access_token,
    session.refresh_token,
    session.access_expires_at,
    session.refresh_expires_at,
  ).run();
  return session;
}

async function listOrders(db) {
  const rows = await db.prepare(`
    SELECT id, order_id, actor_user_ref, actor_role, actor_email, channel, flow_type, duration_code,
           payment_method, provider, country_code, currency, amount_minor, status, paid_at, created_at
    FROM payment_intents
    ORDER BY created_at DESC
    LIMIT 200
  `).all();
  return rows.results || [];
}

async function listCodes(db) {
  const rows = await db.prepare(`
    SELECT c.id, c.code_value, c.flow_type, c.duration_code, c.status, c.payment_ref, c.issued_by_user_ref,
           c.redeem_expires_at, c.redeemed_at, c.redeemed_by_user_ref, c.created_at,
           p.order_id, p.actor_email, p.channel, p.country_code, p.amount_minor, p.currency,
           u.email AS issuer_email, u.display_name AS issuer_name
    FROM codes c
    LEFT JOIN payment_intents p ON p.id = c.payment_ref
    LEFT JOIN users u ON u.id = c.issued_by_user_ref
    ORDER BY c.created_at DESC
    LIMIT 200
  `).all();
  return rows.results || [];
}

async function buildAdminSummary(db) {
  const stats = await multiCounts(db, [
    ["users_total", `SELECT COUNT(*) AS count FROM users`],
    ["admins_total", `SELECT COUNT(*) AS count FROM users WHERE instr(roles_json, '"admin"') > 0`],
    ["resellers_total", `SELECT COUNT(*) AS count FROM users WHERE instr(roles_json, '"reseller"') > 0`],
    ["orders_total", `SELECT COUNT(*) AS count FROM payment_intents`],
    ["orders_paid", `SELECT COUNT(*) AS count FROM payment_intents WHERE status = 'paid'`],
    ["codes_total", `SELECT COUNT(*) AS count FROM codes`],
    ["codes_redeemed", `SELECT COUNT(*) AS count FROM codes WHERE status = 'redeemed'`],
  ]);

  const channels = await db.prepare(`
    SELECT channel, COUNT(*) AS total, SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) AS paid
    FROM payment_intents
    GROUP BY channel
  `).all();

  return {
    summary: stats,
    orders_by_channel: rowsToMap(channels.results || [], "channel", ["total", "paid"]),
  };
}

async function multiCounts(db, queries) {
  const out = {};
  for (const [key, sql] of queries) {
    const row = await db.prepare(sql).first();
    out[key] = Number(row.count || 0);
  }
  return out;
}

function rowsToMap(rows, keyField, valueFields) {
  const out = {};
  for (const row of rows) {
    out[row[keyField]] = {};
    for (const field of valueFields) out[row[keyField]][field] = Number(row[field] || 0);
  }
  return out;
}

async function appendAuditEvent(db, event) {
  await db.prepare(`
    INSERT INTO audit_events (id, event_type, entity_type, entity_id, actor_user_ref, actor_role, payload_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    crypto.randomUUID(),
    event.eventType,
    event.entityType,
    event.entityId || null,
    event.actorUserRef || null,
    event.actorRole || null,
    JSON.stringify(event.payload || {}),
  ).run();
}

async function appendCodeBackup(env, db, eventType, payload) {
  const config = await getAppConfig(db);
  if (!config.sheet_backup_enabled || !config.sheet_script_url) return;

  const now = new Date();
  const body = {
    spreadsheet_title: `${config.sheet_spreadsheet_prefix || "Subscription"} ${now.getUTCFullYear()}`,
    sheet_title: String(now.getUTCMonth() + 1).padStart(2, "0"),
    owner_email: config.sheet_owner_email,
    event_type: eventType,
    record: payload,
  };

  try {
    await fetch(config.sheet_script_url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    await appendAuditEvent(db, {
      eventType: "sheet_backup.failed",
      entityType: "sheet_backup",
      entityId: null,
      actorUserRef: null,
      actorRole: "system",
      payload: { error: error.message, event_type: eventType },
    });
  }
}

async function createCodeRecord(db, record) {
  await db.prepare(`
    INSERT INTO codes (
      id, code_value, flow_type, duration_code, status, payment_ref,
      issued_by_user_ref, redeem_expires_at, redeemed_at, redeemed_by_user_ref, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    record.codeId,
    record.codeValue,
    record.flow,
    record.durationCode,
    record.status,
    record.paymentRef || null,
    record.issuedByUserRef || null,
    record.redeemExpiresAt,
    record.redeemedAt,
    record.redeemedByUserRef || null,
    record.metadataJson || null,
  ).run();
}

async function createCodeRedemption(db, record) {
  await db.prepare(`
    INSERT INTO code_redemptions (id, code_id, redeemed_by_user_ref, redeemed_context)
    VALUES (?, ?, ?, ?)
  `).bind(
    record.redemptionId,
    record.codeId,
    record.redeemedByUserRef || null,
    record.redeemedContext || null,
  ).run();
}

async function getCodeByValue(db, codeValue) {
  return db.prepare(`SELECT id, status, redeem_expires_at FROM codes WHERE code_value = ?`).bind(codeValue).first();
}

async function createReadableCodeValue(db, durationCode) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const codeValue = formatReadableCode(durationCode, randomCodeToken(8));
    const existing = await db.prepare(`SELECT id FROM codes WHERE code_value = ?`).bind(codeValue).first();
    if (!existing) return codeValue;
  }
  throw new Error("unable_to_allocate_unique_code");
}

function formatReadableCode(durationCode, token) {
  const durationLabel = durationCode === "1_day" ? "1D" : durationCode === "6_months" ? "6M" : "12M";
  return `SM-${durationLabel}-${token.slice(0, 4)}-${token.slice(4)}`;
}

function randomCodeToken(length) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
}

function normalizeCodeValue(codeValue) {
  return String(codeValue || "").trim().toUpperCase();
}

function isLegacySignedCode(codeValue) {
  return codeValue.includes(".");
}

function isReadableCodeFormat(codeValue) {
  return /^SM-(1D|6M|12M)-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(codeValue);
}

async function markCodeRedeemed(db, record) {
  const result = await db.prepare(`
    UPDATE codes
    SET status = 'redeemed', redeemed_at = ?, redeemed_by_user_ref = ?, updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    WHERE id = ? AND status IN ('issued', 'reserved')
  `).bind(record.redeemedAt, record.redeemedByUserRef || null, record.codeId).run();
  return Boolean(result.meta && result.meta.changes);
}

async function signCode(payload, privateJwkJson) {
  if (!privateJwkJson) throw new Error("missing_CODE_PRIVATE_JWK");
  const privateJwk = JSON.parse(privateJwkJson);
  const privateKey = await crypto.subtle.importKey("jwk", privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, bytes);
  return `${b64url(bytes)}.${b64url(new Uint8Array(sig))}`;
}

async function verifyCode(codeValue, publicJwkJson) {
  if (!publicJwkJson) throw new Error("missing_CODE_PUBLIC_JWK");
  const [payloadB64, sigB64] = codeValue.split(".");
  if (!payloadB64 || !sigB64) return { valid: false };
  const publicJwk = JSON.parse(publicJwkJson);
  const publicKey = await crypto.subtle.importKey("jwk", publicJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const payloadBytes = b64urlDecode(payloadB64);
  const sigBytes = b64urlDecode(sigB64);
  const valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, sigBytes, payloadBytes);
  return { valid, payload: JSON.parse(new TextDecoder().decode(payloadBytes)) };
}

function mapUserRow(row) {
  return {
    id: row.id,
    email: row.email,
    display_name: row.display_name,
    picture_url: row.picture_url || null,
    roles: JSON.parse(row.roles_json || "[]"),
  };
}

function sanitizeUser(user) {
  return {
    id: user.id,
    email: user.email,
    display_name: user.display_name,
    picture_url: user.picture_url,
    roles: user.roles,
  };
}

function highestRole(roles) {
  return roles.includes("admin") ? "admin" : "reseller";
}

function isAdmin(user) {
  return Boolean(user && user.roles.includes("admin"));
}

function serializePaymentIntent(row) {
  return {
    id: row.id,
    order_id: row.order_id,
    actor_user_ref: row.actor_user_ref,
    actor_role: row.actor_role,
    actor_email: row.actor_email,
    channel: row.channel,
    flow_type: row.flow_type,
    duration_code: row.duration_code,
    method: row.payment_method,
    provider: row.provider,
    country_code: row.country_code,
    currency: row.currency,
    amount_minor: Number(row.amount_minor),
    status: row.status,
    paid_at: row.paid_at || null,
    provider_payload: row.provider_payload_json ? JSON.parse(row.provider_payload_json) : {},
  };
}

async function readJson(request) {
  const text = await request.text();
  if (!text) return {};
  return JSON.parse(text);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function corsPreflight(request) {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(request),
  });
}

function withCors(request, response) {
  const headers = new Headers(response.headers);
  const extras = corsHeaders(request);
  extras.forEach((value, key) => headers.set(key, value));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function corsHeaders(request) {
  const origin = request.headers.get("origin") || "";
  const allowedOrigins = new Set([
    "https://subscription-server-dusky.vercel.app",
    "http://127.0.0.1:5500",
    "http://localhost:5500",
    "http://127.0.0.1:8787",
    "http://localhost:8787",
  ]);
  const allowOrigin = allowedOrigins.has(origin) ? origin : "https://subscription-server-dusky.vercel.app";
  return new Headers({
    "access-control-allow-origin": allowOrigin,
    "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
    "access-control-max-age": "86400",
    "vary": "Origin",
  });
}

function escapeHtmlAttr(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function b64url(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  bytes.forEach((b) => {
    s += String.fromCharCode(b);
  });
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str) {
  const pad = str.length % 4 ? "=".repeat(4 - (str.length % 4)) : "";
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}
