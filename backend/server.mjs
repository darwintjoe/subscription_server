import { createServer } from "node:http";
import { randomUUID, createHmac, timingSafeEqual } from "node:crypto";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ACCESS_TTL_SECONDS = 60 * 60;
const REFRESH_TTL_SECONDS = 60 * 60 * 24 * 30;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PURCHASE_DURATIONS = ["6_months", "12_months"];
const PAYMENT_METHODS = ["qris", "card"];
const USER_STATUSES = ["active", "inactive"];
const USER_ROLES = ["admin", "reseller"];
const CODE_SOURCES = ["direct", "reseller", "gift_card"];

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT_DIR, "data");
const USERS_PATH = path.join(DATA_DIR, "users.json");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const QUEUE_PATH = path.join(DATA_DIR, "backup-queue.json");
const LAST_SENT_BATCH_PATH = path.join(DATA_DIR, "last-sent-batch.json");

const ALLOWED_ORIGINS = new Set([
  "https://subscription-server-dusky.vercel.app",
  "http://127.0.0.1:5500",
  "http://localhost:5500",
  "http://127.0.0.1:8787",
  "http://localhost:8787",
  "http://127.0.0.1:3000",
  "http://localhost:3000",
]);

await ensureDataFiles();

const port = Number(process.env.PORT || 3000);
const server = createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      sendEmpty(res, 204, corsHeaders(req));
      return;
    }

    const url = new URL(req.url || "/", getBaseUrl(req));
    const response = await router(req, url);
    sendNodeResponse(res, req, response);
  } catch (error) {
    sendNodeResponse(res, req, json({ error: "internal_error", detail: error.message }, 500));
  }
});

export { server };

server.listen(port, () => {
  process.stdout.write(`subscription-server listening on http://127.0.0.1:${port}\n`);
});

async function router(req, url) {
  const pathName = url.pathname;
  const context = {
    config: await loadConfigState(),
    users: await loadUsers(),
  };

  if (req.method === "GET" && pathName === "/health") {
    return json({ ok: true, service: "subscription-server", storage: "json+d1" });
  }

  if (req.method === "GET" && pathName === "/v1/auth/google/start") {
    return handleGoogleStart(req, url);
  }

  if (req.method === "POST" && pathName === "/v1/auth/google/callback") {
    return handleGoogleCallback(req, context);
  }

  if (req.method === "GET" && pathName === "/v1/auth/google/callback") {
    return handleGoogleOauthCallback(req, url, context);
  }

  if (req.method === "POST" && pathName === "/v1/auth/refresh") {
    return handleRefresh(req, context);
  }

  if (req.method === "GET" && pathName === "/v1/me") {
    const auth = await requireAuth(req, context.users);
    if (auth.response) return auth.response;
    return json({ user: sanitizeUser(auth.user) });
  }

  if (req.method === "POST" && pathName === "/v1/pricing/quote") {
    return handlePricingQuote(req, context);
  }

  // Client app integration surface. The separate app can use these endpoints
  // directly without depending on admin/reseller-specific route semantics.
  if (req.method === "POST" && pathName === "/v1/client/subscription/quote") {
    return handleClientSubscriptionQuote(req, context);
  }

  if (req.method === "POST" && pathName === "/v1/client/subscription/direct") {
    return handleDirectSubscribe(req, context);
  }

  if (req.method === "POST" && pathName === "/v1/client/subscription/redeem") {
    return handleRedeemCode(req, context);
  }

  if (req.method === "POST" && pathName === "/v1/codes/issue") {
    return handleIssueCode(req, context);
  }

  if (req.method === "POST" && pathName === "/v1/codes/redeem") {
    return handleRedeemCode(req, context);
  }

  if (req.method === "GET" && pathName === "/v1/admin/config") {
    const auth = await requireAdmin(req, context.users);
    if (auth.response) return auth.response;
    return json({ config: context.config });
  }

  if (req.method === "PUT" && pathName === "/v1/admin/config") {
    const auth = await requireAdmin(req, context.users);
    if (auth.response) return auth.response;
    return handleUpdateConfig(req, auth.user, context.config);
  }

  if (req.method === "GET" && pathName === "/v1/admin/users") {
    const auth = await requireAdmin(req, context.users);
    if (auth.response) return auth.response;
    return json({ users: listUsers(context.users) });
  }

  if (req.method === "PUT" && pathName.startsWith("/v1/admin/users/")) {
    const auth = await requireAdmin(req, context.users);
    if (auth.response) return auth.response;
    return handleUpdateUser(req, auth.user, context.users, pathName);
  }

  if (req.method === "GET" && pathName === "/v1/admin/reports/summary") {
    const auth = await requireAdmin(req, context.users);
    if (auth.response) return auth.response;
    return json(await buildAdminSummary(context.users));
  }

  if (req.method === "GET" && pathName === "/v1/admin/codes") {
    const auth = await requireAdmin(req, context.users);
    if (auth.response) return auth.response;
    return json({ codes: await listRecentCodes() });
  }

  if (req.method === "POST" && pathName === "/v1/admin/code-batches") {
    const auth = await requireAdmin(req, context.users);
    if (auth.response) return auth.response;
    return handleCreateCodeBatch(req, auth.user);
  }

  if (req.method === "POST" && pathName === "/v1/admin/backup") {
    const auth = await requireAdmin(req, context.users);
    if (auth.response) return auth.response;
    return handleManualBackup();
  }

  return json({ error: "not_found" }, 404);
}

async function handleGoogleStart(req, url) {
  if (!process.env.GOOGLE_CLIENT_ID) return json({ error: "missing_GOOGLE_CLIENT_ID" }, 500);
  if (!process.env.GOOGLE_CLIENT_SECRET) return json({ error: "missing_GOOGLE_CLIENT_SECRET" }, 500);

  const redirectUrl = url.searchParams.get("redirect_url") || deriveDefaultAppUrl(req);
  const state = b64url(JSON.stringify({ redirect_url: redirectUrl }));
  const googleUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  googleUrl.searchParams.set("client_id", process.env.GOOGLE_CLIENT_ID);
  googleUrl.searchParams.set("redirect_uri", deriveGoogleRedirectUri(req));
  googleUrl.searchParams.set("response_type", "code");
  googleUrl.searchParams.set("scope", "openid email profile");
  googleUrl.searchParams.set("access_type", "offline");
  googleUrl.searchParams.set("prompt", "consent");
  googleUrl.searchParams.set("state", state);
  return redirect(googleUrl.toString());
}

async function handleGoogleCallback(req, context) {
  const body = await readJson(req);
  if (!body.id_token) return json({ error: "id_token_required" }, 400);

  const googleUser = await verifyGoogleIdentity(body.id_token);
  const appUser = await upsertGoogleUser(context.users, googleUser, req);
  if (appUser.status !== "active") return json({ error: "user_inactive" }, 403);

  const session = createSessionTokens(appUser);
  return json({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_in: ACCESS_TTL_SECONDS,
    user: sanitizeUser(appUser),
    auth_mode: context.config.google_oauth_mode,
    onboarding_rule: context.config.onboarding_rule,
  });
}

async function handleGoogleOauthCallback(req, url, context) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  if (error) return oauthBounce(deriveReturnUrlFromState(state, req), { error });
  if (!code) return oauthBounce(deriveReturnUrlFromState(state, req), { error: "code_required" });

  try {
    const tokenData = await exchangeAuthorizationCode(req, code);
    const googleUser = await fetchGoogleUserProfile(tokenData.access_token);
    const appUser = await upsertGoogleUser(context.users, googleUser, req);
    if (appUser.status !== "active") {
      return oauthBounce(deriveReturnUrlFromState(state, req), { error: "user_inactive" });
    }

    const session = createSessionTokens(appUser);
    return oauthBounce(deriveReturnUrlFromState(state, req), {
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_in: ACCESS_TTL_SECONDS,
      auth_mode: context.config.google_oauth_mode,
      onboarding_rule: context.config.onboarding_rule,
      user: sanitizeUser(appUser),
    });
  } catch (exchangeError) {
    return oauthBounce(deriveReturnUrlFromState(state, req), { error: exchangeError.message });
  }
}

async function handleRefresh(req, context) {
  const body = await readJson(req);
  if (!body.refresh_token) return json({ error: "refresh_token_required" }, 400);

  let payload;
  try {
    payload = verifySignedToken(body.refresh_token, "refresh");
  } catch (error) {
    return json({ error: error.message }, 401);
  }

  const user = context.users[payload.email];
  if (!user || user.status !== "active") return json({ error: "user_inactive" }, 401);
  const session = createSessionTokens(user);
  return json({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_in: ACCESS_TTL_SECONDS,
    user: sanitizeUser(user),
  });
}

async function handlePricingQuote(req, context) {
  const body = await readJson(req);
  const duration = body.duration_code;
  if (!PURCHASE_DURATIONS.includes(duration)) return json({ error: "invalid_duration" }, 400);

  const auth = await optionalAuth(req, context.users);
  const audience = auth.user && auth.user.role === "reseller" ? "reseller" : "app";
  const country = detectRequestCountry(req);
  const quote = resolveQuote(context.config.active, country, duration, audience);
  return json({
    country_code: country === "fallback" ? null : country,
    used_fallback: !context.config.active.pricing[country],
    duration_code: duration,
    currency: quote.currency,
    amount_minor: quote.amount_minor,
    audience,
    adjustment: quote.adjustment,
  });
}

async function handleClientSubscriptionQuote(req, context) {
  const country = detectRequestCountry(req);
  const quote = resolveQuote(context.config.active, country, "12_months", "app");
  return json({
    country_code: country === "fallback" ? null : country,
    used_fallback: !context.config.active.pricing[country],
    duration_code: "12_months",
    currency: quote.currency,
    amount_minor: quote.amount_minor,
    audience: "app",
    adjustment: quote.adjustment,
    client_flow: "direct_subscribe",
  });
}

async function handleDirectSubscribe(req, context) {
  const body = await readJson(req);
  const payload = {
    duration_code: "12_months",
    source: "direct",
    external_payment_id: body.external_payment_id,
    payment_method: body.payment_method,
    currency: body.currency,
    amount_minor: body.amount_minor,
  };
  return handleIssueCode(buildJsonRequestLike(req, payload), context);
}

async function handleIssueCode(req, context) {
  const body = await readJson(req);
  const auth = await optionalAuth(req, context.users);
  const actor = auth.user || null;
  const durationCode = String(body.duration_code || "");
  const source = String(body.source || inferSource(actor));
  const externalPaymentId = String(body.external_payment_id || "").trim();
  const paymentMethod = body.payment_method ? String(body.payment_method) : null;
  const currency = body.currency ? String(body.currency).toUpperCase() : null;
  const amountMinor = body.amount_minor !== undefined ? Number(body.amount_minor) : null;

  if (!PURCHASE_DURATIONS.includes(durationCode)) return json({ error: "invalid_duration" }, 400);
  if (!CODE_SOURCES.includes(source)) return json({ error: "invalid_source" }, 400);
  if (!externalPaymentId) return json({ error: "external_payment_id_required" }, 400);

  if (source === "gift_card") {
    if (!actor || actor.role !== "admin") return json({ error: "forbidden" }, 403);
    return json({ error: "gift_card_issue_requires_batch" }, 409);
  }

  const existing = await d1First(`
    SELECT id, code_value, flow_type, duration_code, status, payment_ref, redeem_expires_at, redeemed_at
    FROM codes
    WHERE payment_ref = ?
  `, [externalPaymentId]);
  if (existing) {
    return json(source === "direct" ? serializeDirectSubscription(existing) : serializeCodeRow(existing));
  }

  const codeRecord = await createCodeRecord({
    durationCode,
    source,
    externalPaymentId,
    issuedByUserRef: actor ? actor.email : null,
    status: source === "direct" ? "redeemed" : "issued",
    redeemedAt: source === "direct" ? new Date().toISOString() : null,
    redeemedByUserRef: source === "direct" ? "app_client" : null,
  });

  if (source === "direct") {
    await createCodeRedemptionRecord(codeRecord.id, "app_client", "direct_subscribe_auto_redeem");
  }

  await enqueueRegularRow({
    event_type: source === "direct" ? "direct_subscribe" : "reseller_code_issued",
    source,
    code_value: codeRecord.code_value,
    duration_code: codeRecord.duration_code,
    external_payment_id: externalPaymentId,
    payment_method: paymentMethod,
    currency,
    amount_minor: Number.isFinite(amountMinor) ? amountMinor : null,
    payment_country: detectRequestCountry(req),
    actor_email: actor ? actor.email : null,
    status: codeRecord.status,
    generated_at: codeRecord.created_at,
    redeemed_at: codeRecord.redeemed_at,
  });

  return json(source === "direct" ? serializeDirectSubscription(codeRecord) : serializeCodeRow(codeRecord), 201);
}

async function handleRedeemCode(req, context) {
  const body = await readJson(req);
  const codeValue = normalizeCodeValue(body.code_value);
  if (!isReadableCodeFormat(codeValue)) return json({ error: "invalid_code_format" }, 409);

  const row = await d1First(`
    SELECT id, code_value, flow_type, duration_code, status, payment_ref, redeem_expires_at, redeemed_at, created_at
    FROM codes
    WHERE code_value = ?
  `, [codeValue]);
  if (!row) return json({ error: "code_not_found" }, 404);
  if (row.status === "redeemed") return json({ error: "already_redeemed" }, 409);
  if (row.redeem_expires_at && Date.now() > Date.parse(row.redeem_expires_at)) return json({ error: "expired_code" }, 409);

  const redeemedAt = new Date().toISOString();
  const result = await d1Run(`
    UPDATE codes
    SET status = 'redeemed', redeemed_at = ?, redeemed_by_user_ref = ?, updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    WHERE id = ? AND status IN ('issued', 'reserved')
  `, [redeemedAt, "app_client", row.id]);
  if (!result.meta?.changes) return json({ error: "already_redeemed" }, 409);

  await createCodeRedemptionRecord(row.id, "app_client", "client_code_redeem");
  await enqueueRegularRow({
    event_type: "code_redeemed",
    source: mapSourceFromFlowType(row.flow_type),
    code_value: row.code_value,
    duration_code: row.duration_code,
    external_payment_id: row.payment_ref,
    payment_country: detectRequestCountry(req),
    actor_email: null,
    status: "redeemed",
    generated_at: row.created_at,
    redeemed_at: redeemedAt,
  });

  return json({
    ok: true,
    code_value: row.code_value,
    duration_code: row.duration_code,
    redeemed_at: redeemedAt,
    subscription_token: issueSubscriptionToken(row.duration_code, redeemedAt),
  });
}

async function handleUpdateConfig(req, actor, currentConfig) {
  const body = await readJson(req);
  const next = validateCombinedConfig({
    google_oauth_mode: currentConfig.google_oauth_mode,
    onboarding_rule: currentConfig.onboarding_rule,
    backup: {
      ...currentConfig.backup,
      ...(body.backup || {}),
    },
    active: body.active || currentConfig.active,
    upcoming: body.upcoming !== undefined ? body.upcoming : currentConfig.upcoming,
  });
  await writeManagedJson(CONFIG_PATH, next);
  return json({ ok: true, config: next, updated_by: actor.email });
}

async function handleUpdateUser(req, actor, users, pathName) {
  const encodedEmail = pathName.split("/")[4] || "";
  const email = decodeURIComponent(encodedEmail).trim().toLowerCase();
  const body = await readJson(req);
  const user = users[email];
  if (!user) return json({ error: "user_not_found" }, 404);
  if (email === actor.email) return json({ error: "self_modification_forbidden" }, 409);

  const nextRole = body.role !== undefined ? String(body.role) : user.role;
  const nextStatus = body.status !== undefined ? String(body.status) : user.status;
  if (!USER_ROLES.includes(nextRole)) return json({ error: "invalid_role" }, 400);
  if (!USER_STATUSES.includes(nextStatus)) return json({ error: "invalid_status" }, 400);

  users[email] = {
    ...user,
    role: nextRole,
    status: nextStatus,
    updated_at: new Date().toISOString(),
  };
  await writeManagedJson(USERS_PATH, users);
  return json({ ok: true, user: sanitizeUser(users[email]) });
}

async function handleManualBackup() {
  const queue = await loadQueue();
  const hasPending = Boolean((queue.regular || []).length || (queue.bulk || []).length);
  if (!hasPending) return json({ ok: true, sent: false, detail: "queue_empty" });

  const sentAt = new Date().toISOString();
  const batch = {
    sent_at: sentAt,
    regular: queue.regular || [],
    bulk: queue.bulk || [],
  };
  await writeManagedJson(LAST_SENT_BATCH_PATH, batch);
  await writeManagedJson(QUEUE_PATH, { regular: [], bulk: [] });

  const config = await loadConfigState();
  config.backup.last_backup_at = sentAt;
  config.backup.last_sent_batch_at = sentAt;
  await writeManagedJson(CONFIG_PATH, config);

  return json({
    ok: true,
    sent: true,
    last_backup_at: sentAt,
    regular_rows: batch.regular.length,
    bulk_rows: batch.bulk.length,
  });
}

async function handleCreateCodeBatch(req, actor) {
  const body = await readJson(req);
  const quantity = Number(body.quantity);
  const durationCode = String(body.duration_code || "");
  const note = body.note ? String(body.note) : null;

  if (!Number.isInteger(quantity) || quantity < 1) return json({ error: "invalid_quantity" }, 400);
  if (!PURCHASE_DURATIONS.includes(durationCode)) return json({ error: "invalid_duration" }, 400);

  const batchId = randomUUID();
  await d1Run(`
    INSERT INTO code_batches (id, created_by_user_ref, quantity, duration_code, expiry_policy, notes, metadata_json)
    VALUES (?, ?, ?, ?, 'fixed_12_months', ?, ?)
  `, [batchId, actor.email, quantity, durationCode, note, JSON.stringify({ source: "gift_card_batch" })]);

  const created = [];
  for (let index = 0; index < quantity; index += 1) {
    const codeRecord = await createCodeRecord({
      durationCode,
      source: "gift_card",
      externalPaymentId: `gift-batch:${batchId}`,
      issuedByUserRef: actor.email,
      status: "issued",
      redeemedAt: null,
      redeemedByUserRef: null,
    });
    await d1Run(`
      INSERT INTO code_batch_items (batch_id, code_id)
      VALUES (?, ?)
    `, [batchId, codeRecord.id]);
    created.push(codeRecord);
  }

  await enqueueBulkRow({
    event_type: "gift_card_batch_issued",
    batch_id: batchId,
    note,
    quantity,
    duration_code: durationCode,
    actor_email: actor.email,
    generated_at: new Date().toISOString(),
    codes: created.map((item) => item.code_value),
  });

  return json({
    ok: true,
    batch_id: batchId,
    quantity,
    duration_code: durationCode,
    codes: created.map((item) => item.code_value),
  }, 201);
}

async function buildAdminSummary(users) {
  const queue = await loadQueue();
  const lastBatch = await readManagedJson(LAST_SENT_BATCH_PATH, { regular: [], bulk: [] });
  const codeCountRow = await d1First(`SELECT COUNT(*) AS count FROM codes`, []);
  const activeResellers = Object.values(users).filter((user) => user.role === "reseller" && user.status === "active").length;
  const topRevenue = summarizeTopCurrency(lastBatch.regular || []);
  return {
    cards: {
      subscriptions_sold: Number(codeCountRow?.count || 0),
      revenue_total: topRevenue,
      pending_backup_today: (queue.regular || []).length + (queue.bulk || []).length,
      active_resellers: activeResellers,
    },
  };
}

async function listRecentCodes() {
  const rows = await d1All(`
    SELECT id, code_value, flow_type, duration_code, status, payment_ref, redeem_expires_at, redeemed_at, created_at
    FROM codes
    ORDER BY created_at DESC
    LIMIT 200
  `);
  return rows.map((row) => serializeCodeRow(row));
}

async function requireAuth(req, users) {
  const token = getBearerToken(req);
  if (!token) return { response: json({ error: "unauthorized" }, 401) };

  let payload;
  try {
    payload = verifySignedToken(token, "access");
  } catch (error) {
    return { response: json({ error: error.message }, 401) };
  }

  const user = users[payload.email];
  if (!user || user.status !== "active") return { response: json({ error: "user_inactive" }, 401) };
  return { user };
}

async function optionalAuth(req, users) {
  const token = getBearerToken(req);
  if (!token) return { user: null };
  return requireAuth(req, users);
}

async function requireAdmin(req, users) {
  const auth = await requireAuth(req, users);
  if (auth.response) return auth;
  if (auth.user.role !== "admin") return { response: json({ error: "forbidden" }, 403) };
  return auth;
}

async function upsertGoogleUser(users, googleUser, req) {
  const email = googleUser.email.toLowerCase();
  const now = new Date().toISOString();
  const country = detectRequestCountry(req);
  const existing = users[email];

  if (existing) {
    const next = {
      ...existing,
      name: googleUser.name || existing.name || email,
      country,
      updated_at: now,
    };
    users[email] = next;
    await writeManagedJson(USERS_PATH, users);
    return next;
  }

  const role = Object.keys(users).length === 0 ? "admin" : "reseller";
  const created = {
    name: googleUser.name || email,
    email,
    country,
    role,
    status: "active",
    created_at: now,
    updated_at: now,
  };
  users[email] = created;
  await writeManagedJson(USERS_PATH, users);
  return created;
}

function createSessionTokens(user) {
  return {
    access_token: signToken({
      typ: "access",
      email: user.email,
      role: user.role,
      exp: nowSeconds() + ACCESS_TTL_SECONDS,
    }),
    refresh_token: signToken({
      typ: "refresh",
      email: user.email,
      role: user.role,
      exp: nowSeconds() + REFRESH_TTL_SECONDS,
    }),
  };
}

function issueSubscriptionToken(durationCode, redeemedAt) {
  const expiry = computeExpiry(durationCode, redeemedAt);
  return signToken({
    typ: "subscription",
    ver: "v1",
    exp: Math.floor(Date.parse(expiry) / 1000),
  });
}

function signToken(payload) {
  const serialized = b64url(JSON.stringify(payload));
  const signature = signValue(serialized);
  return `${serialized}.${signature}`;
}

function verifySignedToken(token, expectedType) {
  const parts = String(token || "").split(".");
  if (parts.length !== 2) throw new Error("invalid_token");
  const [serialized, signature] = parts;
  const expectedSignature = signValue(serialized);
  const left = Buffer.from(signature);
  const right = Buffer.from(expectedSignature);
  if (left.length !== right.length || !timingSafeEqual(left, right)) throw new Error("invalid_token");

  const payload = JSON.parse(Buffer.from(serialized, "base64url").toString("utf8"));
  if (payload.typ !== expectedType) throw new Error("invalid_token_type");
  if (Number(payload.exp || 0) <= nowSeconds()) throw new Error(`${expectedType}_token_expired`);
  return payload;
}

function signValue(value) {
  return createHmac("sha256", getTokenSecret()).update(value).digest("base64url");
}

async function loadUsers() {
  return readManagedJson(USERS_PATH, {});
}

async function loadConfigState() {
  const raw = validateCombinedConfig(await readManagedJson(CONFIG_PATH, {}));
  if (raw.upcoming && Date.parse(raw.upcoming.effective_at) <= Date.now()) {
    const activated = {
      ...raw,
      active: raw.upcoming.config,
      upcoming: null,
    };
    await writeManagedJson(CONFIG_PATH, activated);
    return activated;
  }
  return raw;
}

async function loadQueue() {
  return readManagedJson(QUEUE_PATH, { regular: [], bulk: [] });
}

async function enqueueRegularRow(row) {
  const queue = await loadQueue();
  queue.regular = queue.regular || [];
  queue.regular.push({
    id: randomUUID(),
    queued_at: new Date().toISOString(),
    ...row,
  });
  await writeManagedJson(QUEUE_PATH, queue);
}

async function enqueueBulkRow(row) {
  const queue = await loadQueue();
  queue.bulk = queue.bulk || [];
  queue.bulk.push({
    id: randomUUID(),
    queued_at: new Date().toISOString(),
    ...row,
  });
  await writeManagedJson(QUEUE_PATH, queue);
}

async function readManagedJson(filePath, fallback) {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeManagedJson(filePath, data) {
  const tmpPath = `${filePath}.tmp`;
  const backupPath = filePath.replace(/\.json$/i, ".backup.json");
  try {
    await copyFile(filePath, backupPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(tmpPath, filePath);
}

async function ensureDataFiles() {
  await mkdir(DATA_DIR, { recursive: true });
  const files = [
    [USERS_PATH, "{}\n"],
    [QUEUE_PATH, "{\n  \"regular\": [],\n  \"bulk\": []\n}\n"],
    [LAST_SENT_BATCH_PATH, "{\n  \"sent_at\": null,\n  \"regular\": [],\n  \"bulk\": []\n}\n"],
  ];
  for (const [filePath, initial] of files) {
    try {
      await readFile(filePath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await writeFile(filePath, initial, "utf8");
    }
  }
}

function validateCombinedConfig(input) {
  if (!input || typeof input !== "object") throw new Error("invalid_config");
  const active = validateConfigPayload(input.active || {});
  const upcoming = input.upcoming == null ? null : validateUpcomingConfig(input.upcoming);
  const backup = {
    timezone: String(input.backup?.timezone || "UTC+7"),
    daily_run_time: String(input.backup?.daily_run_time || "03:00"),
    last_backup_at: input.backup?.last_backup_at || null,
    sheet_prefix: String(input.backup?.sheet_prefix || "Subscription"),
    last_sent_batch_at: input.backup?.last_sent_batch_at || null,
  };
  return {
    google_oauth_mode: "google_oauth_only",
    onboarding_rule: "first_user_admin",
    active,
    upcoming,
    backup,
  };
}

async function d1Run(sql, params = []) {
  const result = await d1Request("/query", sql, params);
  return result.meta ? result : (result[0] || result);
}

async function d1First(sql, params = []) {
  const rows = await d1All(sql, params);
  return rows[0] || null;
}

async function d1All(sql, params = []) {
  const result = await d1Request("/query", sql, params);
  if (Array.isArray(result)) {
    return result[0]?.results || [];
  }
  return result.results || [];
}

async function d1Request(endpoint, sql, params) {
  const accountId = await getCloudflareAccountId();
  const databaseId = await getD1DatabaseId();
  const apiToken = process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN;
  if (!apiToken) throw new Error("missing_CLOUDFLARE_API_TOKEN");

  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}${endpoint}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      sql,
      params,
    }),
  });

  const payload = await response.json();
  if (!response.ok || payload.success === false) {
    throw new Error(payload.errors?.[0]?.message || "d1_request_failed");
  }
  return payload.result;
}

let cachedAccountId = null;
let cachedDatabaseId = null;

async function getCloudflareAccountId() {
  if (cachedAccountId) return cachedAccountId;
  cachedAccountId = process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CF_ACCOUNT_ID;
  if (cachedAccountId) return cachedAccountId;

  const accountCachePath = path.join(ROOT_DIR, ".wrangler", "cache", "wrangler-account.json");
  const accountCache = await readManagedJson(accountCachePath, null);
  cachedAccountId = accountCache?.account?.id || null;
  if (!cachedAccountId) throw new Error("missing_CLOUDFLARE_ACCOUNT_ID");
  return cachedAccountId;
}

async function getD1DatabaseId() {
  if (cachedDatabaseId) return cachedDatabaseId;
  cachedDatabaseId = process.env.D1_DATABASE_ID || process.env.CLOUDFLARE_D1_DATABASE_ID;
  if (cachedDatabaseId) return cachedDatabaseId;

  const wranglerToml = await readFile(path.join(ROOT_DIR, "wrangler.toml"), "utf8");
  const match = wranglerToml.match(/database_id\s*=\s*"([^"]+)"/);
  cachedDatabaseId = match ? match[1] : null;
  if (!cachedDatabaseId) throw new Error("missing_D1_DATABASE_ID");
  return cachedDatabaseId;
}

async function createCodeRecord({ durationCode, source, externalPaymentId, issuedByUserRef, status, redeemedAt, redeemedByUserRef }) {
  const codeId = randomUUID();
  const codeValue = await createReadableCodeValue(durationCode);
  const redeemExpiresAt = source === "reseller" ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() : null;
  await d1Run(`
    INSERT INTO codes (
      id, code_value, flow_type, duration_code, status, payment_ref,
      issued_by_user_ref, redeem_expires_at, redeemed_at, redeemed_by_user_ref, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    codeId,
    codeValue,
    mapSourceToFlowType(source),
    durationCode,
    status,
    externalPaymentId,
    issuedByUserRef,
    redeemExpiresAt,
    redeemedAt,
    redeemedByUserRef,
    JSON.stringify({ source }),
  ]);

  return {
    id: codeId,
    code_value: codeValue,
    flow_type: mapSourceToFlowType(source),
    duration_code: durationCode,
    status,
    payment_ref: externalPaymentId,
    redeem_expires_at: redeemExpiresAt,
    redeemed_at: redeemedAt,
    created_at: new Date().toISOString(),
  };
}

async function createCodeRedemptionRecord(codeId, redeemedByUserRef, redeemedContext) {
  await d1Run(`
    INSERT OR REPLACE INTO code_redemptions (id, code_id, redeemed_by_user_ref, redeemed_context)
    VALUES (?, ?, ?, ?)
  `, [randomUUID(), codeId, redeemedByUserRef, redeemedContext]);
}

async function createReadableCodeValue(durationCode) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const codeValue = formatReadableCode(durationCode, randomCodeToken(8));
    const existing = await d1First(`SELECT id FROM codes WHERE code_value = ?`, [codeValue]);
    if (!existing) return codeValue;
  }
  throw new Error("unable_to_allocate_unique_code");
}

function formatReadableCode(durationCode, token) {
  const durationLabel = durationCode === "6_months" ? "6M" : "12M";
  return `SM-${durationLabel}-${token.slice(0, 4)}-${token.slice(4)}`;
}

function randomCodeToken(length) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (let index = 0; index < length; index += 1) {
    out += CODE_ALPHABET[bytes[index] % CODE_ALPHABET.length];
  }
  return out;
}

function serializeCodeRow(row) {
  return {
    id: row.id,
    code_value: row.code_value,
    source: mapSourceFromFlowType(row.flow_type),
    duration_code: row.duration_code,
    status: row.status,
    external_payment_id: row.payment_ref,
    redeem_expires_at: row.redeem_expires_at || null,
    redeemed_at: row.redeemed_at || null,
    created_at: row.created_at || null,
  };
}

function serializeDirectSubscription(row) {
  const redeemedAt = row.redeemed_at || new Date().toISOString();
  const subscribedUntil = computeExpiry(row.duration_code, redeemedAt);
  return {
    ok: true,
    subscription_token: issueSubscriptionToken(row.duration_code, redeemedAt),
    subscribed_until: subscribedUntil,
    code_value: row.code_value,
    duration_code: row.duration_code,
    redeemed_at: redeemedAt,
  };
}

function normalizeCodeValue(value) {
  return String(value || "").trim().toUpperCase();
}

function isReadableCodeFormat(value) {
  return /^SM-(6M|12M)-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(value);
}

function mapSourceToFlowType(source) {
  if (source === "direct") return "direct_subscribe";
  if (source === "gift_card") return "bulk_printed_card";
  return "reseller_code";
}

function mapSourceFromFlowType(flowType) {
  if (flowType === "direct_subscribe") return "direct";
  if (flowType === "bulk_printed_card") return "gift_card";
  return "reseller";
}

function inferSource(actor) {
  if (actor && actor.role === "reseller") return "reseller";
  return "direct";
}

function buildJsonRequestLike(req, body) {
  return {
    headers: req.headers,
    method: req.method,
    url: req.url,
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(body));
    },
  };
}

function summarizeTopCurrency(rows) {
  const byCurrency = new Map();
  for (const row of rows) {
    if (!row || !row.currency) continue;
    const current = byCurrency.get(row.currency) || { count: 0, amount_minor: 0 };
    current.count += 1;
    current.amount_minor += Number(row.amount_minor || 0);
    byCurrency.set(row.currency, current);
  }
  let selectedCurrency = null;
  let selected = null;
  for (const [currency, value] of byCurrency.entries()) {
    if (!selected || value.count > selected.count) {
      selectedCurrency = currency;
      selected = value;
    }
  }
  if (!selectedCurrency || !selected) return "-";
  return `${selectedCurrency} ${selected.amount_minor}`;
}

function computeExpiry(durationCode, fromIsoString) {
  const date = new Date(fromIsoString);
  if (durationCode === "6_months") {
    date.setUTCMonth(date.getUTCMonth() + 6);
  } else {
    date.setUTCMonth(date.getUTCMonth() + 12);
  }
  return date.toISOString();
}

function validateUpcomingConfig(input) {
  if (!input || typeof input !== "object") throw new Error("invalid_upcoming_config");
  if (!input.effective_at || Number.isNaN(Date.parse(input.effective_at))) throw new Error("invalid_upcoming_effective_at");
  return {
    effective_at: new Date(input.effective_at).toISOString(),
    config: validateConfigPayload(input.config || {}),
  };
}

function validateConfigPayload(input) {
  if (!input || typeof input !== "object") throw new Error("invalid_config_payload");
  const paymentMethods = validatePaymentMethods(input.payment_methods || {});
  const pricing = validatePricingConfig(input.pricing || {});
  const resellerDiscounts = validateResellerDiscounts(input.reseller_discounts || {}, pricing);
  const promotions = validatePromotions(input.promotions || [], pricing);
  return {
    payment_methods: paymentMethods,
    pricing,
    reseller_discounts: resellerDiscounts,
    promotions,
  };
}

function validatePaymentMethods(input) {
  const next = {};
  for (const method of PAYMENT_METHODS) {
    const current = input[method] || {};
    next[method] = {
      enabled: current.enabled !== false,
      provider: String(current.provider || (method === "qris" ? "xendit" : "stripe")),
    };
  }
  return next;
}

function validatePricingConfig(input) {
  if (!input || typeof input !== "object" || !input.fallback) throw new Error("invalid_pricing_config");
  const pricing = {};
  for (const [country, value] of Object.entries(input)) {
    if (country !== "fallback" && !/^[A-Z]{2}$/.test(country)) throw new Error(`invalid_market_code_${country}`);
    pricing[country] = {};
    for (const duration of PURCHASE_DURATIONS) {
      const item = value?.[duration];
      if (!item) throw new Error(`missing_pricing_${country}_${duration}`);
      if (!/^[A-Z]{3}$/.test(String(item.currency || ""))) throw new Error(`invalid_currency_${country}_${duration}`);
      if (!Number.isFinite(Number(item.amount_minor)) || Number(item.amount_minor) < 0) throw new Error(`invalid_amount_${country}_${duration}`);
      pricing[country][duration] = {
        currency: String(item.currency),
        amount_minor: Number(item.amount_minor),
      };
    }
  }
  return pricing;
}

function validateResellerDiscounts(input, pricing) {
  const discounts = {};
  for (const [country, value] of Object.entries(input)) {
    if (!pricing[country]) throw new Error(`discount_country_not_priced_${country}`);
    discounts[country] = normalizeAdjustment(value, "discount");
  }
  return discounts;
}

function validatePromotions(input, pricing) {
  if (!Array.isArray(input)) throw new Error("invalid_promotions");
  const promotions = input.map((entry) => normalizePromotion(entry, pricing));
  for (let i = 0; i < promotions.length; i += 1) {
    for (let j = i + 1; j < promotions.length; j += 1) {
      if (promotionsConflict(promotions[i], promotions[j])) throw new Error("overlapping_promotions_not_allowed");
    }
  }
  return promotions;
}

function normalizeAdjustment(input, label) {
  if (!input || typeof input !== "object") throw new Error(`invalid_${label}`);
  const type = String(input.type || "");
  if (type !== "fixed" && type !== "percentage") throw new Error(`invalid_${label}_type`);
  if (type === "fixed") {
    if (!Number.isFinite(Number(input.value_minor)) || Number(input.value_minor) < 0) throw new Error(`invalid_${label}_value_minor`);
    return { type, value_minor: Number(input.value_minor) };
  }
  if (!Number.isFinite(Number(input.value)) || Number(input.value) < 0 || Number(input.value) > 100) throw new Error(`invalid_${label}_value`);
  return { type, value: Number(input.value) };
}

function normalizePromotion(input, pricing) {
  if (!input || typeof input !== "object") throw new Error("invalid_promotion");
  const countries = Array.isArray(input.countries) ? Array.from(new Set(input.countries.map((country) => String(country).toUpperCase()))) : [];
  if (!countries.length) throw new Error("promotion_countries_required");
  for (const country of countries) {
    if (!pricing[country]) throw new Error(`promotion_country_not_priced_${country}`);
  }

  const targets = Array.isArray(input.targets) ? Array.from(new Set(input.targets.map((target) => String(target)))) : [];
  if (!targets.length) throw new Error("promotion_targets_required");
  if (targets.some((target) => target !== "app" && target !== "reseller")) throw new Error("invalid_promotion_target");

  const normalized = {
    id: String(input.id || randomUUID()),
    name: String(input.name || "Promotion"),
    countries,
    targets,
    starts_at: input.starts_at ? new Date(input.starts_at).toISOString() : null,
    ends_at: input.ends_at ? new Date(input.ends_at).toISOString() : null,
    ...normalizeAdjustment(input, "promotion"),
  };
  if (normalized.ends_at && normalized.starts_at && Date.parse(normalized.ends_at) < Date.parse(normalized.starts_at)) {
    throw new Error("invalid_promotion_window");
  }
  if (countries.length > 1 && normalized.type !== "percentage") throw new Error("multi_country_promotion_must_be_percentage");
  return normalized;
}

function promotionsConflict(left, right) {
  if (!left.countries.some((country) => right.countries.includes(country))) return false;
  if (!left.targets.some((target) => right.targets.includes(target))) return false;
  return windowsOverlap(left.starts_at, left.ends_at, right.starts_at, right.ends_at);
}

function windowsOverlap(leftStart, leftEnd, rightStart, rightEnd) {
  const startA = leftStart ? Date.parse(leftStart) : Number.MIN_SAFE_INTEGER;
  const endA = leftEnd ? Date.parse(leftEnd) : Number.MAX_SAFE_INTEGER;
  const startB = rightStart ? Date.parse(rightStart) : Number.MIN_SAFE_INTEGER;
  const endB = rightEnd ? Date.parse(rightEnd) : Number.MAX_SAFE_INTEGER;
  return startA <= endB && startB <= endA;
}

function resolveQuote(activeConfig, country, duration, audience) {
  const selectedCountry = activeConfig.pricing[country] ? country : "fallback";
  const base = activeConfig.pricing[selectedCountry]?.[duration];
  if (!base) throw new Error("pricing_not_configured");

  const candidates = [];
  if (audience === "reseller" && activeConfig.reseller_discounts[selectedCountry]) {
    const discount = applyAdjustment(base.amount_minor, activeConfig.reseller_discounts[selectedCountry]);
    candidates.push({ amount_minor: discount, adjustment: { kind: "reseller_discount", ...activeConfig.reseller_discounts[selectedCountry] } });
  }

  const now = Date.now();
  for (const promotion of activeConfig.promotions) {
    if (!promotion.targets.includes(audience)) continue;
    if (!promotion.countries.includes(selectedCountry)) continue;
    if (promotion.starts_at && now < Date.parse(promotion.starts_at)) continue;
    if (promotion.ends_at && now > Date.parse(promotion.ends_at)) continue;
    const amountMinor = applyAdjustment(base.amount_minor, promotion);
    candidates.push({ amount_minor: amountMinor, adjustment: { kind: "promotion", id: promotion.id, type: promotion.type } });
  }

  let selected = { amount_minor: base.amount_minor, adjustment: null };
  for (const candidate of candidates) {
    if (candidate.amount_minor < selected.amount_minor) selected = candidate;
  }

  return {
    currency: base.currency,
    amount_minor: selected.amount_minor,
    adjustment: selected.adjustment,
  };
}

function applyAdjustment(baseAmountMinor, adjustment) {
  if (adjustment.type === "fixed") return Math.max(0, baseAmountMinor - Number(adjustment.value_minor || 0));
  return Math.max(0, Math.round(baseAmountMinor * (100 - Number(adjustment.value || 0)) / 100));
}

function detectRequestCountry(req) {
  const raw = String(req.headers["cf-ipcountry"] || req.headers["x-vercel-ip-country"] || req.headers["x-country-code"] || "").trim().toUpperCase();
  if (!raw || raw === "XX" || raw === "T1") return "fallback";
  return /^[A-Z]{2}$/.test(raw) ? raw : "fallback";
}

function getBearerToken(req) {
  const header = String(req.headers.authorization || "");
  if (!header.startsWith("Bearer ")) return "";
  return header.slice(7).trim();
}

function listUsers(users) {
  return Object.values(users)
    .sort((left, right) => left.email.localeCompare(right.email))
    .map((user) => sanitizeUser(user));
}

function sanitizeUser(user) {
  return {
    id: user.email,
    email: user.email,
    display_name: user.name,
    country: user.country,
    role: user.role,
    roles: [user.role],
    status: user.status,
  };
}

async function verifyGoogleIdentity(idToken) {
  if (process.env.ALLOW_DEV_AUTH === "true" && idToken.startsWith("dev:")) {
    const email = idToken.slice(4).trim().toLowerCase();
    return { email, name: email.split("@")[0] };
  }

  const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
  if (!response.ok) throw new Error("google_token_verification_failed");
  const data = await response.json();
  if (!data.email) throw new Error("google_identity_incomplete");
  if (process.env.GOOGLE_CLIENT_ID && data.aud !== process.env.GOOGLE_CLIENT_ID) throw new Error("google_audience_mismatch");
  return {
    email: String(data.email).toLowerCase(),
    name: data.name || data.email,
  };
}

async function exchangeAuthorizationCode(req, code) {
  if (!process.env.GOOGLE_CLIENT_ID) throw new Error("missing_GOOGLE_CLIENT_ID");
  if (!process.env.GOOGLE_CLIENT_SECRET) throw new Error("missing_GOOGLE_CLIENT_SECRET");

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: deriveGoogleRedirectUri(req),
      grant_type: "authorization_code",
    }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "google_code_exchange_failed");
  return data;
}

async function fetchGoogleUserProfile(accessToken) {
  const response = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "google_userinfo_failed");
  if (!data.email) throw new Error("google_userinfo_incomplete");
  return {
    email: String(data.email).toLowerCase(),
    name: data.name || data.email,
  };
}

function deriveGoogleRedirectUri(req) {
  return `${getBaseUrl(req)}/v1/auth/google/callback`;
}

function deriveDefaultAppUrl(req) {
  return `${getBaseUrl(req)}/frontend/admin/`;
}

function deriveReturnUrlFromState(state, req) {
  if (!state) return deriveDefaultAppUrl(req);
  try {
    const decoded = JSON.parse(Buffer.from(state, "base64url").toString("utf8"));
    return decoded.redirect_url || deriveDefaultAppUrl(req);
  } catch {
    return deriveDefaultAppUrl(req);
  }
}

function oauthBounce(returnUrl, payload) {
  const fragment = new URLSearchParams();
  for (const [key, value] of Object.entries(payload)) {
    fragment.set(key, typeof value === "string" ? value : JSON.stringify(value));
  }
  const safeReturnUrl = returnUrl || "/";
  const location = safeReturnUrl + (safeReturnUrl.includes("#") ? "&" : "#") + fragment.toString();
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${escapeHtmlAttr(location)}"></head><body>Redirecting...</body></html>`;
  return {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    body: html,
  };
}

function json(data, status = 200) {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  };
}

function redirect(location, status = 302) {
  return {
    status,
    headers: { location },
    body: "",
  };
}

async function readJson(req) {
  const text = await readBody(req);
  if (!text) return {};
  return JSON.parse(text);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function sendNodeResponse(res, req, response) {
  const headers = {
    ...response.headers,
    ...corsHeaders(req),
  };
  res.writeHead(response.status, headers);
  res.end(response.body || "");
}

function sendEmpty(res, status, headers) {
  res.writeHead(status, headers);
  res.end();
}

function corsHeaders(req) {
  const origin = String(req.headers.origin || "");
  const allowOrigin = ALLOWED_ORIGINS.has(origin) ? origin : "http://localhost:3000";
  return {
    "access-control-allow-origin": allowOrigin,
    "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

function getBaseUrl(req) {
  const proto = String(req.headers["x-forwarded-proto"] || "http");
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || `127.0.0.1:${port}`);
  return `${proto}://${host}`;
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function getTokenSecret() {
  return process.env.TOKEN_SECRET || "dev-only-token-secret";
}

function b64url(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function escapeHtmlAttr(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
