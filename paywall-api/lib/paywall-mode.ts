const REQUIRED_STRIPE_ENV_NAMES = [
  "STRIPE_SECRET_KEY",
  "STRIPE_PRICE_ID",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_CHECKOUT_SUCCESS_URL",
  "STRIPE_CHECKOUT_CANCEL_URL",
  "ENTITLEMENT_SIGNING_PRIVATE_KEY_PEM",
] as const;

export type PaywallMode = "demo" | "stripe";

function looksUnconfigured(value: string | undefined): boolean {
  const trimmed = value?.trim();
  if (!trimmed) return true;

  return /replace_me|REPLACE_WITH_YOUR_PRIVATE_KEY|example\.com/i.test(trimmed);
}

export function missingStripeRuntimeConfig(): string[] {
  return REQUIRED_STRIPE_ENV_NAMES.filter((name) => looksUnconfigured(process.env[name]));
}

export function paywallMode(): PaywallMode {
  const explicitMode = process.env.TRACKR_PAYWALL_MODE?.trim().toLowerCase();
  if (explicitMode === "demo" || explicitMode === "stripe") {
    return explicitMode;
  }

  if (missingStripeRuntimeConfig().length === 0) {
    return "stripe";
  }

  if (process.env.VERCEL || process.env.NODE_ENV === "production") {
    return "stripe";
  }

  return "demo";
}

export function usingDemoPaywall(): boolean {
  return paywallMode() === "demo";
}

export function paywallModeSummary(): string {
  if (!usingDemoPaywall()) {
    return "stripe mode";
  }

  const explicitMode = process.env.TRACKR_PAYWALL_MODE?.trim().toLowerCase();
  if (explicitMode === "demo") {
    return "demo mode (forced by TRACKR_PAYWALL_MODE=demo)";
  }

  const missing = missingStripeRuntimeConfig();
  return `demo mode (missing ${missing.join(", ")})`;
}
