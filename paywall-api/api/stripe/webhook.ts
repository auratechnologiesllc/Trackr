import type { VercelRequest, VercelResponse } from "@vercel/node";
import Stripe from "stripe";
import { checkoutSessionPaymentIntentId } from "../../lib/checkout-session.js";
import { requireEnv } from "../../lib/env.js";
import { handlePreflight, json, methodNotAllowed, serverError } from "../../lib/http.js";
import { usingDemoPaywall } from "../../lib/paywall-mode.js";
import { stripeClient } from "../../lib/stripe.js";

export const config = {
  api: {
    bodyParser: false,
  },
};

async function rawBody(req: VercelRequest): Promise<Buffer> {
  const existingBody = (req as { body?: unknown }).body;
  if (Buffer.isBuffer(existingBody)) {
    return existingBody;
  }
  if (typeof existingBody === "string") {
    return Buffer.from(existingBody);
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function markPaymentIntentRevoked(
  stripe: Stripe,
  paymentIntentId: string,
  reason: string,
): Promise<void> {
  const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
  await stripe.paymentIntents.update(paymentIntentId, {
    metadata: {
      ...paymentIntent.metadata,
      trackr_revoked: "true",
      trackr_revoked_reason: reason,
    },
  });
}

export function webhookFailureResponse(error: unknown): {
  statusCode: number;
  message: string;
  logLevel: "warn" | "error";
} {
  if (
    error instanceof Stripe.errors.StripeSignatureVerificationError ||
    (typeof error === "object" &&
      error !== null &&
      "type" in error &&
      error.type === "StripeSignatureVerificationError")
  ) {
    return {
      statusCode: 400,
      message: "Invalid Stripe webhook signature",
      logLevel: "warn",
    };
  }

  return {
    statusCode: 500,
    message: "Internal server error",
    logLevel: "error",
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (handlePreflight(req, res)) {
    return;
  }

  if (req.method !== "POST") {
    methodNotAllowed(res, "POST, OPTIONS");
    return;
  }

  if (usingDemoPaywall()) {
    json(res, 200, { received: true, demo: true });
    return;
  }

  const stripe = stripeClient();

  try {
    const signature = req.headers["stripe-signature"];
    if (!signature || Array.isArray(signature)) {
      json(res, 400, { error: "Missing Stripe signature header" });
      return;
    }

    const payload = await rawBody(req);
    const event = stripe.webhooks.constructEvent(
      payload,
      signature,
      requireEnv("STRIPE_WEBHOOK_SECRET"),
    );

    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const hydratedSession =
          session.invoice && !session.payment_intent
            ? await stripe.checkout.sessions.retrieve(session.id, {
                expand: ["payment_intent", "invoice", "invoice.payments.data.payment.payment_intent"],
              })
            : session;
        const paymentIntentId = checkoutSessionPaymentIntentId(hydratedSession);
        const deviceId = hydratedSession.metadata?.device_id ?? session.metadata?.device_id;

        if (paymentIntentId && deviceId) {
          const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
          await stripe.paymentIntents.update(paymentIntentId, {
            metadata: {
              ...paymentIntent.metadata,
              trackr_device_id: deviceId,
              trackr_revoked: "false",
              trackr_revoked_reason: "",
            },
          });
        }
        break;
      }

      case "charge.refunded": {
        const charge = event.data.object as Stripe.Charge;
        if (charge.payment_intent && typeof charge.payment_intent === "string") {
          await markPaymentIntentRevoked(stripe, charge.payment_intent, "refunded");
        }
        break;
      }

      case "charge.dispute.created": {
        const dispute = event.data.object as Stripe.Dispute;
        if (typeof dispute.payment_intent === "string") {
          await markPaymentIntentRevoked(stripe, dispute.payment_intent, "disputed");
          break;
        }

        if (typeof dispute.charge === "string") {
          const charge = await stripe.charges.retrieve(dispute.charge);
          if (typeof charge.payment_intent === "string") {
            await markPaymentIntentRevoked(stripe, charge.payment_intent, "disputed");
          }
        }
        break;
      }

      default:
        break;
    }

    json(res, 200, { received: true });
  } catch (error) {
    const failure = webhookFailureResponse(error);
    console[failure.logLevel]("stripe/webhook error", error);
    json(res, failure.statusCode, { error: failure.message });
  }
}
