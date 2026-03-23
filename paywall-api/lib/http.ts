import type { VercelRequest, VercelResponse } from "@vercel/node";

const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:1420",
  "http://127.0.0.1:1420",
  "tauri://localhost",
  "https://tauri.localhost",
  "http://tauri.localhost",
] as const;

function firstHeaderValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }
  return value ?? "";
}

function configuredCorsOrigins(): string[] {
  const configured = [
    process.env.PAYWALL_ALLOWED_ORIGINS,
    process.env.PAYWALL_ALLOWED_ORIGIN,
  ]
    .flatMap((value) => (value ?? "").split(/[,\n]/))
    .map((value) => value.trim())
    .filter(Boolean);

  if (configured.includes("*")) {
    return ["*"];
  }

  return [...new Set([...DEFAULT_ALLOWED_ORIGINS, ...configured])];
}

export function resolveCorsOrigin(requestOrigin: string | string[] | undefined): string | null {
  const origin = firstHeaderValue(requestOrigin).trim();
  const allowedOrigins = configuredCorsOrigins();

  if (allowedOrigins.includes("*")) {
    return "*";
  }

  if (origin && allowedOrigins.includes(origin)) {
    return origin;
  }

  return null;
}

export function applyCors(req: VercelRequest, res: VercelResponse): void {
  const resolvedOrigin = resolveCorsOrigin(req.headers.origin);
  if (resolvedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", resolvedOrigin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
}

export function handlePreflight(req: VercelRequest, res: VercelResponse): boolean {
  applyCors(req, res);
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return true;
  }
  return false;
}

export function json(res: VercelResponse, statusCode: number, body: unknown): void {
  res.status(statusCode).setHeader("Content-Type", "application/json").send(JSON.stringify(body));
}

export function methodNotAllowed(res: VercelResponse, allowed: string): void {
  res.setHeader("Allow", allowed);
  json(res, 405, { error: "Method not allowed" });
}

export function badRequest(res: VercelResponse, message: string): void {
  json(res, 400, { error: message });
}

export function serverError(res: VercelResponse, message = "Internal server error"): void {
  json(res, 500, { error: message });
}

export function queryParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }
  return value ?? "";
}

export function requestBaseUrl(req: VercelRequest): string {
  const forwardedProto = firstHeaderValue(req.headers["x-forwarded-proto"])
    .split(",")[0]
    ?.trim();
  const protocol = forwardedProto || "http";
  const forwardedHost = firstHeaderValue(req.headers["x-forwarded-host"]).split(",")[0]?.trim();
  const host = forwardedHost || firstHeaderValue(req.headers.host) || "localhost:3010";
  return `${protocol}://${host}`;
}
