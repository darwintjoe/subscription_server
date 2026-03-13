# Client App Integration

This project now exposes a dedicated client-app API surface from the main backend server in [`backend/server.mjs`](C:\workspace\subscription_server\backend\server.mjs).

The client app UI is not built in this repository. The separate app can call these endpoints directly.

## Base URL

Local development:

```text
http://127.0.0.1:3000
```

## Rules

- No OAuth is required for the client app subscription flow.
- Country is detected from the request header on the server side.
- Direct subscribe is always `12_months`.
- Code redeem accepts both reseller codes and gift card codes using the same input field.
- The client app should store the returned `subscription_token` locally and include it in the app's own backup/restore flow.

## Endpoints

### 1. Get direct-subscribe quote

`POST /v1/client/subscription/quote`

Request body:

```json
{}
```

Response:

```json
{
  "country_code": "TH",
  "used_fallback": false,
  "duration_code": "12_months",
  "currency": "THB",
  "amount_minor": 1999,
  "audience": "app",
  "adjustment": null,
  "client_flow": "direct_subscribe"
}
```

Use this to display the 1-year local price in the client app.

### 2. Complete direct subscribe after payment success

`POST /v1/client/subscription/direct`

Request body:

```json
{
  "external_payment_id": "provider-payment-id",
  "payment_method": "qris",
  "currency": "THB",
  "amount_minor": 1999
}
```

Response:

```json
{
  "ok": true,
  "subscription_token": "signed-token",
  "subscribed_until": "2027-03-13T02:00:00.000Z",
  "code_value": "SM-12M-ABCD-EFGH",
  "duration_code": "12_months",
  "redeemed_at": "2026-03-13T02:00:00.000Z"
}
```

Notes:

- The backend still creates a D1 code record for direct subscribe.
- The code is redeemed immediately.
- `subscription_token` is the client app's local proof of entitlement.

### 3. Redeem reseller / gift card code

`POST /v1/client/subscription/redeem`

Request body:

```json
{
  "code_value": "SM-12M-ABCD-EFGH"
}
```

Success response:

```json
{
  "ok": true,
  "code_value": "SM-12M-ABCD-EFGH",
  "duration_code": "12_months",
  "redeemed_at": "2026-03-13T02:00:00.000Z",
  "subscription_token": "signed-token"
}
```

Failure responses:

- `404 {"error":"code_not_found"}`
- `409 {"error":"already_redeemed"}`
- `409 {"error":"expired_code"}`
- `409 {"error":"invalid_code_format"}`

## Client-side storage guidance

The client app should:

1. Save `subscription_token` in persistent local storage.
2. Derive and display `Subscribed until <date>` from the token expiry or server response.
3. Include that token in the app's own backup/restore mechanism.

No backend token refresh/validation endpoint is required for the current agreed design.
