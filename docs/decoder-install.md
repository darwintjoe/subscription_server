# Sell More Client Integration: Decoder + Public Key

## Goal
Verify Subscription Server-issued codes in Sell More app, while keeping signing private key only on Subscription Server.

## Keys
- `CODE_PRIVATE_JWK`: kept in Worker secret only.
- `CODE_PUBLIC_JWK`: copied to Sell More client app config.

## Installation Steps
1. Generate ECDSA P-256 keypair (JWK format).
2. Save private JWK in Worker secret:
   - `wrangler secret put CODE_PRIVATE_JWK`
3. Put public JWK in Sell More app secure config (read-only constant per app release).
4. Implement verify function in Sell More app:
   - Parse `code_value` as `<payloadB64url>.<signatureB64url>`.
   - Verify signature against `CODE_PUBLIC_JWK` using WebCrypto ECDSA P-256 SHA-256.
   - Decode payload claims (`code_id`, `duration_code`, `flow_type`, `exp`, `payment_ref`).
5. Always call server redeem endpoint as source-of-truth one-time check:
   - `POST /v1/codes/redeem`.

## Rotation
- Create new keypair.
- Deploy new private key to Worker.
- Publish new public key in next Sell More release.
- During transition, support two public keys (current + previous) in Sell More verify routine.

## Security Notes
- Never embed private key in Sell More app.
- Never mark local verification as final activation without server redeem response.
- If signature fails or exp passed, reject before redeem call.
