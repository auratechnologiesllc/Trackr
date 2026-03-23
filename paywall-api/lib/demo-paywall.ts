import { randomUUID } from "node:crypto";

const DEMO_SESSION_TTL_MS = 30 * 60 * 1000;
const DEMO_SESSION_RETENTION_MS = 2 * DEMO_SESSION_TTL_MS;

type DemoCheckoutSession = {
  sessionId: string;
  deviceId: string;
  appVersion: string;
  createdAtEpochMs: number;
  expiresAtEpochMs: number;
  paidAtEpochMs: number | null;
  paymentIntentId: string | null;
};

export type DemoCheckoutSessionSnapshot = DemoCheckoutSession & {
  state: "pending" | "expired" | "paid";
};

const demoSessions = new Map<string, DemoCheckoutSession>();

function snapshotSession(
  session: DemoCheckoutSession,
  nowEpochMs: number,
): DemoCheckoutSessionSnapshot {
  return {
    ...session,
    state: session.paidAtEpochMs
      ? "paid"
      : session.expiresAtEpochMs <= nowEpochMs
        ? "expired"
        : "pending",
  };
}

function pruneExpiredDemoSessions(nowEpochMs: number): void {
  for (const [sessionId, session] of demoSessions) {
    const stale = session.expiresAtEpochMs <= nowEpochMs - DEMO_SESSION_RETENTION_MS;
    if (stale) {
      demoSessions.delete(sessionId);
    }
  }
}

function makeDemoSessionId(): string {
  return `cs_demo_${randomUUID().replace(/-/g, "")}`;
}

function makeDemoPaymentIntentId(): string {
  return `pi_demo_${randomUUID().replace(/-/g, "")}`;
}

export function startDemoCheckout(params: {
  deviceId: string;
  appVersion: string;
  baseUrl: string;
  nowEpochMs?: number;
}): {
  checkoutUrl: string;
  sessionId: string;
  expiresAtEpochMs: number;
} {
  const nowEpochMs = params.nowEpochMs ?? Date.now();
  pruneExpiredDemoSessions(nowEpochMs);

  const sessionId = makeDemoSessionId();
  const expiresAtEpochMs = nowEpochMs + DEMO_SESSION_TTL_MS;
  const session: DemoCheckoutSession = {
    sessionId,
    deviceId: params.deviceId,
    appVersion: params.appVersion,
    createdAtEpochMs: nowEpochMs,
    expiresAtEpochMs,
    paidAtEpochMs: null,
    paymentIntentId: null,
  };

  demoSessions.set(sessionId, session);

  return {
    checkoutUrl: `${params.baseUrl.replace(/\/$/, "")}/api/demo/checkout?sessionId=${encodeURIComponent(
      sessionId,
    )}`,
    sessionId,
    expiresAtEpochMs,
  };
}

export function getDemoCheckoutSession(
  sessionId: string,
  nowEpochMs = Date.now(),
): DemoCheckoutSessionSnapshot | null {
  pruneExpiredDemoSessions(nowEpochMs);

  const session = demoSessions.get(sessionId);
  if (!session) {
    return null;
  }

  return snapshotSession(session, nowEpochMs);
}

export function completeDemoCheckoutSession(
  sessionId: string,
  nowEpochMs = Date.now(),
): DemoCheckoutSessionSnapshot | null {
  pruneExpiredDemoSessions(nowEpochMs);

  const session = demoSessions.get(sessionId);
  if (!session) {
    return null;
  }

  if (!session.paidAtEpochMs && session.expiresAtEpochMs > nowEpochMs) {
    session.paidAtEpochMs = nowEpochMs;
    session.paymentIntentId = makeDemoPaymentIntentId();
  }

  return snapshotSession(session, nowEpochMs);
}
