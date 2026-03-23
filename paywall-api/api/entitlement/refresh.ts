import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  EntitlementCertificate,
  entitlementStatus,
  issueEntitlement,
} from "../../lib/entitlement.js";
import {
  checkoutSessionIdFromPaymentReference,
  checkoutSessionIsSettled,
  checkoutSessionPaymentReference,
} from "../../lib/checkout-session.js";
import { badRequest, handlePreflight, json, methodNotAllowed, serverError } from "../../lib/http.js";
import { usingDemoPaywall } from "../../lib/paywall-mode.js";
import { stripeClient } from "../../lib/stripe.js";

const PAYWALL_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

type RefreshRequestBody = {
  deviceId?: unknown;
  entitlement?: unknown;
};

function parseBody(body: unknown): RefreshRequestBody {
  if (typeof body === "string") {
    try {
      return JSON.parse(body) as RefreshRequestBody;
    } catch {
      return {};
    }
  }
  if (body && typeof body === "object") {
    return body as RefreshRequestBody;
  }
  return {};
}

function asEntitlement(value: unknown): EntitlementCertificate | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const entitlement = value as Partial<EntitlementCertificate>;
  if (
    typeof entitlement.deviceId !== "string" ||
    typeof entitlement.sessionId !== "string" ||
    typeof entitlement.paymentIntentId !== "string" ||
    typeof entitlement.issuedAtEpochMs !== "number" ||
    typeof entitlement.expiresAtEpochMs !== "number" ||
    typeof entitlement.signatureBase64 !== "string"
  ) {
    return null;
  }

  return entitlement as EntitlementCertificate;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (handlePreflight(req, res)) {
    return;
  }

  if (req.method !== "POST") {
    methodNotAllowed(res, "POST, OPTIONS");
    return;
  }

  const body = parseBody(req.body);
  if (typeof body.deviceId !== "string" || !body.deviceId.trim()) {
    badRequest(res, "deviceId is required.");
    return;
  }

  const deviceId = body.deviceId.trim();
  const entitlement = asEntitlement(body.entitlement);
  if (!entitlement) {
    badRequest(res, "entitlement payload is invalid.");
    return;
  }

  const entitlementVerification = entitlementStatus(entitlement, deviceId);
  if (!entitlementVerification.valid) {
    json(res, 200, {
      status: "revoked",
      reason: entitlementVerification.reason ?? "invalid_entitlement",
    });
    return;
  }

  try {
    if (usingDemoPaywall()) {
      json(res, 200, {
        status: "active",
        entitlement: issueEntitlement({
          deviceId,
          sessionId: entitlement.sessionId,
          paymentIntentId: entitlement.paymentIntentId,
        }),
        nextSyncAtEpochMs: Date.now() + PAYWALL_SYNC_INTERVAL_MS,
      });
      return;
    }

    const stripe = stripeClient();
    const zeroTotalCheckoutSessionId = checkoutSessionIdFromPaymentReference(
      entitlement.paymentIntentId,
    );

    if (zeroTotalCheckoutSessionId) {
      const session = await stripe.checkout.sessions.retrieve(zeroTotalCheckoutSessionId, {
        expand: ["payment_intent", "invoice", "invoice.payments.data.payment.payment_intent"],
      });

      if (session.status !== "complete" || !checkoutSessionIsSettled(session)) {
        json(res, 200, { status: "revoked", reason: "payment_not_succeeded" });
        return;
      }

      if (session.metadata?.device_id && session.metadata.device_id !== deviceId) {
        json(res, 200, { status: "revoked", reason: "device_mismatch" });
        return;
      }

      const paymentReference =
        checkoutSessionPaymentReference(session) ?? entitlement.paymentIntentId;

      const rotatedEntitlement = issueEntitlement({
        deviceId,
        sessionId: entitlement.sessionId,
        paymentIntentId: paymentReference,
      });

      json(res, 200, {
        status: "active",
        entitlement: rotatedEntitlement,
        nextSyncAtEpochMs: Date.now() + PAYWALL_SYNC_INTERVAL_MS,
      });
      return;
    }

    const paymentIntent = await stripe.paymentIntents.retrieve(entitlement.paymentIntentId);

    if (paymentIntent.status !== "succeeded") {
      json(res, 200, { status: "revoked", reason: "payment_not_succeeded" });
      return;
    }

    if (
      paymentIntent.metadata?.trackr_device_id &&
      paymentIntent.metadata.trackr_device_id !== deviceId
    ) {
      json(res, 200, { status: "revoked", reason: "device_mismatch" });
      return;
    }

    if (paymentIntent.metadata?.trackr_revoked === "true") {
      json(res, 200, {
        status: "revoked",
        reason: paymentIntent.metadata.trackr_revoked_reason || "revoked",
      });
      return;
    }

    const charges = await stripe.charges.list({ payment_intent: paymentIntent.id, limit: 5 });
    const hasRefundOrDispute = charges.data.some((charge) => charge.refunded || charge.disputed);
    if (hasRefundOrDispute) {
      await stripe.paymentIntents.update(paymentIntent.id, {
        metadata: {
          ...paymentIntent.metadata,
          trackr_device_id: deviceId,
          trackr_revoked: "true",
          trackr_revoked_reason: "refund_or_dispute",
        },
      });

      json(res, 200, { status: "revoked", reason: "refund_or_dispute" });
      return;
    }

    const rotatedEntitlement = issueEntitlement({
      deviceId,
      sessionId: entitlement.sessionId,
      paymentIntentId: paymentIntent.id,
    });

    if (paymentIntent.metadata?.trackr_device_id !== deviceId) {
      await stripe.paymentIntents.update(paymentIntent.id, {
        metadata: {
          ...paymentIntent.metadata,
          trackr_device_id: deviceId,
          trackr_revoked: "false",
          trackr_revoked_reason: "",
        },
      });
    }

    json(res, 200, {
      status: "active",
      entitlement: rotatedEntitlement,
      nextSyncAtEpochMs: Date.now() + PAYWALL_SYNC_INTERVAL_MS,
    });
  } catch (error) {
    console.error("entitlement/refresh error", error);
    serverError(res);
  }
}
