# Subscription Server v1 Technical Specification

## 1. Scope

This document defines the current target architecture for `subscription_server`.

The system has 3 user types:

- `admin`
- `reseller`
- generic `client app` user with no stored account

The system has 3 app surfaces:

- admin mobile web app
- reseller PWA mobile web app
- client app integration against backend endpoints only

## 2. Locked Architecture

### Main backend runtime

The main backend runtime is the Cloudflare Worker implemented in [`backend/worker.mjs`](C:\workspace\subscription_server\backend\worker.mjs).

Responsibilities:

- Google OAuth for admin and reseller
- KV-backed user storage
- KV-backed pricing / discount / promotion config
- KV-backed backup queue management
- admin and reseller API surface
- client app integration endpoints
- direct Cloudflare D1 access for code storage

### Cloudflare D1

Cloudflare D1 is kept for code-related records only.

D1 stores:

- code issuance records
- code redemption records
- bulk gift-card batch records
- minimal external payment reference
- code source marker
- generated timestamp
- redeemed timestamp

D1 is the live source of truth for code validity and one-time-use enforcement.

### Cloudflare KV

Small writable datasets are stored as JSON documents inside one KV namespace.

Logical documents:

- `users`
- `config`
- `backup_queue`
- `last_sent_batch`

Rules:

- `users.json` is separate
- pricing, discounts, promotions, payment config, and backup metadata are in one combined config file
- no historical config retention is required beyond the latest sent batch
- one active config plus at most one upcoming config is allowed

### Google Sheets

Google Sheets is the long-term business ledger.

Rules:

- regular business rows are queued locally and sent in one daily batch
- daily batch time is `3:00 AM UTC+7`
- admin can also trigger manual backup
- only unsent rows are sent
- after success, queue rows are cleared
- the most recent sent batch is kept locally in `last-sent-batch.json`

Split:

- regular transactions go to the normal transaction sheet
- bulk gift-card issuance goes to a separate Google Sheet file

## 3. Authentication and User Model

### OAuth

Admin and reseller users authenticate with Google OAuth only through the Worker.

Stored user fields:

- `name`
- `email`
- `country`
- `role`
- `status`

Country is:

- silently detected from request headers
- updated automatically on later login if it changes
- visible to admin
- not shown to reseller as a UI feature

### Role assignment

- first successful login becomes bootstrap `admin`
- every later new user becomes `reseller`
- existing admin can promote or demote other users
- admin can activate or deactivate other users
- admin cannot deactivate or demote themself

User record key:

- email address

## 4. Pricing, Discounts, and Promotions

### Country detection

Pricing uses request-header country only.

Rules:

- no browser geolocation
- no manual country override
- fallback to USD for non-target countries

### Durations

- client app direct subscribe: `12_months` only
- reseller flow: `6_months` and `12_months`
- gift card batch generation: `6_months` and `12_months`

### Reseller discount

- per-country
- fixed amount or percentage
- applied immediately to reseller checkout price

### Promotions

- can target:
  - app only
  - reseller only
  - both
- can target one or many countries
- multi-country promotions must be percentage-based
- multiple promotions may exist at the same time
- overlapping promotions for the same country and target are invalid
- if both reseller discount and promotion qualify, choose the lower final price
- only one final adjustment applies

## 5. Subscription Flows

### A. Client app direct subscribe

Flow:

1. client app requests 12-month quote
2. app completes payment outside the subscription module
3. backend receives `external_payment_id`
4. backend creates a D1 code record
5. backend redeems that code immediately
6. backend returns signed subscription token

UI expectations in the client app:

- no OAuth
- show direct subscribe buttons for:
  - QR payment
  - card payment
- show only `Subscribed until <date>`
- show generic payment failure message
- after success, refresh subscription status immediately

### B. Reseller purchase flow

Flow:

1. reseller logs in with Google
2. reseller sees local price from request-header country
3. reseller selects duration
4. reseller completes payment
5. backend issues code in D1
6. reseller copies or shares code manually
7. end user redeems code in the client app

Reseller device behavior:

- keep last 10 issued codes locally on device only
- no central reseller history restore

### C. Gift card / prepaid card flow

Flow:

1. admin creates bulk code batch
2. codes are written to D1
3. bulk issuance row is queued and should be appended to the separate gift-card Google Sheet
4. end user redeems code through the same client app code input

Rules:

- admin only
- same short code format as reseller codes
- same redeem function as reseller codes
- admin can attach a simple batch note/label

## 6. Code Design

Code format:

- short human-readable style like `SM-12M-ABCD-EFGH`

Code source markers:

- `direct`
- `reseller`
- `gift_card`

Status behavior:

- code rows remain in D1
- redeemed or expired codes are not deleted, because they are needed to reject reuse
- one code row is updated over time instead of maintaining a large internal history model

## 7. Subscription Token

Client app uses a signed local token as proof of entitlement.

Rules:

- backend returns signed subscription token
- token includes expiry and version marker
- client app stores token locally
- client app backup/restore system is responsible for preserving it
- no backend token validation/refresh endpoint is required for now
- replacement device restore is allowed
- old device does not need to be invalidated

## 8. Admin Dashboard

Main cards:

1. `Subscriptions Sold`
2. `Revenue Total`
3. `Pending Backup Today`
4. `Active Resellers`

Rules:

- dashboard reads long-term reporting from Google Sheets summaries
- dashboard may also show live `pending today` from local queue
- admin can see user country
- admin UI exposes:
  - user management
  - pricing config
  - backup status
  - backup trigger button

## 9. Backup Model

### Regular transaction rows

Regular business rows are queued and sent in the daily batch.

Use final meaningful rows only.

Examples:

- reseller payment succeeded + code issued
- direct subscribe succeeded
- code redeemed

### Bulk gift-card rows

Bulk gift-card issuance belongs to a separate Google Sheets file.

The current backend keeps a local queue and manual backup path for this, with the same unsent-row rule.

### Admin backup controls

Admin UI should show:

- `Last backup at ...`
- `Backup Now`

If scheduled backup fails:

- wait until the next day
- admin may trigger manual backup

## 10. API Surface

### Admin / reseller endpoints

Implemented in [`backend/worker.mjs`](C:\workspace\subscription_server\backend\worker.mjs):

- `/v1/auth/google/start`
- `/v1/auth/google/callback`
- `/v1/auth/refresh`
- `/v1/me`
- `/v1/pricing/quote`
- `/v1/codes/issue`
- `/v1/codes/redeem`
- `/v1/admin/config`
- `/v1/admin/users`
- `/v1/admin/users/{userId}`
- `/v1/admin/reports/summary`
- `/v1/admin/codes`
- `/v1/admin/code-batches`
- `/v1/admin/backup`

### Client app integration endpoints

Documented for the separate app team in [`docs/client-app-integration.md`](C:\workspace\subscription_server\docs\client-app-integration.md):

- `POST /v1/client/subscription/quote`
- `POST /v1/client/subscription/direct`
- `POST /v1/client/subscription/redeem`

## 11. Current Non-Goals

These are not fully implemented yet:

- real payment provider integration
- live Google Sheets API read/write integration
- production deployment of the new Node backend
- client app UI inside this repository

## 12. Reference Note

[`backend/server.mjs`](C:\workspace\subscription_server\backend\server.mjs) remains in the repository as a reference artifact from the temporary server-first refactor, but it is not the target deployment path.
