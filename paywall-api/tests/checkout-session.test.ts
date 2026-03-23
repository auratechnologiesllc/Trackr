import assert from "node:assert/strict";
import { test } from "node:test";
import Stripe from "stripe";
import {
  CHECKOUT_SESSION_PAYMENT_REFERENCE_PREFIX,
  checkoutSessionIsSettled,
  checkoutSessionIdFromPaymentReference,
  checkoutSessionPaymentIntentId,
  checkoutSessionPaymentReference,
} from "../lib/checkout-session.js";

function invoicePayment(paymentIntent: string | Stripe.PaymentIntent): Stripe.InvoicePayment {
  return {
    id: "ipmt_123",
    object: "invoice_payment",
    amount_paid: 199,
    amount_requested: 199,
    created: 0,
    currency: "usd",
    invoice: "in_live_123",
    is_default: true,
    livemode: false,
    payment: {
      type: "payment_intent",
      payment_intent: paymentIntent,
    },
    status: "paid",
    status_transitions: {
      canceled_at: null,
      paid_at: 0,
    },
  };
}

test("checkoutSessionPaymentReference returns the payment intent when present", () => {
  const reference = checkoutSessionPaymentReference({
    id: "cs_live_123",
    payment_intent: "pi_live_123",
    invoice: null,
    payment_status: "paid",
    amount_total: 199,
  });

  assert.equal(reference, "pi_live_123");
});

test("checkoutSessionPaymentIntentId returns null when there is no direct or invoice-backed payment intent", () => {
  const paymentIntentId = checkoutSessionPaymentIntentId({
    id: "cs_live_123",
    payment_intent: null,
    invoice: null,
    payment_status: "paid",
    amount_total: 199,
  });

  assert.equal(paymentIntentId, null);
});

test("checkoutSessionPaymentIntentId prefers the invoice payment mapping when the session lacks one", () => {
  const paymentIntentId = checkoutSessionPaymentIntentId({
    id: "cs_live_123",
    payment_intent: null,
    invoice: {
      id: "in_live_123",
      object: "invoice",
      payments: {
        object: "list",
        data: [invoicePayment("pi_invoice_123")],
        has_more: false,
        url: "/v1/invoice_payments",
      },
    } as unknown as Stripe.Invoice,
    payment_status: "paid",
    amount_total: 199,
  });

  assert.equal(paymentIntentId, "pi_invoice_123");
});

test("checkoutSessionPaymentReference supports zero-total paid sessions", () => {
  const reference = checkoutSessionPaymentReference({
    id: "cs_live_123",
    payment_intent: null,
    invoice: null,
    payment_status: "paid",
    amount_total: 0,
  });

  assert.equal(reference, `${CHECKOUT_SESSION_PAYMENT_REFERENCE_PREFIX}cs_live_123`);
});

test("checkoutSessionPaymentReference supports zero-total no-payment-required sessions", () => {
  const reference = checkoutSessionPaymentReference({
    id: "cs_live_123",
    payment_intent: null,
    invoice: null,
    payment_status: "no_payment_required",
    amount_total: 0,
  });

  assert.equal(reference, `${CHECKOUT_SESSION_PAYMENT_REFERENCE_PREFIX}cs_live_123`);
});

test("checkoutSessionPaymentReference keeps the zero-total fallback when the invoice has no payment mapping", () => {
  const reference = checkoutSessionPaymentReference({
    id: "cs_live_123",
    payment_intent: null,
    invoice: {
      id: "in_live_123",
      object: "invoice",
      payments: {
        object: "list",
        data: [],
        has_more: false,
        url: "/v1/invoice_payments",
      },
    } as unknown as Stripe.Invoice,
    amount_total: 0,
    payment_status: "paid",
  });

  assert.equal(reference, `${CHECKOUT_SESSION_PAYMENT_REFERENCE_PREFIX}cs_live_123`);
});

test("checkoutSessionPaymentReference returns null when a non-zero session has no usable payment reference", () => {
  const reference = checkoutSessionPaymentReference({
    id: "cs_live_123",
    payment_intent: null,
    invoice: {
      id: "in_live_123",
      object: "invoice",
      payments: {
        object: "list",
        data: [],
        has_more: false,
        url: "/v1/invoice_payments",
      },
    } as unknown as Stripe.Invoice,
    amount_total: 199,
    payment_status: "paid",
  });

  assert.equal(reference, null);
});

test("checkoutSessionIsSettled accepts zero-total no-payment-required sessions", () => {
  assert.equal(
    checkoutSessionIsSettled({
      id: "cs_live_123",
      payment_intent: null,
      invoice: null,
      payment_status: "no_payment_required",
      amount_total: 0,
    }),
    true,
  );
});

test("checkoutSessionIsSettled rejects non-zero no-payment-required sessions", () => {
  assert.equal(
    checkoutSessionIsSettled({
      id: "cs_live_123",
      payment_intent: null,
      invoice: null,
      payment_status: "no_payment_required",
      amount_total: 199,
    }),
    false,
  );
});

test("checkoutSessionIdFromPaymentReference parses checkout-session-backed entitlements", () => {
  const sessionId = checkoutSessionIdFromPaymentReference(
    `${CHECKOUT_SESSION_PAYMENT_REFERENCE_PREFIX}cs_live_123`,
  );

  assert.equal(sessionId, "cs_live_123");
  assert.equal(checkoutSessionIdFromPaymentReference("pi_live_123"), null);
});
