import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  completeDemoCheckoutSession,
  getDemoCheckoutSession,
  startDemoCheckout,
} from "../lib/demo-paywall.js";
import { issueEntitlement, verifyEntitlement } from "../lib/entitlement.js";
import { paywallMode } from "../lib/paywall-mode.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

test("paywallMode falls back to demo when Stripe env is missing or placeholder-only", () => {
  process.env = {
    ...ORIGINAL_ENV,
    NODE_ENV: "development",
    TRACKR_PAYWALL_MODE: "",
    STRIPE_SECRET_KEY: "sk_test_replace_me",
    STRIPE_PRICE_ID: "price_replace_me",
    STRIPE_WEBHOOK_SECRET: "whsec_replace_me",
    STRIPE_CHECKOUT_SUCCESS_URL: "https://example.com/trackr-paid",
    STRIPE_CHECKOUT_CANCEL_URL: "https://example.com/trackr-cancelled",
    ENTITLEMENT_SIGNING_PRIVATE_KEY_PEM:
      '"-----BEGIN PRIVATE KEY-----\\nREPLACE_WITH_YOUR_PRIVATE_KEY\\n-----END PRIVATE KEY-----"',
  };
  delete process.env.VERCEL;

  assert.equal(paywallMode(), "demo");
});

test("demo checkout can be completed locally and issues a verifiable entitlement", () => {
  process.env = {
    ...ORIGINAL_ENV,
    NODE_ENV: "development",
    TRACKR_PAYWALL_MODE: "demo",
  };
  delete process.env.ENTITLEMENT_SIGNING_PRIVATE_KEY_PEM;

  const started = startDemoCheckout({
    deviceId: "device-123",
    appVersion: "0.1.0",
    baseUrl: "http://localhost:3010",
    nowEpochMs: 1_000,
  });

  const pending = getDemoCheckoutSession(started.sessionId, 1_500);
  assert.ok(pending);
  assert.equal(pending.state, "pending");

  const completed = completeDemoCheckoutSession(started.sessionId, 2_000);
  assert.ok(completed);
  assert.equal(completed.state, "paid");
  assert.match(completed.paymentIntentId ?? "", /^pi_demo_/);

  const entitlement = issueEntitlement({
    deviceId: "device-123",
    sessionId: completed.sessionId,
    paymentIntentId: completed.paymentIntentId ?? "",
    nowEpochMs: 2_000,
  });

  assert.equal(verifyEntitlement(entitlement), true);
});
