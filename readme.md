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

## Open frontends
- Admin: open `frontend/admin/index.html`
- Reseller PWA: serve `frontend/reseller` via static server.

privatekey = privatekey
publickey = publickey