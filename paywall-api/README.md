# Trackr Paywall API (Vercel)

This service provides Stripe checkout, payment status polling, entitlement refresh, and Stripe webhook handling for Trackr's desktop paywall.

## Local setup

```bash
cd paywall-api
npm install
npm run dev
```

If `paywall-api/.env` is missing or still contains the example placeholder values, the local server
automatically starts in demo mode. Demo mode serves a local browser checkout page and signs
entitlements with the bundled development key so a fresh download of the repo can still unlock the
desktop app end to end.

To force demo mode explicitly:

```bash
npm run dev:demo
```

To use the real Stripe flow locally instead, copy `.env.example` to `.env` and replace every
placeholder with real values before starting the server.

## Required env vars

- `STRIPE_SECRET_KEY`
- `STRIPE_PRICE_ID`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_CHECKOUT_SUCCESS_URL`
- `STRIPE_CHECKOUT_CANCEL_URL`
- `PAYWALL_ALLOWED_ORIGINS` (or legacy `PAYWALL_ALLOWED_ORIGIN`)
- `ENTITLEMENT_SIGNING_PRIVATE_KEY_PEM`

For Trackr's desktop app, the paywall API should allow both the Tauri dev origin and the packaged
desktop origin so checkout still works from a distributed DMG:

```bash
PAYWALL_ALLOWED_ORIGINS=http://localhost:1420,tauri://localhost,https://tauri.localhost
```

## Public key for the desktop app

Generate the DER base64 public key used by the desktop app build:

`ENTITLEMENT_SIGNING_PRIVATE_KEY_PEM` must be an Ed25519 private key. The Tauri desktop app verifies entitlements with Ed25519 and will reject RSA-backed certificates.

```bash
node -e "const { createPrivateKey, createPublicKey } = require('crypto'); const pem = process.env.ENTITLEMENT_SIGNING_PRIVATE_KEY_PEM.replace(/\\n/g,'\n'); const der = createPublicKey(createPrivateKey(pem)).export({type:'spki',format:'der'}); console.log(Buffer.from(der).toString('base64'));"
```

Set the output as `TRACKR_PAYWALL_PUBLIC_KEY_DER_BASE64` when building the Tauri app.

You can skip this for local demo mode. The desktop app now falls back to the bundled development
public key unless you inject `TRACKR_PAYWALL_PUBLIC_KEY_DER_BASE64` at build time.
