import type { VercelRequest, VercelResponse } from "@vercel/node";
import { badRequest, handlePreflight, json, methodNotAllowed, requestBaseUrl, serverError } from "../../lib/http.js";
import { startDemoCheckout } from "../../lib/demo-paywall.js";
import { usingDemoPaywall } from "../../lib/paywall-mode.js";
import { checkoutCancelUrl, checkoutSuccessUrl, stripeClient, stripePriceId } from "../../lib/stripe.js";

type CheckoutStartRequest = {
  deviceId?: unknown;
  appVersion?: unknown;
};

function parseRequestBody(body: unknown): CheckoutStartRequest {
  if (typeof body === "string") {
    try {
      return JSON.parse(body) as CheckoutStartRequest;
    } catch {
      return {};
    }
  }
  if (body && typeof body === "object") {
    return body as CheckoutStartRequest;
  }
  return {};
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (handlePreflight(req, res)) {
    return;
  }

  if (req.method !== "POST") {
    methodNotAllowed(res, "POST, OPTIONS");
    return;
  }

  const { deviceId, appVersion } = parseRequestBody(req.body);
  if (typeof deviceId !== "string" || deviceId.trim().length < 8 || deviceId.trim().length > 500) {
    badRequest(res, "deviceId is required.");
    return;
  }

  const safeDeviceId = deviceId.trim();
  const safeAppVersion = typeof appVersion === "string" ? appVersion.trim().slice(0, 64) : "unknown";

  try {
    if (usingDemoPaywall()) {
      json(
        res,
        200,
        startDemoCheckout({
          deviceId: safeDeviceId,
          appVersion: safeAppVersion,
          baseUrl: requestBaseUrl(req),
        }),
      );
      return;
    }

    const stripe = stripeClient();
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{ price: stripePriceId(), quantity: 1 }],
      allow_promotion_codes: true,
      success_url: checkoutSuccessUrl(),
      cancel_url: checkoutCancelUrl(),
      metadata: {
        device_id: safeDeviceId,
        app_version: safeAppVersion,
      },
      payment_intent_data: {
        metadata: {
          trackr_device_id: safeDeviceId,
          trackr_revoked: "false",
          trackr_revoked_reason: "",
        },
      },
    });

    if (!session.url || !session.id || !session.expires_at) {
      serverError(res, "Failed to create checkout session.");
      return;
    }

    json(res, 200, {
      checkoutUrl: session.url,
      sessionId: session.id,
      expiresAtEpochMs: session.expires_at * 1000,
    });
  } catch (error) {
    console.error("checkout/start error", error);
    serverError(res);
  }
}
