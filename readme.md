# Subscription Server

Current direction:
- `backend/worker.mjs` is the main backend runtime.
- Cloudflare KV stores users, config, and backup queue state.
- Cloudflare D1 stores code records only.
- `backend/server.mjs` is an experimental local refactor artifact and is not the target deployment path.

## What is implemented
- `backend/server.mjs`
  Experimental local refactor artifact kept for reference only.
- `backend/worker.mjs`
  Main Cloudflare Worker backend using KV for users/config/backup queue and D1 for code records.
- `frontend/admin`
  Static admin dashboard for login, config management, user roles, orders, and code reporting.
- `frontend/reseller`
  Static reseller test client.
- `db/schema.sql`
  D1 schema for users, sessions, app config, payment intents, audit events, codes, redemptions, and code batches.

## Required behavior now
- Registration/login path: Google OAuth only for admin/reseller
- First registered user: `admin`
- Next registered users: `reseller`
- Admin can promote reseller to admin from the admin page
- Code issue/redeem events can append to the first admin's Google Sheet backup using one spreadsheet per year and one tab per month

## Local setup
1. Install Wrangler.
2. Create a D1 database and bind it as `DB` in `wrangler.toml`.
3. Apply the schema:

```bash
wrangler d1 execute <db-name> --file db/schema.sql --local
```

4. Set required secrets:

```bash
wrangler secret put CODE_PRIVATE_JWK
wrangler secret put CODE_PUBLIC_JWK
```

5. Set recommended vars/secrets for auth and local testing:
- `GOOGLE_CLIENT_ID`
  Used to verify the Google ID token audience.
- `GOOGLE_CLIENT_SECRET`
  Required for full server-side Google OAuth authorization-code exchange.
- `ALLOW_DEV_AUTH=true`
  Optional local-only escape hatch. When enabled, `/v1/auth/google/callback` accepts `dev:user@example.com`.

For local development, copy `.dev.vars.example` to `.dev.vars` and fill in the values there.

6. Run locally:

```bash
wrangler dev
```

## Google OAuth flow
- Admin login starts at `GET /v1/auth/google/start?redirect_url=...`
- Google redirects back to `GET /v1/auth/google/callback`
- The Worker exchanges the authorization code server-side using `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
- The Worker fetches the Google user profile, creates or updates the app user, then redirects back to the admin page with app tokens in the URL fragment
- If this is the first registered user, that user is created as `admin`.
- Every later new user is created as `reseller`.
- The main backend server returns access and refresh tokens for API calls.

## Client app integration

See [`docs/client-app-integration.md`](C:\workspace\subscription_server\docs\client-app-integration.md) for the client-app subscription endpoints:
- `POST /v1/client/subscription/quote`
- `POST /v1/client/subscription/direct`
- `POST /v1/client/subscription/redeem`

## Google Sheet backup
The Worker does not write directly to Google Sheets with end-user OAuth. Instead, the admin page configures a Google Apps Script or equivalent webhook endpoint in:
- `sheet_script_url`
- `sheet_spreadsheet_prefix`
- `sheet_owner_email`

When sheet backup is enabled, code issue/redeem events POST JSON to that endpoint with:
- `spreadsheet_title`
  Example: `Subscription 2026`
- `sheet_title`
  Example: `03`
- `owner_email`
- `event_type`
- `record`

This keeps the yearly file / monthly tab naming convention while letting the first admin own the backup destination.

## Open the frontends
- Admin: `frontend/admin/index.html`
- Reseller: `frontend/reseller/index.html`
