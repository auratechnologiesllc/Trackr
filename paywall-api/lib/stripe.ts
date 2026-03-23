import Stripe from "stripe";
import { requireEnv } from "./env.js";

let cachedStripe: Stripe | null = null;

export function stripeClient(): Stripe {
  if (!cachedStripe) {
    cachedStripe = new Stripe(requireEnv("STRIPE_SECRET_KEY"));
  }
  return cachedStripe;
}

export function stripePriceId(): string {
  return requireEnv("STRIPE_PRICE_ID");
}

export function checkoutSuccessUrl(): string {
  return requireEnv("STRIPE_CHECKOUT_SUCCESS_URL");
}

export function checkoutCancelUrl(): string {
  return requireEnv("STRIPE_CHECKOUT_CANCEL_URL");
}
