#!/usr/bin/env node

// ---------------------------------------------------------------------------
// scripts/release.mjs  --  Build, notarize, and publish a Trackr release
//
// Usage:
//   npm run release -- <version>
//   node scripts/release.mjs 0.2.0
//
// What it does (in order):
//   1. Validates every required env var (Apple certs, signing keys, gh auth)
//   2. Bumps the version in package.json, Cargo.toml, tauri.conf.json
//   3. Installs frontend dependencies
//   4. Builds codesigned DMGs for aarch64 and x86_64
//   5. Notarizes each DMG (notarytool submit --wait -> stapler staple -> stapler validate)
//   6. Stages assets and generates latest.json for the Tauri updater
//   7. Commits the version bump, tags, and pushes
//   8. Creates a GitHub release and uploads all assets
//
// Required environment (set in .env.production.local or export in shell):
//   APPLE_CERTIFICATE                  base64-encoded .p12 Developer ID cert
//   APPLE_CERTIFICATE_PASSWORD         password for the .p12
//   APPLE_SIGNING_IDENTITY             e.g. "Developer ID Application: ..."
//   APPLE_ID                           Apple Developer account email
//   APPLE_PASSWORD                     app-specific password for notarization
//   APPLE_TEAM_ID                      e.g. "U6S7MR27AK"
//   TAURI_SIGNING_PRIVATE_KEY          minisign private key for Tauri updater
//   TAURI_SIGNING_PRIVATE_KEY_PASSWORD password for the signing key (or empty)
//   VITE_PAYWALL_API_BASE_URL          production paywall API (https://)
//   TRACKR_PAYWALL_PUBLIC_KEY_DER_BASE64  or  ENTITLEMENT_SIGNING_PRIVATE_KEY_PEM
// ---------------------------------------------------------------------------

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createPublicKey, createPrivateKey } from "node:crypto";

const ROOT = path.resolve(import.meta.dirname, "..");
const REPO = "auratechnologiesllc/Trackr";
const TARGETS = ["aarch64-apple-darwin", "x86_64-apple-darwin"];

// Maps Rust target triple to Tauri updater platform key.
const UPDATER_PLATFORM = {
  "aarch64-apple-darwin": "darwin-aarch64",
  "x86_64-apple-darwin": "darwin-x86_64",
};

// Maps Rust target triple to the arch suffix Tauri puts in the .tar.gz filename.
const BUNDLE_ARCH_SUFFIX = {
  "aarch64-apple-darwin": "aarch64",
  "x86_64-apple-darwin": "x64",
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function run(cmd, opts = {}) {
  console.log(`  $ ${cmd}`);
  return execSync(cmd, { cwd: ROOT, stdio: "inherit", ...opts });
}

function runCapture(cmd) {
  return execSync(cmd, { cwd: ROOT, encoding: "utf8" }).trim();
}

function fatal(msg) {
  console.error(`\n\x1b[31m✘ ${msg}\x1b[0m`);
  process.exit(1);
}

function step(n, total, msg) {
  console.log(`\n\x1b[36m[${n}/${total}]\x1b[0m ${msg}`);
}

function ok(msg) {
  console.log(`\x1b[32m  ✔ ${msg}\x1b[0m`);
}

// ── .env loading ─────────────────────────────────────────────────────────────

function loadDotenvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const entries = {};
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
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
    entries[key] = value;
  }
  return entries;
}

const dotenvFiles = [".env", ".env.local", ".env.production", ".env.production.local", "paywall-api/.env"];
const dotenv = {};
for (const name of dotenvFiles) {
  Object.assign(dotenv, loadDotenvFile(path.join(ROOT, name)));
}

function env(name) {
  return (process.env[name] ?? dotenv[name] ?? "").trim();
}

// ── Environment validation ───────────────────────────────────────────────────

function validateEnv() {
  const missing = [];

  const required = [
    ["APPLE_CERTIFICATE", "base64 .p12 Developer ID certificate"],
    ["APPLE_CERTIFICATE_PASSWORD", "certificate password"],
    ["APPLE_SIGNING_IDENTITY", "signing identity string"],
    ["APPLE_ID", "Apple Developer account email"],
    ["APPLE_PASSWORD", "app-specific password for notarization"],
    ["APPLE_TEAM_ID", "Apple team ID"],
    ["TAURI_SIGNING_PRIVATE_KEY", "Tauri updater signing private key"],
    ["VITE_PAYWALL_API_BASE_URL", "production paywall API URL"],
  ];

  for (const [name, desc] of required) {
    if (!env(name)) missing.push(`${name}  (${desc})`);
  }

  if (!env("TRACKR_PAYWALL_PUBLIC_KEY_DER_BASE64") && !env("ENTITLEMENT_SIGNING_PRIVATE_KEY_PEM")) {
    missing.push("TRACKR_PAYWALL_PUBLIC_KEY_DER_BASE64 or ENTITLEMENT_SIGNING_PRIVATE_KEY_PEM");
  }

  // gh CLI must be authenticated
  try {
    execSync("gh auth status", { stdio: "pipe" });
  } catch {
    missing.push("gh auth  (run `gh auth login` first)");
  }

  if (missing.length > 0) {
    console.error("\nRelease environment is incomplete:");
    for (const entry of missing) console.error(`  - Missing: ${entry}`);
    fatal("Set the missing variables in .env.production.local or export them, then retry.");
  }
}

// ── Rust target check ────────────────────────────────────────────────────────

function ensureRustTargets() {
  const installed = runCapture("rustup target list --installed");
  for (const target of TARGETS) {
    if (!installed.includes(target)) {
      console.log(`  Installing Rust target ${target}...`);
      run(`rustup target add ${target}`);
    }
  }
}

// ── Version bumping ──────────────────────────────────────────────────────────

function readJSON(relPath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relPath), "utf8"));
}

function writeJSON(relPath, data) {
  fs.writeFileSync(path.join(ROOT, relPath), JSON.stringify(data, null, 2) + "\n");
}

function bumpVersion(newVersion) {
  // package.json
  const pkg = readJSON("package.json");
  const oldVersion = pkg.version;
  pkg.version = newVersion;
  writeJSON("package.json", pkg);
  ok(`package.json  ${oldVersion} -> ${newVersion}`);

  // src-tauri/tauri.conf.json
  const tauriConf = readJSON("src-tauri/tauri.conf.json");
  tauriConf.version = newVersion;
  writeJSON("src-tauri/tauri.conf.json", tauriConf);
  ok(`tauri.conf.json  -> ${newVersion}`);

  // src-tauri/Cargo.toml
  const cargoPath = path.join(ROOT, "src-tauri", "Cargo.toml");
  let cargo = fs.readFileSync(cargoPath, "utf8");
  cargo = cargo.replace(/^(version\s*=\s*")[^"]*(")/m, `$1${newVersion}$2`);
  fs.writeFileSync(cargoPath, cargo);
  ok(`Cargo.toml  -> ${newVersion}`);
}

// ── Build environment ────────────────────────────────────────────────────────

function makeBuildEnv() {
  const buildEnv = { ...process.env };

  // Merge dotenv (process.env takes precedence)
  for (const [k, v] of Object.entries(dotenv)) {
    if (!buildEnv[k]) buildEnv[k] = v;
  }

  // Derive paywall public key from private key if needed
  if (!buildEnv.TRACKR_PAYWALL_PUBLIC_KEY_DER_BASE64 && buildEnv.ENTITLEMENT_SIGNING_PRIVATE_KEY_PEM) {
    const pem = buildEnv.ENTITLEMENT_SIGNING_PRIVATE_KEY_PEM.replace(/\\n/g, "\n");
    const der = createPublicKey(createPrivateKey(pem)).export({ type: "spki", format: "der" });
    buildEnv.TRACKR_PAYWALL_PUBLIC_KEY_DER_BASE64 = Buffer.from(der).toString("base64");
    ok("Derived TRACKR_PAYWALL_PUBLIC_KEY_DER_BASE64 from private key");
  }

  // Force DMG Finder styling in the bundler
  buildEnv.TAURI_BUNDLER_DMG_IGNORE_CI = "true";

  return buildEnv;
}

// ── Build + sign + notarize ──────────────────────────────────────────────────

function buildTarget(target, buildEnv) {
  console.log(`\n  Building ${target}...`);
  run(`npx tauri build --target ${target}`, { env: buildEnv, timeout: 600_000 });
}

// Explicit notarization using xcrun notarytool (the workflow from March 1st).
// Tauri codesigns the .app, but we submit + staple the DMG ourselves to be sure.
function notarizeDmg(dmgPath) {
  const appleId = env("APPLE_ID");
  const password = env("APPLE_PASSWORD");
  const teamId = env("APPLE_TEAM_ID");
  const name = path.basename(dmgPath);

  console.log(`\n  Notarizing ${name}...`);
  run(
    `xcrun notarytool submit "${dmgPath}" --apple-id "${appleId}" --password "${password}" --team-id "${teamId}" --wait`,
    { timeout: 600_000 },
  );
  ok(`${name} notarized by Apple`);

  console.log(`  Stapling notarization ticket...`);
  run(`xcrun stapler staple "${dmgPath}"`);
  ok(`Ticket stapled to ${name}`);

  console.log(`  Validating stapled ticket...`);
  run(`xcrun stapler validate "${dmgPath}"`);
  ok(`${name} validated`);
}

function findArtifacts(target) {
  const bundleDir = path.join(ROOT, "src-tauri", "target", target, "release", "bundle");
  const dmgDir = path.join(bundleDir, "dmg");
  const macosDir = path.join(bundleDir, "macos");

  const dmgFiles = fs.existsSync(dmgDir) ? fs.readdirSync(dmgDir).filter((f) => f.endsWith(".dmg")) : [];
  const tarGzFiles = fs.existsSync(macosDir)
    ? fs.readdirSync(macosDir).filter((f) => f.endsWith(".tar.gz") && !f.endsWith(".sig"))
    : [];
  const sigFiles = fs.existsSync(macosDir) ? fs.readdirSync(macosDir).filter((f) => f.endsWith(".tar.gz.sig")) : [];

  if (dmgFiles.length === 0) fatal(`No DMG found in ${dmgDir}`);

  return {
    dmg: path.join(dmgDir, dmgFiles[0]),
    updateBundle: tarGzFiles.length ? path.join(macosDir, tarGzFiles[0]) : null,
    signature: sigFiles.length ? path.join(macosDir, sigFiles[0]) : null,
  };
}

// ── Staging: copy + rename artifacts for upload ──────────────────────────────

function stageArtifacts(version, tag, buildResults) {
  const stageDir = path.join(ROOT, "src-tauri", "target", "release-stage");
  fs.mkdirSync(stageDir, { recursive: true });

  const assets = [];

  for (const { target, artifacts } of buildResults) {
    const arch = BUNDLE_ARCH_SUFFIX[target];

    // DMG — already has a unique arch-specific name from Tauri
    assets.push(artifacts.dmg);

    // Update bundle — rename to include arch so both targets can coexist
    if (artifacts.updateBundle) {
      const dest = path.join(stageDir, `Trackr_${arch}.app.tar.gz`);
      fs.copyFileSync(artifacts.updateBundle, dest);
      assets.push(dest);
    }

    // Signature — rename to match the update bundle name
    if (artifacts.signature) {
      const dest = path.join(stageDir, `Trackr_${arch}.app.tar.gz.sig`);
      fs.copyFileSync(artifacts.signature, dest);
      assets.push(dest);
    }
  }

  // Generate latest.json for the Tauri updater
  const platforms = {};
  for (const { target, artifacts } of buildResults) {
    if (!artifacts.updateBundle || !artifacts.signature) continue;
    const platformKey = UPDATER_PLATFORM[target];
    const arch = BUNDLE_ARCH_SUFFIX[target];
    const sig = fs.readFileSync(artifacts.signature, "utf8").trim();
    platforms[platformKey] = {
      signature: sig,
      url: `https://github.com/${REPO}/releases/download/${tag}/Trackr_${arch}.app.tar.gz`,
    };
  }

  const latestJson = {
    version,
    notes: `Trackr ${version}`,
    pub_date: new Date().toISOString(),
    platforms,
  };

  const latestJsonPath = path.join(stageDir, "latest.json");
  fs.writeFileSync(latestJsonPath, JSON.stringify(latestJson, null, 2) + "\n");
  assets.push(latestJsonPath);

  return assets;
}

// ── Git operations ───────────────────────────────────────────────────────────

function gitCommitAndTag(version, tag) {
  run("git add package.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json");

  // Check if there are staged changes to commit
  try {
    execSync("git diff --cached --quiet", { cwd: ROOT, stdio: "pipe" });
    console.log("  No version changes to commit (already at this version).");
  } catch {
    run(`git commit -m "release: ${tag}"`);
  }

  // Create annotated tag (fails gracefully if it already exists)
  try {
    run(`git tag -a "${tag}" -m "Trackr ${version}"`);
  } catch {
    console.log(`  Tag ${tag} already exists, reusing it.`);
  }
}

function gitPush(tag) {
  run("git push");
  run(`git push origin "${tag}"`);
}

// ── GitHub release ───────────────────────────────────────────────────────────

function createRelease(tag, version, assets) {
  // Create (or reuse) the release
  try {
    run(
      `gh release create "${tag}" --repo "${REPO}" --title "Trackr ${version}" --notes "See the assets below to download and install Trackr." --latest`,
    );
  } catch {
    console.log(`  Release for ${tag} already exists, uploading assets to it.`);
  }

  // Upload all assets (--clobber overwrites existing files on retry)
  const assetArgs = assets.map((a) => `"${a}"`).join(" ");
  run(`gh release upload "${tag}" ${assetArgs} --repo "${REPO}" --clobber`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const version = process.argv[2];

  if (!version || version === "--help" || version === "-h") {
    console.log(`
Trackr Release Script

Usage:
  npm run release -- <version>
  node scripts/release.mjs <version>

Example:
  npm run release -- 0.2.0

This will:
  1. Validate Apple notarization creds, signing keys, and gh auth
  2. Bump the version across package.json, Cargo.toml, tauri.conf.json
  3. Install dependencies (npm ci)
  4. Build codesigned DMGs for Apple Silicon and Intel
  5. Notarize each DMG (notarytool submit --wait, stapler staple, stapler validate)
  6. Stage assets and generate latest.json for the Tauri updater
  7. Commit the version bump, tag, and push to origin
  8. Create a GitHub release and upload all assets

Required env vars (set in .env.production.local or shell):
  APPLE_CERTIFICATE, APPLE_CERTIFICATE_PASSWORD, APPLE_SIGNING_IDENTITY,
  APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID,
  TAURI_SIGNING_PRIVATE_KEY, TAURI_SIGNING_PRIVATE_KEY_PASSWORD,
  VITE_PAYWALL_API_BASE_URL,
  TRACKR_PAYWALL_PUBLIC_KEY_DER_BASE64 (or ENTITLEMENT_SIGNING_PRIVATE_KEY_PEM)
`);
    process.exit(0);
  }

  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    fatal(`Invalid version "${version}". Use semver: X.Y.Z  (e.g. 0.2.0)`);
  }

  const tag = `v${version}`;
  const TOTAL_STEPS = 8;

  console.log(`\n  Trackr ${version} release\n  ${"─".repeat(40)}`);

  // 1 ──────────────────────────────────────────────────────────────────────
  step(1, TOTAL_STEPS, "Validating release environment");
  validateEnv();
  ensureRustTargets();
  ok("Environment is ready");

  // 2 ──────────────────────────────────────────────────────────────────────
  step(2, TOTAL_STEPS, `Bumping version to ${version}`);
  bumpVersion(version);

  // 3 ──────────────────────────────────────────────────────────────────────
  step(3, TOTAL_STEPS, "Installing dependencies");
  run("npm ci");
  ok("Dependencies installed");

  // 4 ──────────────────────────────────────────────────────────────────────
  step(4, TOTAL_STEPS, "Building and codesigning for both architectures");
  const buildEnv = makeBuildEnv();
  const buildResults = [];

  for (const target of TARGETS) {
    buildTarget(target, buildEnv);
    const artifacts = findArtifacts(target);
    buildResults.push({ target, artifacts });
    ok(`${target}  ->  ${path.basename(artifacts.dmg)}`);
  }

  // 5 ──────────────────────────────────────────────────────────────────────
  step(5, TOTAL_STEPS, "Notarizing DMGs (notarytool submit --wait, stapler staple, stapler validate)");
  for (const { artifacts } of buildResults) {
    notarizeDmg(artifacts.dmg);
  }

  // 6 ──────────────────────────────────────────────────────────────────────
  step(6, TOTAL_STEPS, "Staging assets and generating latest.json");
  const assets = stageArtifacts(version, tag, buildResults);
  ok(`${assets.length} assets staged for upload`);

  for (const a of assets) {
    const size = (fs.statSync(a).size / 1024 / 1024).toFixed(1);
    console.log(`    ${path.basename(a)}  (${size} MB)`);
  }

  // 7 ──────────────────────────────────────────────────────────────────────
  step(7, TOTAL_STEPS, "Committing version bump, tagging, and pushing");
  gitCommitAndTag(version, tag);
  gitPush(tag);
  ok(`Pushed ${tag} to origin`);

  // 8 ──────────────────────────────────────────────────────────────────────
  step(8, TOTAL_STEPS, "Creating GitHub release and uploading assets");
  createRelease(tag, version, assets);
  ok("GitHub release published");

  // Done ───────────────────────────────────────────────────────────────────
  const url = `https://github.com/${REPO}/releases/tag/${tag}`;
  console.log(`
\x1b[32m${"═".repeat(60)}
  Trackr ${version} released successfully!
  ${url}
${"═".repeat(60)}\x1b[0m
`);
}

main();
