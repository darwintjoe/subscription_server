const ACCESS_TTL_SECONDS = 60 * 60;
const REFRESH_TTL_SECONDS = 60 * 60 * 24 * 30;
const DURATIONS = ["1_day", "6_months", "12_months"];
const PURCHASE_DURATIONS = ["6_months", "12_months"];
const PAYMENT_METHODS = ["qris", "card"];
const FLOW_TYPES = ["direct_subscribe", "reseller_code", "bulk_printed_card"];
const DEFAULT_PAYMENT_METHODS = {
  qris: { enabled: true, provider: "xendit" },
  card: { enabled: true, provider: "stripe" },
};

export default {
  async fetch(request, env, ctx) {
    try {
      return await router(request, env, ctx);
    } catch (error) {
      return json({ error: "internal_error", detail: error.message }, 500);
    }
  },
};

async function router(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const db = requireDb(env);

  if (request.method === "GET" && path === "/health") {
    return json({ ok: true, service: "subscription-server", storage: "d1" });
  }

  if (request.method === "POST" && path === "/v1/auth/google/callback") {
    return handleGoogleCallback(request, env, db);
  }

  if (request.method === "GET" && path === "/v1/auth/google/start") {
    return handleGoogleStart(request, env);
  }

  if (request.method === "GET" && path === "/v1/auth/google/callback") {
    return handleGoogleOauthCallback(request, env, db);
  }

  if (request.method === "POST" && path === "/v1/auth/refresh") {
    return handleRefresh(request, db);
  }

  if (request.method === "GET" && path === "/v1/me") {
    const auth = await requireAuth(request, db);
    if (auth.response) return auth.response;
    return json({ user: sanitizeUser(auth.user) });
  }

  if (request.method === "POST" && path === "/v1/pricing/quote") {
    const body = await readJson(request);
    const duration = body.duration_code;
    if (!PURCHASE_DURATIONS.includes(duration)) return json({ error: "invalid_duration" }, 400);
    const config = await getAppConfig(db);
    const country = (body.country_code || request.headers.get("CF-IPCountry") || "").toUpperCase();
    const quote = resolveQuote(config.pricing, country, duration);
    return json({
      country_code: country || null,
      used_fallback: !config.pricing[country],
      duration_code: duration,
      currency: quote.currency,
      amount_minor: quote.amount_minor,
    });
  }

  if (request.method === "POST" && path === "/v1/payments/intents") {
    const auth = await optionalAuth(request, db);
    return handleCreatePaymentIntent(request, db, auth.user || null);
  }

  if (request.method === "GET" && path.startsWith("/v1/payments/intents/")) {
    const auth = await requireAuth(request, db);
    if (auth.response) return auth.response;
    return handleGetPaymentIntent(path.split("/").pop(), db, auth.user);
  }

  if (request.method === "POST" && (path.startsWith("/v1/webhooks/payments/") || path === "/v1/webhooks/payments/mock")) {
    return handlePaymentWebhook(request, db, path);
  }

  if (request.method === "POST" && path === "/v1/codes/issue") {
    const auth = await optionalAuth(request, db);
    return handleIssueCode(request, env, ctx, db, auth.user || null);
  }

  if (request.method === "POST" && path === "/v1/codes/redeem") {
    const auth = await optionalAuth(request, db);
    return handleRedeemCode(request, env, ctx, db, auth.user || null);
  }

  if (request.method === "POST" && path === "/v1/test/codes/issue") {
    return handleIssueTestCode(request, env, ctx, db);
  }

  if (request.method === "GET" && path === "/v1/admin/config") {
    const auth = await requireAdmin(request, db);
    if (auth.response) return auth.response;
    const config = await getAppConfig(db);
    return json({ config });
  }

  if (request.method === "PUT" && path === "/v1/admin/config") {
    const auth = await requireAdmin(request, db);
    if (auth.response) return auth.response;
    return handleUpdateConfig(request, db, auth.user);
  }

  if (request.method === "GET" && path === "/v1/admin/users") {
    const auth = await requireAdmin(request, db);
    if (auth.response) return auth.response;
    const users = await listUsers(db);
    return json({ users });
  }

  if (request.method === "PUT" && path.startsWith("/v1/admin/users/") && path.endsWith("/roles")) {
    const auth = await requireAdmin(request, db);
    if (auth.response) return auth.response;
    const userId = path.split("/")[4];
    return handleUpdateRoles(request, db, auth.user, userId);
  }

  if (request.method === "GET" && path === "/v1/admin/reports/summary") {
    const auth = await requireAdmin(request, db);
    if (auth.response) return auth.response;
    return json(await buildAdminSummary(db));
  }

  if (request.method === "GET" && path === "/v1/admin/orders") {
    const auth = await requireAdmin(request, db);
    if (auth.response) return auth.response;
    const orders = await listOrders(db);
    return json({ orders });
  }

  if (request.method === "GET" && path === "/v1/admin/codes") {
    const auth = await requireAdmin(request, db);
    if (auth.response) return auth.response;
    const codes = await listCodes(db);
    return json({ codes });
  }

  if (request.method === "POST" && path === "/v1/admin/code-batches") {
    const auth = await requireAdmin(request, db);
    if (auth.response) return auth.response;
    return handleCreateCodeBatch(request, db, auth.user);
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
    const userCount = await countUsers(db);
    const roles = userCount === 0 ? ["admin"] : ["reseller"];
    user = await createUser(db, googleUser, roles);

    if (userCount === 0 && appConfig.sheet_owner_email == null) {
      await db.prepare(`
        UPDATE app_config
        SET sheet_owner_user_id = ?, sheet_owner_email = ?, updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        WHERE id = 'default'
      `).bind(user.id, user.email).run();
    }

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
      const userCount = await countUsers(db);
      const roles = userCount === 0 ? ["admin"] : ["reseller"];
      user = await createUser(db, googleUser, roles);

      if (userCount === 0 && appConfig.sheet_owner_email == null) {
        await db.prepare(`
          UPDATE app_config
          SET sheet_owner_user_id = ?, sheet_owner_email = ?, updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
          WHERE id = 'default'
        `).bind(user.id, user.email).run();
      }
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
    actorUserRef: user.id,
    actorRole: highestRole(user.roles),
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
  const codeValue = await signCode(payload, env.CODE_PRIVATE_JWK);
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

  const decoded = await verifyCode(body.code_value, env.CODE_PUBLIC_JWK);
  if (!decoded.valid) return json({ error: "invalid_code_signature" }, 409);

  const rec = await getCodeByValue(db, body.code_value);
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
  const codeValue = await signCode(payload, env.CODE_PRIVATE_JWK);

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

async function countUsers(db) {
  const row = await db.prepare(`SELECT COUNT(*) AS count FROM users`).first();
  return Number(row.count || 0);
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
    SELECT c.id, c.flow_type, c.duration_code, c.status, c.payment_ref, c.issued_by_user_ref,
           c.redeem_expires_at, c.redeemed_at, c.redeemed_by_user_ref, c.created_at,
           p.order_id, p.actor_email, p.channel, p.amount_minor, p.currency
    FROM codes c
    LEFT JOIN payment_intents p ON p.id = c.payment_ref
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
