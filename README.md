# Trackr

![Trackr dashboard](./Trackr.png)

Trackr is a desktop activity tracker for macOS and Windows, built with Tauri, Rust, React, and TypeScript. It records keyboard and mouse activity locally, turns that input into active or idle minutes, and visualizes the result as a daily timeline plus a year-long heatmap.

The app is local-first for activity data and uses a separate Stripe-backed paywall API for the one-time device unlock flow.

## What it does

- Runs as a tray-first desktop app.
- Can relaunch automatically at login.
- Tracks global keyboard and mouse activity.
- Marks each minute as active or idle based on activity thresholds.
- Shows a 5-minute timeline for the selected day.
- Shows a GitHub-style heatmap for the last 365 days.
- Supports a configurable sleep window that excludes overnight hours from tracking.
- Lets users share a timeline snapshot to X or Reddit.
- Stores activity and entitlement state on-device.

## Stack

- Frontend: React 19, TypeScript, Vite
- Desktop shell: Tauri 2
- Native tracking layer: Rust
- Payments: Stripe via `paywall-api/`
- Deployment targets: macOS and Windows

## Repository layout

```text
.
├── src/                 # React UI
├── src-tauri/           # Rust app, tray integration, persistence, input tracking
├── paywall-api/         # Stripe checkout + entitlement API
├── scripts/             # Release validation utilities
└── .github/workflows/   # Release automation
```

## Requirements

- macOS or Windows
- Node.js 20+
- npm
- Rust toolchain
- Tauri prerequisites for your target OS
- Xcode Command Line Tools for macOS builds
- Microsoft C++ Build Tools for Windows builds

## Local development

### 1. Install dependencies

```bash
npm install
npm --prefix paywall-api install
```

### 2. Configure frontend env

```bash
cp .env.example .env
```

Default local frontend env:

```bash
VITE_PAYWALL_API_BASE_URL=http://localhost:3010
VITE_APP_VERSION=0.1.0
```

Use the local URL only for development. Production builds must use a public `https://` paywall API URL.

### 3. Configure paywall API env

For a fresh repo download, this step is optional. If `paywall-api/.env` is missing or still contains
the example placeholder values, the local paywall server automatically runs in demo mode so the full
unlock flow still works without Stripe secrets.

```bash
cp paywall-api/.env.example paywall-api/.env
```

Required API variables:

- `STRIPE_SECRET_KEY`
- `STRIPE_PRICE_ID`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_CHECKOUT_SUCCESS_URL`
- `STRIPE_CHECKOUT_CANCEL_URL`
- `PAYWALL_ALLOWED_ORIGINS` (or legacy `PAYWALL_ALLOWED_ORIGIN`)
- `ENTITLEMENT_SIGNING_PRIVATE_KEY_PEM`

For local development and packaged desktop builds, allow both the Tauri dev origin and the packaged
desktop origin:

```bash
PAYWALL_ALLOWED_ORIGINS=http://localhost:1420,tauri://localhost,https://tauri.localhost
```

Without the packaged `tauri://localhost` origin, checkout and entitlement refresh can work in
`tauri dev` but fail from a packaged desktop build on another machine because the public paywall API will reject
the app's production-origin requests.

### 4. Derive the desktop entitlement verification key

The desktop app verifies signed entitlements using `TRACKR_PAYWALL_PUBLIC_KEY_DER_BASE64`.

For local demo mode, you can skip this step. Trackr falls back to a bundled development verification
key so a clean download can still run end to end.

Generate it from `ENTITLEMENT_SIGNING_PRIVATE_KEY_PEM`:

`ENTITLEMENT_SIGNING_PRIVATE_KEY_PEM` must be an Ed25519 private key. The desktop app validates entitlements with `ed25519-dalek`, so RSA keys will build incorrectly and fail at runtime.

```bash
node -e "const { createPrivateKey, createPublicKey } = require('crypto'); const pem = process.env.ENTITLEMENT_SIGNING_PRIVATE_KEY_PEM.replace(/\\n/g, '\n'); const der = createPublicKey(createPrivateKey(pem)).export({ type: 'spki', format: 'der' }); console.log(Buffer.from(der).toString('base64'));"
```

You can still export the result in your shell before running or building the Tauri app:

```bash
export TRACKR_PAYWALL_PUBLIC_KEY_DER_BASE64="MCowBQYDK2VwAyEA..."
```

When you use `npm run tauri ...`, Trackr now also loads `.env` and `paywall-api/.env` automatically
and derives `TRACKR_PAYWALL_PUBLIC_KEY_DER_BASE64` from `ENTITLEMENT_SIGNING_PRIVATE_KEY_PEM` when
that public key is not set explicitly. This keeps the desktop verifier aligned with the local
paywall signer during development.

### 5. Start the paywall API

From the repo root:

```bash
npm run paywall:dev
```

To force the local demo checkout flow even when real Stripe env is present:

```bash
npm run paywall:dev:demo
```

Or directly:

```bash
cd paywall-api
npm run dev
```

### 6. Start the desktop app

```bash
npm run tauri dev
```

In development, the main window opens normally. In production builds, the app is tray-first and hides instead of quitting when the window is closed.

## Available scripts

Root:

- `npm run dev` - start the Vite frontend only
- `npm run build` - build the frontend bundle
- `npm run tauri dev` - run the desktop app in development
- `npm run tauri build` - build the desktop app
- `npm run paywall:dev` - run the paywall API from the root, auto-falling back to local demo mode
- `npm run paywall:dev:demo` - force the local demo paywall flow
- `npm run paywall:test` - run paywall API tests

`paywall-api/`:

- `npm run dev` - watch mode local server
- `npm run dev:demo` - force the local demo paywall flow
- `npm run vercel:dev` - run with Vercel dev server on port `3010`
- `npm run typecheck` - TypeScript typecheck
- `npm run test` - run API tests

## Platform permissions

On macOS, Trackr depends on Input Monitoring access to observe keyboard and mouse activity while
other apps are in front.

Grant macOS permissions in:

- `System Settings > Privacy & Security > Input Monitoring`

If this permission is missing, Trackr stays on a permission-required screen and will not unlock the
dashboard until macOS grants the app background input access.

On Windows, Trackr starts tracking immediately after it is unlocked and running. No separate
permission prompt is required.

No keyboard or mouse activity is recorded before Trackr can capture background input.

Trackr's macOS production bundle targets `10.15+`, which is the first macOS release that provides
the system APIs used for preflighting and requesting event-listening access.

## How activity is measured

- Input is sampled continuously and aggregated by minute.
- A minute becomes active when it crosses either threshold:
  - at least `6` key presses, or
  - at least `150` mouse movement or scroll units
- The UI groups minutes into `5`-minute timeline buckets.
- Sleep-window minutes are excluded from active and idle totals.
- Up to `730` days of history are retained locally.

## Data storage

Trackr stores its local files in the app data directory for `com.rohansingh.trackr`.

Typical app data locations:

```text
macOS:   ~/Library/Application Support/com.rohansingh.trackr/
Windows: %APPDATA%\com.rohansingh.trackr\
```

Files:

- `activity.json` - tracked activity history and sleep window settings
- `paywall_state.json` - local device/paywall state and cached entitlement

## Paywall flow

The desktop app starts locked until it has a valid entitlement for the current device.

`paywall-api/` provides:

- checkout session creation
- payment status polling
- entitlement refresh
- Stripe webhook handling

Once unlocked, Trackr caches the entitlement locally and can continue working offline after setup.

## Building a production app

Before a production build, set:

- `VITE_PAYWALL_API_BASE_URL`
- `TRACKR_PAYWALL_PUBLIC_KEY_DER_BASE64`
Then build:

```bash
CI=true npm run tauri build
```

`CI=true` mainly avoids Finder-based DMG window styling on macOS, and is harmless on Windows.

`tauri build` rejects `localhost` paywall URLs so you do not accidentally ship a packaged app that
points at your own machine.

Build output is generated under:

```text
src-tauri/target/release/bundle/
```

## GitHub release workflow

The repo includes [`release.yml`](./.github/workflows/release.yml), which builds and publishes releases for:

- `aarch64-apple-darwin`
- `x86_64-apple-darwin`
- `x86_64-pc-windows-msvc` (NSIS installer)

The workflow validates release env before building via [`scripts/validate-release-env.mjs`](./scripts/validate-release-env.mjs).

Repository secrets used by the workflow:

- `VITE_PAYWALL_API_BASE_URL`
- `TRACKR_PAYWALL_PUBLIC_KEY_DER_BASE64`
- `APPLE_CERTIFICATE`
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_SIGNING_IDENTITY`
- `APPLE_ID`
- `APPLE_PASSWORD`
- `APPLE_TEAM_ID`

Apple signing secrets are only required for the macOS release jobs.

To publish a release:

1. Bump the app version in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`.
2. Commit and push the version change.
3. Create and push a tag like `v0.2.0`.

## Notes

- Global tracking is implemented for macOS and Windows.
- The frontend falls back to `http://localhost:3010` for the paywall API during local development.
- The app hides on close instead of exiting, matching tray-app behavior.
