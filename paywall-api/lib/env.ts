export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function normalizePem(pem: string): string {
  return pem.replace(/\\n/g, "\n").trim();
}
