import type { VercelRequest, VercelResponse } from "@vercel/node";
import { badRequest, handlePreflight, json, methodNotAllowed, queryParam, serverError } from "../../lib/http.js";
import { getDemoCheckoutSession } from "../../lib/demo-paywall.js";
import { issueEntitlement } from "../../lib/entitlement.js";
import { checkoutSessionIsSettled, checkoutSessionPaymentReference } from "../../lib/checkout-session.js";
import { usingDemoPaywall } from "../../lib/paywall-mode.js";
import { stripeClient } from "../../lib/stripe.js";

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (handlePreflight(req, res)) {
    return;
  }

  if (req.method !== "GET") {
    methodNotAllowed(res, "GET, OPTIONS");
    return;
  }

  const sessionId = queryParam(req.query.sessionId).trim();
  const deviceId = queryParam(req.query.deviceId).trim();

  if (!sessionId || !deviceId) {
    badRequest(res, "sessionId and deviceId are required.");
    return;
  }

  try {
    if (usingDemoPaywall()) {
      const session = getDemoCheckoutSession(sessionId);
      if (!session) {
        json(res, 404, { error: "Checkout session not found." });
        return;
      }

      if (session.deviceId !== deviceId) {
        json(res, 403, { error: "Device mismatch for this checkout session." });
        return;
      }

      if (session.state === "expired") {
        json(res, 200, { status: "expired" });
        return;
      }

      if (session.state !== "paid" || !session.paymentIntentId) {
        json(res, 200, { status: "pending" });
        return;
      }

      const entitlement = issueEntitlement({
        deviceId,
        sessionId: session.sessionId,
        paymentIntentId: session.paymentIntentId,
      });

      json(res, 200, {
        status: "paid",
        entitlement,
      });
      return;
    }

    const stripe = stripeClient();
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["payment_intent", "invoice", "invoice.payments.data.payment.payment_intent"],
    });

    const sessionDeviceId = session.metadata?.device_id ?? "";
    if (!sessionDeviceId || sessionDeviceId !== deviceId) {
      json(res, 403, { error: "Device mismatch for this checkout session." });
      return;
    }

    if (session.status === "expired") {
      json(res, 200, { status: "expired" });
      return;
    }

    if (!checkoutSessionIsSettled(session)) {
      json(res, 200, { status: "pending" });
      return;
    }

    const paymentReference = checkoutSessionPaymentReference(session);
    if (!paymentReference) {
      serverError(res, "Checkout paid but payment reference is missing.");
      return;
    }

    const entitlement = issueEntitlement({
      deviceId,
      sessionId: session.id,
      paymentIntentId: paymentReference,
    });

    json(res, 200, {
      status: "paid",
      entitlement,
    });
  } catch (error) {
    console.error("checkout/status error", error);
    serverError(res);
  }
}
