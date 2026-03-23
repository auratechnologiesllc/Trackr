import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const scriptName = process.argv[2];

if (!scriptName) {
  console.error("Expected an npm script name, for example: node ./scripts/run-with-app-version.mjs build");
  process.exit(1);
}

const packageJsonPath = path.resolve(process.cwd(), "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
const version = String(packageJson.version ?? "").trim();

if (!version) {
  console.error(`Could not read a version from ${packageJsonPath}.`);
  process.exit(1);
}

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const child = spawn(npmCommand, ["run", scriptName], {
  stdio: "inherit",
  env: {
    ...process.env,
    VITE_APP_VERSION: version,
  },
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error(`Failed to run npm script "${scriptName}":`, error);
  process.exit(1);
});
