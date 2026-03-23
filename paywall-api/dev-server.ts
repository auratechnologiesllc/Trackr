import "dotenv/config";
import express from "express";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import checkoutStart from "./api/checkout/start.js";
import checkoutStatus from "./api/checkout/status.js";
import entitlementRefresh from "./api/entitlement/refresh.js";
import stripeWebhook from "./api/stripe/webhook.js";
import demoCheckout from "./api/demo/checkout.js";
import demoComplete from "./api/demo/complete.js";
import { paywallModeSummary } from "./lib/paywall-mode.js";

const app = express();
const port = Number(process.env.PAYWALL_API_PORT || 3010);

app.use("/api/stripe/webhook", express.raw({ type: "*/*" }));
app.use(express.json({ limit: "1mb" }));

app.all("/api/checkout/start", async (req, res) => {
  await checkoutStart(req as unknown as VercelRequest, res as unknown as VercelResponse);
});

app.all("/api/checkout/status", async (req, res) => {
  await checkoutStatus(req as unknown as VercelRequest, res as unknown as VercelResponse);
});

app.all("/api/entitlement/refresh", async (req, res) => {
  await entitlementRefresh(req as unknown as VercelRequest, res as unknown as VercelResponse);
});

app.all("/api/stripe/webhook", async (req, res) => {
  await stripeWebhook(req as unknown as VercelRequest, res as unknown as VercelResponse);
});

app.all("/api/demo/checkout", async (req, res) => {
  await demoCheckout(req as unknown as VercelRequest, res as unknown as VercelResponse);
});

app.all("/api/demo/complete", async (req, res) => {
  await demoComplete(req as unknown as VercelRequest, res as unknown as VercelResponse);
});

app.all("*", (req, res) => {
  res.status(404).json({ error: `No route for ${req.method} ${req.path}` });
});

app.listen(port, () => {
  console.log(`Trackr paywall API listening at http://localhost:${port} (${paywallModeSummary()})`);
});
