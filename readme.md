# Subscription Server Lean Starter

## Included
- `backend/worker.mjs`: Cloudflare Worker backend (auth, quote, payments, code issue/redeem).
- `frontend/admin`: Admin web for static pricing config drafting.
- `frontend/reseller`: Reseller PWA starter.
- `docs/sell-more-decoder-install.md`: public-key decoder integration guide for Sell More.

## Run backend locally
1. Install Wrangler.
2. Add `wrangler.toml` with entry `backend/worker.mjs`.
3. Set secrets:
   - `CODE_PRIVATE_JWK`
   - `CODE_PUBLIC_JWK`
4. Run `wrangler dev`.

## Bring to live (without Google OAuth first)

If you want to go live **now** and postpone Google OAuth, you only need to configure Cloudflare + payment credentials.

### What you need to provide
- Cloudflare account (Worker + D1 access)
- Payment provider keys/webhook secret (Xendit/Stripe)
- Code signing key pair (private/public JWK)

### Files you must edit

1. `wrangler.toml` (create in repo root)

```toml
name = "subscription-live"
main = "backend/worker.mjs"
compatibility_date = "2026-03-09"
workers_dev = true
preview_urls = false

[[d1_databases]]
binding = "DB"
database_name = "subscription-live"
database_id = "<your-d1-database-id>"
```

2. `backend/worker.mjs`
   - set real payment provider calls (currently demo flow)
   - read provider creds from `env` secrets

### Cloudflare commands (run in terminal)

```bash
wrangler login
wrangler d1 create subscription-live
wrangler d1 execute subscription-live --file db/schema.sql --remote
wrangler secret put CODE_PRIVATE_JWK
wrangler secret put CODE_PUBLIC_JWK

# add these once you wire provider in worker.mjs
wrangler secret put XENDIT_API_KEY
wrangler secret put STRIPE_SECRET_KEY
wrangler secret put PAYMENT_WEBHOOK_SECRET

wrangler deploy
```

### Minimum go-live checks

```bash
curl https://<your-worker>.workers.dev/health
```

If this returns `{"ok":true}`, deployment is up.

### Note about persistence

Current `backend/worker.mjs` still contains demo in-memory maps for intents/codes.
Before real production traffic, wire these paths to D1 queries (`env.DB`) so state survives restarts/redeploys.

## Open frontends
- Admin: open `frontend/admin/index.html`
- Reseller PWA: serve `frontend/reseller` via static server.
