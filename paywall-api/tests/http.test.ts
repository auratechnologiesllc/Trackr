import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { resolveCorsOrigin } from "../lib/http.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

test("defaults allow the packaged Trackr origins and local dev", () => {
  delete process.env.PAYWALL_ALLOWED_ORIGIN;
  delete process.env.PAYWALL_ALLOWED_ORIGINS;

  assert.equal(resolveCorsOrigin("http://localhost:1420"), "http://localhost:1420");
  assert.equal(resolveCorsOrigin("tauri://localhost"), "tauri://localhost");
  assert.equal(resolveCorsOrigin("https://tauri.localhost"), "https://tauri.localhost");
});

test("configured origins are merged with the default desktop allowlist", () => {
  process.env.PAYWALL_ALLOWED_ORIGIN = "https://app.trackr.bar";

  assert.equal(resolveCorsOrigin("https://app.trackr.bar"), "https://app.trackr.bar");
  assert.equal(resolveCorsOrigin("tauri://localhost"), "tauri://localhost");
  assert.equal(resolveCorsOrigin("https://example.com"), null);
});

test("PAYWALL_ALLOWED_ORIGINS accepts comma-separated values", () => {
  process.env.PAYWALL_ALLOWED_ORIGINS =
    "https://app.trackr.bar, https://staging.trackr.bar";
  delete process.env.PAYWALL_ALLOWED_ORIGIN;

  assert.equal(resolveCorsOrigin("https://app.trackr.bar"), "https://app.trackr.bar");
  assert.equal(resolveCorsOrigin("https://staging.trackr.bar"), "https://staging.trackr.bar");
});

test("wildcard configuration still allows every origin", () => {
  process.env.PAYWALL_ALLOWED_ORIGIN = "*";

  assert.equal(resolveCorsOrigin("https://example.com"), "*");
  assert.equal(resolveCorsOrigin(undefined), "*");
});
