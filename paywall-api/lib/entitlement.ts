import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { requireEnv, normalizePem } from "./env.js";
import { usingDemoPaywall } from "./paywall-mode.js";

const ENTITLEMENT_DURATION_MS = 400 * 24 * 60 * 60 * 1000;
const DEVELOPMENT_ENTITLEMENT_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIFAWePtf38OcQT9PWq42pWcAq03amnNVDol+zD/yHBNS
-----END PRIVATE KEY-----`;

export type EntitlementCertificate = {
  deviceId: string;
  sessionId: string;
  paymentIntentId: string;
  issuedAtEpochMs: number;
  expiresAtEpochMs: number;
  signatureBase64: string;
};

export function canonicalEntitlementPayload(entitlement: Omit<EntitlementCertificate, "signatureBase64">): string {
  return `${entitlement.deviceId}:${entitlement.sessionId}:${entitlement.paymentIntentId}:${entitlement.issuedAtEpochMs}:${entitlement.expiresAtEpochMs}`;
}

function privateKeyPem(): string {
  const configuredKey = process.env.ENTITLEMENT_SIGNING_PRIVATE_KEY_PEM?.trim();
  if (configuredKey) {
    return normalizePem(configuredKey);
  }

  if (usingDemoPaywall()) {
    return DEVELOPMENT_ENTITLEMENT_PRIVATE_KEY_PEM;
  }

  return normalizePem(requireEnv("ENTITLEMENT_SIGNING_PRIVATE_KEY_PEM"));
}

function publicKeyPemFromPrivateKey(): string {
  const privateKey = createPrivateKey(privateKeyPem());
  return createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
}

export function signEntitlement(payload: Omit<EntitlementCertificate, "signatureBase64">): EntitlementCertificate {
  const privateKey = createPrivateKey(privateKeyPem());
  const signature = sign(null, Buffer.from(canonicalEntitlementPayload(payload), "utf8"), privateKey);

  return {
    ...payload,
    signatureBase64: signature.toString("base64"),
  };
}

export function verifyEntitlement(entitlement: EntitlementCertificate): boolean {
  const signature = Buffer.from(entitlement.signatureBase64, "base64");
  const { signatureBase64: _omit, ...unsignedPayload } = entitlement;
  const payload = canonicalEntitlementPayload(unsignedPayload);
  const publicKeyPem = publicKeyPemFromPrivateKey();
  return verify(null, Buffer.from(payload, "utf8"), publicKeyPem, signature);
}

export function issueEntitlement(params: {
  deviceId: string;
  sessionId: string;
  paymentIntentId: string;
  nowEpochMs?: number;
}): EntitlementCertificate {
  const issuedAtEpochMs = params.nowEpochMs ?? Date.now();
  return signEntitlement({
    deviceId: params.deviceId,
    sessionId: params.sessionId,
    paymentIntentId: params.paymentIntentId,
    issuedAtEpochMs,
    expiresAtEpochMs: issuedAtEpochMs + ENTITLEMENT_DURATION_MS,
  });
}

export function entitlementStatus(entitlement: EntitlementCertificate, expectedDeviceId: string): {
  valid: boolean;
  reason?: string;
} {
  if (entitlement.deviceId !== expectedDeviceId) {
    return { valid: false, reason: "device_mismatch" };
  }
  if (entitlement.expiresAtEpochMs <= Date.now()) {
    return { valid: false, reason: "expired" };
  }
  if (!verifyEntitlement(entitlement)) {
    return { valid: false, reason: "invalid_signature" };
  }
  return { valid: true };
}
