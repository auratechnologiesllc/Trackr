import Stripe from "stripe";

export const CHECKOUT_SESSION_PAYMENT_REFERENCE_PREFIX = "checkout_session:";

type CheckoutInvoicePayment = Stripe.InvoicePayment & {
  payment?: Stripe.InvoicePayment.Payment | null;
};

type CheckoutInvoice = Stripe.Invoice & {
  payments?: Stripe.ApiList<CheckoutInvoicePayment> | null;
};

type CheckoutSessionLike = Pick<
  Stripe.Checkout.Session,
  "id" | "payment_intent" | "invoice" | "payment_status" | "amount_total"
>;

function paymentIntentIdFromValue(
  paymentIntent: string | Stripe.PaymentIntent | null | undefined,
): string | null {
  if (!paymentIntent) {
    return null;
  }

  return typeof paymentIntent === "string" ? paymentIntent : paymentIntent.id;
}

function paymentIntentIdFromInvoice(invoice: string | CheckoutInvoice | null): string | null {
  if (!invoice || typeof invoice === "string") {
    return null;
  }

  for (const invoicePayment of invoice.payments?.data ?? []) {
    const paymentIntentId = paymentIntentIdFromValue(invoicePayment.payment?.payment_intent);
    if (paymentIntentId) {
      return paymentIntentId;
    }
  }

  return null;
}

export function checkoutSessionIsSettled(session: CheckoutSessionLike): boolean {
  return (
    session.payment_status === "paid" ||
    (session.payment_status === "no_payment_required" && (session.amount_total ?? 0) === 0)
  );
}

export function checkoutSessionPaymentIntentId(session: CheckoutSessionLike): string | null {
  const paymentIntentId = paymentIntentIdFromValue(session.payment_intent);
  if (paymentIntentId) {
    return paymentIntentId;
  }

  const invoicePaymentIntentId = paymentIntentIdFromInvoice(session.invoice as string | CheckoutInvoice | null);
  if (invoicePaymentIntentId) {
    return invoicePaymentIntentId;
  }

  return null;
}

export function checkoutSessionPaymentReference(session: CheckoutSessionLike): string | null {
  const paymentIntentId = checkoutSessionPaymentIntentId(session);
  if (paymentIntentId) {
    return paymentIntentId;
  }

  // Stripe can complete a zero-total Checkout Session without creating a PaymentIntent.
  if (checkoutSessionIsSettled(session) && (session.amount_total ?? 0) === 0) {
    return `${CHECKOUT_SESSION_PAYMENT_REFERENCE_PREFIX}${session.id}`;
  }

  return null;
}

export function checkoutSessionIdFromPaymentReference(paymentReference: string): string | null {
  if (!paymentReference.startsWith(CHECKOUT_SESSION_PAYMENT_REFERENCE_PREFIX)) {
    return null;
  }

  const sessionId = paymentReference.slice(CHECKOUT_SESSION_PAYMENT_REFERENCE_PREFIX.length).trim();
  return sessionId || null;
}
