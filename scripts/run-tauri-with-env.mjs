import { spawn } from "node:child_process";
import { createPrivateKey, createPublicKey } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ENV_FILES = [".env", path.join("paywall-api", ".env")];

function parseEnvFile(filePath) {
  const parsed = new Map();
  const source = fs.readFileSync(filePath, "utf8");

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const withoutExport = line.startsWith("export ") ? line.slice(7) : line;
    const separatorIndex = withoutExport.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = withoutExport.slice(0, separatorIndex).trim();
    let value = withoutExport.slice(separatorIndex + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }

    parsed.set(key, value);
  }

  return parsed;
}

function loadEnvFileIfPresent(env, relativePath) {
  const filePath = path.resolve(process.cwd(), relativePath);
  if (!fs.existsSync(filePath)) {
    return;
  }

  for (const [key, value] of parseEnvFile(filePath)) {
    if (!String(env[key] ?? "").trim()) {
      env[key] = value;
    }
  }
}

function derivePaywallPublicKeyDerBase64(privateKeyPem) {
  const normalizedPem = privateKeyPem.replace(/\\n/g, "\n");
  const der = createPublicKey(createPrivateKey(normalizedPem)).export({
    type: "spki",
    format: "der",
  });
  return Buffer.from(der).toString("base64");
}

function resolveTauriCommand() {
  const commandName = process.platform === "win32" ? "tauri.cmd" : "tauri";
  const bundledBinary = path.resolve(process.cwd(), "node_modules", ".bin", commandName);
  if (fs.existsSync(bundledBinary)) {
    return bundledBinary;
  }

  return commandName;
}

const env = { ...process.env };
for (const envFile of ENV_FILES) {
  loadEnvFileIfPresent(env, envFile);
}

if (
  !String(env.TRACKR_PAYWALL_PUBLIC_KEY_DER_BASE64 ?? "").trim() &&
  String(env.ENTITLEMENT_SIGNING_PRIVATE_KEY_PEM ?? "").trim()
) {
  try {
    env.TRACKR_PAYWALL_PUBLIC_KEY_DER_BASE64 = derivePaywallPublicKeyDerBase64(
      env.ENTITLEMENT_SIGNING_PRIVATE_KEY_PEM,
    );
  } catch (error) {
    console.error("Failed to derive TRACKR_PAYWALL_PUBLIC_KEY_DER_BASE64 from ENTITLEMENT_SIGNING_PRIVATE_KEY_PEM.");
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

const tauriCommand = resolveTauriCommand();
const child = spawn(tauriCommand, process.argv.slice(2), {
  stdio: "inherit",
  env,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error("Failed to launch the Tauri CLI.", error);
  process.exit(1);
});
