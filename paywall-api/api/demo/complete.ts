import type { VercelRequest, VercelResponse } from "@vercel/node";
import { completeDemoCheckoutSession } from "../../lib/demo-paywall.js";
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
  if (sessionId) {
    completeDemoCheckoutSession(sessionId);
  }

  res.writeHead(303, {
    Location: `/api/demo/checkout?sessionId=${encodeURIComponent(sessionId)}`,
  });
  res.end();
}
