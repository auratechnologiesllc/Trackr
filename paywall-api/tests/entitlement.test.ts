import assert from "node:assert/strict";
import { test } from "node:test";
import { createPrivateKey, createPublicKey } from "node:crypto";
import {
  canonicalEntitlementPayload,
  entitlementStatus,
  issueEntitlement,
  signEntitlement,
  verifyEntitlement,
} from "../lib/entitlement.js";

const DEV_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIFAWePtf38OcQT9PWq42pWcAq03amnNVDol+zD/yHBNS
-----END PRIVATE KEY-----`;

test("canonical payload is deterministic", () => {
  const payload = canonicalEntitlementPayload({
    deviceId: "a",
    sessionId: "b",
    paymentIntentId: "c",
    issuedAtEpochMs: 1,
    expiresAtEpochMs: 2,
  });

  assert.equal(payload, "a:b:c:1:2");
});

test("issued entitlement verifies and fails when tampered", () => {
  process.env.ENTITLEMENT_SIGNING_PRIVATE_KEY_PEM = DEV_PRIVATE_KEY;

  const entitlement = issueEntitlement({
    deviceId: "device-123",
    sessionId: "cs_test_123",
    paymentIntentId: "pi_test_123",
    nowEpochMs: Date.now(),
  });

  assert.equal(verifyEntitlement(entitlement), true);

  const tampered = {
    ...entitlement,
    paymentIntentId: "pi_tampered",
  };

  assert.equal(verifyEntitlement(tampered), false);
});

test("entitlementStatus rejects mismatched device", () => {
  process.env.ENTITLEMENT_SIGNING_PRIVATE_KEY_PEM = DEV_PRIVATE_KEY;

  const entitlement = signEntitlement({
    deviceId: "device-abc",
    sessionId: "cs_test_123",
    paymentIntentId: "pi_test_123",
    issuedAtEpochMs: Date.now() - 1000,
    expiresAtEpochMs: Date.now() + 20_000,
  });

  const status = entitlementStatus(entitlement, "another-device");
  assert.equal(status.valid, false);
  assert.equal(status.reason, "device_mismatch");

  const derivedPublicKeyDer = createPublicKey(createPrivateKey(DEV_PRIVATE_KEY)).export({
    type: "spki",
    format: "der",
  });
  assert.ok(Buffer.isBuffer(derivedPublicKeyDer));
});
