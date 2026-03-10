# Subscription Server v1 Technical Specification

## 1) Scope and Goals

This document defines v1 architecture, data model, and API contract for a standalone **Subscription Server** with:

- Google OAuth authentication.
- Role-based access: **Admin** and **Reseller**.
- Localized country pricing with fallback.
- Subscription code generation + activation flows.
- One-time-use redemption codes.
- Payment orchestration for QRIS/Card.
- Cloudflare D1 for code-related persistence only.
- Google Sheets append-only operational history (yearly file, monthly tab).
- Basic abuse controls (rate limiting and anti-abuse checks).

Out of scope for this version:

- Final payment provider routing policy by country (Xendit vs Stripe precedence).
- Production IaC specifics.

## 2) High-Level Architecture

### Components

1. **Frontend PWA**
   - Single app with role-aware UI.
   - Reseller workflows: price quote → payment intent → code issue.
   - Admin workflows: pricing/policy management, reseller oversight, reporting, printed-card batches.

2. **Subscription API (Cloudflare Worker)**
   - REST API + webhook endpoints.
   - JWT session management after Google OAuth.
   - Code issuance, reservation, redemption.
   - Payment intent lifecycle and webhook reconciliation.

3. **Cloudflare D1 (SQLite-compatible)**
   - Source of truth for code issuance, redemption, and bulk code batches.
   - User identity, roles, pricing, country mapping, payment state, and operational controls stay in the backend layer.

4. **Google Sheets Append Service**
   - Async worker task that appends immutable transaction history rows.
   - Naming pattern: `subscription-history-YYYY` spreadsheet, tabs `01`..`12`.

5. **Payment Providers**
   - Unified abstraction layer (`/payments/intents`).
   - Methods in v1: QRIS, Card.

## 3) Authentication and Authorization

## Google OAuth

- Use Google OpenID Connect.
- Store Google subject (`sub`) as immutable external identity key in the backend identity layer.
- On first successful sign-in:
  - Create or update backend-managed user state.
  - Default role assignment = `reseller`.
- Admin role is assigned only by existing admin (or initial seed script).

## Session model

- Server-issued JWT (short-lived access token + refresh token pair).
- Refresh token rotation is handled in the backend layer.

## RBAC

- `admin` permissions:
  - Manage pricing tables and fallback prices.
  - Manage user roles.
  - View all transactions/reconciliations.
  - Create bulk code batches.
- `reseller` permissions:
  - Read effective pricing for own location.
  - Create payment intents and issue codes for permitted products.
  - Redeem / activate only via scoped flows.

## 4) Pricing and Location

## Country detection

- Determine country from device/network geolocation in request context.
- If country unknown/unlisted => fallback `USD 99 / year`.

## Pricing structure

- Pricing is stored in Cloudflare Worker static config (local configuration), not in D1.
- Supported durations in v1: `6_months`, `12_months`.
- Route 1 (Direct Subscribe) and Route 2 (Reseller) both allow `6_months` and `12_months` selection.
- Editable default prices in config:

### 12 months
- ID: 999,000 IDR
- VN: 999,000 VND
- TH: 1,999 THB
- MY: 299 MYR
- MM: 49,000 MMK
- Fallback: 99 USD

### 6 months
- ID: 699,000 IDR
- VN: 699,000 VND
- TH: 1,499 THB
- MY: 199 MYR
- MM: 29,000 MMK
- Fallback: 69 USD

## Quoting rule

- Resolve `country_code` from request context.
- Lookup `(country_code, duration_code)` in Worker config.
- If no country price exists, use fallback price for that duration from Worker config.

## 5) Subscription Code Flows

## A) Direct Subscribe from Sell More app

- User selects 6 or 12 months from the app payment flow.
- Code is generated and immediately redeemed in one transaction.
- No pre-redeem expiry applied.
- Atomic flow:
  1. Payment confirmed.
  2. Code generated with `status=reserved`.
  3. Code redeemed immediately (`status=redeemed`, `redeemed_at=now`).

## B) Reseller-generated code (not immediately redeemed)

- Code generated after successful payment.
- Must include **30-day redemption expiry**.
- On redemption attempt past expiry => reject with `CODE_EXPIRED`.

## C) Bulk pre-generated printed cards

- Batch generation with fixed **12-month redemption expiry** from issuance.
- Each card still one-time redeemable.
- Batch metadata tracks issuer, quantity, and distribution notes.

## One-time-use enforcement

- `codes.status` transition allowed once from `issued|reserved` -> `redeemed`.
- Enforced via conditional update in single SQL statement.

## 6) Payments

## Intent lifecycle

States: `created -> pending -> paid | failed | expired | canceled`

- Client requests intent with amount/currency/method.
- Server creates provider intent and stores canonical record.
- Provider webhook updates final status.
- Code issuance requires `paid` state + idempotency key.

## Methods in v1

- `qris`
- `card`

Provider selection algorithm is pluggable and country-aware.

## 7) Abuse Protection (v1)

1. **IP + user rate limiting**
   - Token bucket per route group (`auth`, `quote`, `payment`, `redeem`).
2. **Idempotency keys**
   - Required for create-payment-intent and issue-code endpoints.
3. **Replay prevention**
   - Nonce/timestamp validation for sensitive callbacks.
4. **Webhook signature verification**
   - Per provider secret.
5. **Suspicion flags**
   - Repeated failures trigger soft lock and admin review.

## 8) Google Sheets Append History

## Record strategy

- Append-only rows; no updates/deletes.
- Write after transactional commit via async job queue.
- Retry with backoff; deduplicate by `event_id`.

## Destination

- Spreadsheet: `subscription-history-<YYYY>`
- Sheet/tab: `<MM>` (e.g., `03`)

## Minimum columns

- `event_id`, `event_time_utc`, `order_id`, `payment_intent_id`, `code_id`, `flow_type`,
  `actor_user_id`, `actor_role`, `country`, `currency`, `amount_minor`, `status`,
  `provider`, `provider_ref`, `notes`.

## 9) Concurrency and Data Integrity (D1)

- Use explicit transactions for code state transitions.
- Unique constraints for business-critical invariants:
  - Unique code value.
  - Single redemption event per code.
- Optimistic checks via `updated_at`/state conditions.

## 10) Operational bootstrap

- Admin seed via one-time CLI/Worker secret:
  - `ADMIN_SEED_EMAILS` environment variable.
  - On login, if email in seed list and no admins exist, assign `admin`.
- Disable seed path after first admin assignment.

## 11) API summary

Detailed endpoints and schemas are defined in `api/openapi.yaml`.

## 12) Schema summary

DDL and indexes are defined in `db/schema.sql`.
