import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getDemoCheckoutSession } from "../../lib/demo-paywall.js";
import { renderDemoCheckoutPage } from "../../lib/demo-checkout-page.js";
import { handlePreflight, json, methodNotAllowed, queryParam } from "../../lib/http.js";
import { usingDemoPaywall } from "../../lib/paywall-mode.js";

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (handlePreflight(req, res)) {
    return;
  }

  if (req.method !== "GET") {
    methodNotAllowed(res, "GET, OPTIONS");
    return;
  }

  if (!usingDemoPaywall()) {
    json(res, 404, { error: "Demo checkout is only available in local demo mode." });
    return;
  }

  const sessionId = queryParam(req.query.sessionId).trim();
  const session = sessionId ? getDemoCheckoutSession(sessionId) : null;
  res
    .status(session ? 200 : 404)
    .setHeader("Content-Type", "text/html; charset=utf-8")
    .send(renderDemoCheckoutPage(session));
}
