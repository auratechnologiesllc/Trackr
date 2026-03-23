import type { DemoCheckoutSessionSnapshot } from "./demo-paywall.js";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderDemoCheckoutPage(session: DemoCheckoutSessionSnapshot | null): string {
  const title = session ? "Trackr demo checkout" : "Trackr demo session missing";
  const description = !session
    ? "This demo checkout session could not be found. Start checkout from Trackr again."
    : session.state === "paid"
      ? "Payment is simulated for local development. Return to Trackr and it should unlock within a few seconds."
      : session.state === "expired"
        ? "This demo checkout session expired. Start checkout again from Trackr."
        : "Complete the local demo checkout to unlock Trackr on this machine.";

  const action =
    session?.state === "pending"
      ? `<a class="button" href="/api/demo/complete?sessionId=${encodeURIComponent(
          session.sessionId,
        )}">Unlock this device</a>`
      : "";

  const sessionMeta = session
    ? `
      <dl>
        <div><dt>Status</dt><dd>${escapeHtml(session.state)}</dd></div>
        <div><dt>Device</dt><dd>${escapeHtml(session.deviceId)}</dd></div>
        <div><dt>App version</dt><dd>${escapeHtml(session.appVersion)}</dd></div>
        <div><dt>Session</dt><dd>${escapeHtml(session.sessionId)}</dd></div>
      </dl>
    `
    : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root {
        color-scheme: light;
        font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: radial-gradient(circle at top, #1e8f62 0%, #0f172a 58%, #020617 100%);
        color: #e2e8f0;
      }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 24px;
      }
      main {
        width: min(560px, 100%);
        border-radius: 28px;
        padding: 32px;
        background: rgba(15, 23, 42, 0.82);
        border: 1px solid rgba(148, 163, 184, 0.2);
        box-shadow: 0 30px 80px rgba(2, 6, 23, 0.45);
        backdrop-filter: blur(18px);
      }
      .eyebrow {
        margin: 0 0 12px;
        color: #86efac;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        font-size: 12px;
        font-weight: 700;
      }
      h1 {
        margin: 0;
        font-size: clamp(28px, 6vw, 42px);
      }
      p {
        margin: 14px 0 0;
        color: #cbd5e1;
        line-height: 1.6;
      }
      dl {
        margin: 24px 0 0;
        padding: 0;
        display: grid;
        gap: 14px;
      }
      dl div {
        display: grid;
        gap: 4px;
      }
      dt {
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: #94a3b8;
      }
      dd {
        margin: 0;
        word-break: break-word;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      .button {
        display: inline-flex;
        margin-top: 28px;
        border-radius: 999px;
        padding: 14px 20px;
        font: inherit;
        font-weight: 700;
        text-decoration: none;
        background: linear-gradient(135deg, #4ade80, #22c55e);
        color: #052e16;
      }
    </style>
  </head>
  <body>
    <main>
      <p class="eyebrow">Trackr local demo</p>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(description)}</p>
      ${sessionMeta}
      ${action}
    </main>
  </body>
</html>`;
}
