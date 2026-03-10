export default {
  async fetch(request, env, ctx) {
    return router(request, env);
  },
};

const memory = {
  paymentIntents: new Map(),
};

const pricingConfig = {
  ID: { "12_months": { currency: "IDR", amount_minor: 999000 }, "6_months": { currency: "IDR", amount_minor: 699000 } },
  VN: { "12_months": { currency: "VND", amount_minor: 999000 }, "6_months": { currency: "VND", amount_minor: 699000 } },
  TH: { "12_months": { currency: "THB", amount_minor: 1999 }, "6_months": { currency: "THB", amount_minor: 1499 } },
  MY: { "12_months": { currency: "MYR", amount_minor: 299 }, "6_months": { currency: "MYR", amount_minor: 199 } },
  MM: { "12_months": { currency: "MMK", amount_minor: 49000 }, "6_months": { currency: "MMK", amount_minor: 29000 } },
};

const fallbackConfig = {
  "12_months": { currency: "USD", amount_minor: 9900 },
  "6_months": { currency: "USD", amount_minor: 6900 },
};

async function router(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === "GET" && path === "/health") {
    return json({ ok: true, service: "subscription-server" });
  }

  if (request.method === "POST" && path === "/v1/auth/google/callback") {
    const body = await request.json();
    if (!body.id_token) return json({ error: "id_token_required" }, 400);
    return json({
      access_token: crypto.randomUUID(),
      refresh_token: crypto.randomUUID(),
      expires_in: 3600,
      user: { id: crypto.randomUUID(), email: "user@example.com", roles: ["reseller"] },
    });
  }

  if (request.method === "POST" && path === "/v1/pricing/quote") {
    const body = await request.json();
    const duration = body.duration_code;
    const country = body.country_code || request.headers.get("CF-IPCountry") || "";
    if (!["6_months", "12_months"].includes(duration)) return json({ error: "invalid_duration" }, 400);
    const quote = (pricingConfig[country] && pricingConfig[country][duration]) || fallbackConfig[duration];
    return json({ country_code: country || null, used_fallback: !(pricingConfig[country] && pricingConfig[country][duration]), duration_code: duration, ...quote });
  }

  if (request.method === "POST" && path === "/v1/payments/intents") {
    const body = await request.json();
    const id = crypto.randomUUID();
    const provider = body.payment_method === "card" ? "stripe" : "xendit";
    const intent = {
      id,
      order_id: crypto.randomUUID(),
      provider,
      method: body.payment_method,
      status: "pending",
      amount_minor: body.amount_minor,
      currency: body.currency,
      provider_payload: { checkout_url: `https://pay.example.com/${id}` },
    };
    memory.paymentIntents.set(id, intent);
    return json(intent, 201);
  }

  if (request.method === "POST" && path.startsWith('/v1/webhooks/payments/')) {
    const body = await request.json();
    const intent = memory.paymentIntents.get(body.payment_intent_id);
    if (!intent) return json({ error: "intent_not_found" }, 404);
    intent.status = "paid";
    return json({ accepted: true });
  }

  if (request.method === "POST" && path === "/v1/codes/issue") {
    try {
      const body = await request.json();
      const intent = memory.paymentIntents.get(body.payment_intent_id);
      if (!intent || intent.status !== "paid") return json({ error: "payment_not_paid" }, 409);
      if (!env.DB) return json({ error: "d1_not_configured" }, 500);

      const flow = body.flow_type || "reseller_code";
      const codeId = crypto.randomUUID();
      const now = Date.now();
      const redeemExpiresAt = flow === "reseller_code" ? new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString() : null;
      const payload = {
        code_id: codeId,
        app_id: "sellmore",
        duration_code: body.duration_code || "12_months",
        flow_type: flow,
        iat: now,
        exp: redeemExpiresAt ? Date.parse(redeemExpiresAt) : null,
        payment_ref: intent.id,
      };

      const codeValue = await signCode(payload, env.CODE_PRIVATE_JWK);
      const status = flow === "direct_subscribe" ? "redeemed" : "issued";
      const redeemedAt = flow === "direct_subscribe" ? new Date().toISOString() : null;

      await createCodeRecord(env.DB, {
        codeId,
        codeValue,
        flow,
        durationCode: payload.duration_code,
        status,
        paymentRef: intent.id,
        redeemExpiresAt,
        redeemedAt,
        metadataJson: JSON.stringify(payload),
      });

      if (status === "redeemed") {
        await createCodeRedemption(env.DB, {
          redemptionId: crypto.randomUUID(),
          codeId,
          redeemedContext: "direct_subscribe_auto_redeem",
        });
      }

      return json({
        code_id: codeId,
        code_value: codeValue,
        status,
        redeem_expires_at: redeemExpiresAt,
      }, 201);
    } catch (error) {
      return json({ error: "code_issue_failed", detail: error.message }, 500);
    }
  }

  if (request.method === "POST" && path === "/v1/codes/redeem") {
    try {
      const body = await request.json();
      const codeValue = body.code_value;
      if (!env.DB) return json({ error: "d1_not_configured" }, 500);

      const decoded = await verifyCode(codeValue, env.CODE_PUBLIC_JWK);
      if (!decoded.valid) return json({ error: "invalid_code_signature" }, 409);

      const rec = await getCodeByValue(env.DB, codeValue);
      if (!rec) return json({ error: "code_not_found" }, 404);
      if (rec.status === "redeemed") return json({ error: "already_redeemed" }, 409);
      if (rec.redeem_expires_at && Date.now() > Date.parse(rec.redeem_expires_at)) return json({ error: "CODE_EXPIRED" }, 409);

      const redeemedAt = new Date().toISOString();
      const updated = await markCodeRedeemed(env.DB, {
        codeId: rec.id,
        redeemedAt,
      });
      if (!updated) return json({ error: "already_redeemed" }, 409);

      await createCodeRedemption(env.DB, {
        redemptionId: crypto.randomUUID(),
        codeId: rec.id,
        redeemedContext: "api_redeem",
      });

      return json({ code_id: rec.id, status: "redeemed", redeemed_at: redeemedAt });
    } catch (error) {
      return json({ error: "code_redeem_failed", detail: error.message }, 500);
    }
  }

  return json({ error: "not_found" }, 404);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

async function createCodeRecord(db, record) {
  await db
    .prepare(`INSERT INTO codes (
      id, code_value, flow_type, duration_code, status, payment_ref,
      redeem_expires_at, redeemed_at, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      record.codeId,
      record.codeValue,
      record.flow,
      record.durationCode,
      record.status,
      record.paymentRef || null,
      record.redeemExpiresAt,
      record.redeemedAt,
      record.metadataJson || null,
    )
    .run();
}

async function createCodeRedemption(db, record) {
  await db
    .prepare(`INSERT INTO code_redemptions (
      id, code_id, redeemed_by_user_ref, redeemed_context
    ) VALUES (?, ?, ?, ?)`)
    .bind(record.redemptionId, record.codeId, record.redeemedByUserRef || null, record.redeemedContext || null)
    .run();
}

async function getCodeByValue(db, codeValue) {
  return db
    .prepare(`SELECT id, status, redeem_expires_at FROM codes WHERE code_value = ?`)
    .bind(codeValue)
    .first();
}

async function markCodeRedeemed(db, record) {
  const result = await db
    .prepare(`UPDATE codes
      SET status = 'redeemed', redeemed_at = ?, updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      WHERE id = ? AND status IN ('issued', 'reserved')`)
    .bind(record.redeemedAt, record.codeId)
    .run();
  return Boolean(result.meta && result.meta.changes);
}

async function signCode(payload, privateJwkJson) {
  const privateJwk = JSON.parse(privateJwkJson);
  const privateKey = await crypto.subtle.importKey("jwk", privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, bytes);
  return `${b64url(bytes)}.${b64url(new Uint8Array(sig))}`;
}

async function verifyCode(codeValue, publicJwkJson) {
  const [payloadB64, sigB64] = codeValue.split('.');
  if (!payloadB64 || !sigB64) return { valid: false };
  const publicJwk = JSON.parse(publicJwkJson);
  const publicKey = await crypto.subtle.importKey("jwk", publicJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const payloadBytes = b64urlDecode(payloadB64);
  const sigBytes = b64urlDecode(sigB64);
  const valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, sigBytes, payloadBytes);
  return { valid, payload: JSON.parse(new TextDecoder().decode(payloadBytes)) };
}

function b64url(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  bytes.forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str) {
  const pad = str.length % 4 ? "=".repeat(4 - (str.length % 4)) : "";
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
