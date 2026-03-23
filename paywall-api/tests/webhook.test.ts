import assert from "node:assert/strict";
import { test } from "node:test";
import Stripe from "stripe";
import { webhookFailureResponse } from "../api/stripe/webhook.js";

test("webhookFailureResponse maps invalid Stripe signatures to a 400", () => {
  const stripe = new Stripe("sk_test_123");

  let thrown: unknown;
  try {
    stripe.webhooks.constructEvent("{}", "t=1,v1=invalid", "whsec_test");
  } catch (error) {
    thrown = error;
  }

  const failure = webhookFailureResponse(thrown);
  assert.equal(failure.statusCode, 400);
  assert.equal(failure.message, "Invalid Stripe webhook signature");
  assert.equal(failure.logLevel, "warn");
});

test("webhookFailureResponse keeps unexpected failures as 500s", () => {
  const failure = webhookFailureResponse(new Error("boom"));
  assert.equal(failure.statusCode, 500);
  assert.equal(failure.message, "Internal server error");
  assert.equal(failure.logLevel, "error");
});
