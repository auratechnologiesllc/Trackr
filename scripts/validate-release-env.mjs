import fs from "node:fs";
import path from "node:path";
import { createPublicKey } from "node:crypto";

const missing = [];
const errors = [];

function loadDotenvFile(filePath, target) {
  if (!fs.existsSync(filePath)) return;

  const source = fs.readFileSync(filePath, "utf8");
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match) continue;

    let [, key, value] = match;
    value = value.trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    target[key] = value;
  }
}

const dotenvValues = {};
for (const name of [".env", ".env.local", ".env.production", ".env.production.local"]) {
  loadDotenvFile(path.resolve(process.cwd(), name), dotenvValues);
}

function envValue(name) {
  return (process.env[name] ?? dotenvValues[name] ?? "").trim();
}

function requireEnv(name, note) {
  const value = envValue(name);
  if (!value) {
    missing.push(note ? `${name} (${note})` : name);
  }
  return value;
}

function validateReleasePaywallUrl(name) {
  const value = requireEnv(name);
  if (!value) return;

  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const localhostHosts = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

    if (url.protocol !== "https:") {
      errors.push(`${name} must use https:// for release builds.`);
    }

    if (localhostHosts.has(hostname) || hostname.endsWith(".local")) {
      errors.push(`${name} must point to a public paywall API, not ${hostname}.`);
    }
  } catch {
    errors.push(`${name} must be a valid URL.`);
  }
}

function validateEd25519DerPublicKeyBase64(name) {
  const value = requireEnv(name);
  if (!value) return;

  const normalized = value.replace(/\s+/g, "");
  if (normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]+=*$/.test(normalized)) {
    errors.push(`${name} must be valid base64.`);
    return;
  }

  try {
    const publicKey = createPublicKey({
      key: Buffer.from(normalized, "base64"),
      format: "der",
      type: "spki",
    });

    if (publicKey.asymmetricKeyType !== "ed25519") {
      errors.push(`${name} must be an Ed25519 SPKI public key.`);
    }
  } catch {
    errors.push(`${name} must be a valid DER-encoded SPKI public key.`);
  }
}

validateReleasePaywallUrl("VITE_PAYWALL_API_BASE_URL");
validateEd25519DerPublicKeyBase64("TRACKR_PAYWALL_PUBLIC_KEY_DER_BASE64");

if (process.env.GITHUB_ACTIONS === "true" && process.env.RUNNER_OS === "macOS") {
  requireEnv("APPLE_CERTIFICATE", "base64-encoded Developer ID Application certificate");
  requireEnv("APPLE_CERTIFICATE_PASSWORD");
  requireEnv("APPLE_ID");
  requireEnv("APPLE_PASSWORD");
  requireEnv("APPLE_TEAM_ID");
}

if (missing.length > 0 || errors.length > 0) {
  console.error("Release environment is incomplete.");

  for (const entry of missing) {
    console.error(`- Missing ${entry}`);
  }

  for (const entry of errors) {
    console.error(`- ${entry}`);
  }

  process.exit(1);
}

console.log("Release environment looks complete.");
