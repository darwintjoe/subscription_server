# Architecture Flow

This note summarizes how the current repository components relate to each other, and where the implementation differs from the intended production design.

## Component Roles

- `backend/worker.mjs`
  - Cloudflare Worker backend.
  - Exposes the HTTP API for auth callback, pricing, payment intents, payment webhooks, code issue, and code redeem.
- `frontend/reseller`
  - Static reseller-facing test client / PWA.
  - Calls the Worker API directly.
- `frontend/admin`
  - Static admin helper.
  - Currently edits pricing JSON in browser `localStorage` only; it does not call the backend.
- `docs/decoder-install.md`
  - Describes the external client app ("Sell More") integration.
  - That client app is not implemented in this repo.
- `db/schema.sql`
  - Defines the D1 schema for code persistence only.

## Current vs Intended State

- Current implementation:
  - The Worker stores payment intents, issued codes, and redemption state in in-memory maps.
  - D1 is configured in `wrangler.toml` but not actively used by `backend/worker.mjs`.
- Intended production design:
  - The backend should own user identity, roles, pricing, country mapping, and payment logic.
  - D1 should persist only code-related records: codes, redemptions, and bulk batches.

## Flowchart

```mermaid
flowchart LR
    A[Reseller App<br/>frontend/reseller] -->|POST /quote<br/>POST /payments/intents<br/>POST /codes/issue| B[Cloudflare Worker Backend<br/>backend/worker.mjs]
    B -->|JSON responses| A

    D[Admin App<br/>frontend/admin] -->|Local pricing draft only| D2[Browser localStorage]
    D -. manual deploy/config copy .-> B

    C[Client App<br/>Sell More app<br/>described in docs] -->|Receive issued code| B
    C -->|Verify signature with CODE_PUBLIC_JWK| C2[Local verification]
    C -->|POST /codes/redeem| B

    B -->|Code persistence only| E[Cloudflare D1<br/>db/schema.sql]
    E -->|Codes / redemptions / bulk batches| B

    F[Payment Provider Webhook] -->|POST /v1/webhooks/payments/{provider}| B
```

## Practical Read

1. The reseller frontend is the only frontend in this repo that actually exercises the backend API.
2. The admin frontend is a local draft tool, not an integrated admin system.
3. The external client app is expected to verify signed codes locally, then redeem them against the backend.
4. The target boundary is: backend-managed users, roles, pricing, country, and payment state; D1-managed code records only.
5. The current Worker is still a lean prototype and has not been wired to D1 yet.
