# Tauri Updater Signing Keys

## Overview
Tauri's updater uses minisign keypairs to verify update integrity. The public key is embedded in `tauri.conf.json` and the private key is used during CI builds to sign update artifacts.

## Current Keys
- **Public key**: Embedded in `src-tauri/tauri.conf.json` under `plugins.updater.pubkey`
- **Private key**: Stored as GitHub Actions secret `TAURI_SIGNING_PRIVATE_KEY`
- **Private key file**: Generated at `/tmp/trackr-updater.key` (copy and store securely)

## GitHub Secrets Required
Set these in the repo settings at: `Settings > Secrets and variables > Actions`

| Secret | Description |
|--------|-------------|
| `TAURI_SIGNING_PRIVATE_KEY` | Full content of the private key file |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for the private key (empty if no password) |
| `APPLE_CERTIFICATE` | Base64-encoded .p12 Developer ID certificate |
| `APPLE_CERTIFICATE_PASSWORD` | Password for the .p12 certificate |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: Aura Technologies LLC (U.S.) (U6S7MR27AK)` |
| `APPLE_ID` | Apple Developer account email |
| `APPLE_PASSWORD` | App-specific password for notarization |
| `APPLE_TEAM_ID` | e.g. `U6S7MR27AK` |

## Generating New Keys
If you ever need to regenerate:

```bash
npx @tauri-apps/cli signer generate --ci -w ~/.tauri/trackr-updater.key
```

Then:
1. Update the `pubkey` in `src-tauri/tauri.conf.json` with the new public key
2. Update the `TAURI_SIGNING_PRIVATE_KEY` GitHub secret with the new private key content
3. **All existing installations will need to reinstall** (old public key won't verify new signatures)

## How It Works
1. `tauri-action` builds the app and creates `.tar.gz` update bundles + `latest.json`
2. The update bundles are signed with the private key
3. On app launch, the frontend calls `check()` which fetches `latest.json` from GitHub Releases
4. If a newer version exists, the user is prompted to download and install
5. The downloaded update is verified against the embedded public key before applying
