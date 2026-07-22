const REDACTED = "[REDACTED]";

const SENSITIVE_KEYS = new Set([
  "authorization",
  "token",
  "secret",
  "password",
  "cookie",
  "api_key",
  "api-key",
  "apikey",
  "client_secret",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedKey(key: string): string {
  return key.trim().toLowerCase();
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(normalizedKey(key));
}

export function sanitizeDiagnosticString(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, `Bearer ${REDACTED}`)
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED)
    .replace(/\bow[thc]_[A-Za-z0-9_-]+\b/g, REDACTED);
}

export function sanitizeDiagnosticValue(value: unknown): unknown {
  if (typeof value === "string") return sanitizeDiagnosticString(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeDiagnosticValue(item));
  if (!isRecord(value)) return String(value);

  const sanitized: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    sanitized[key] = isSensitiveKey(key) ? REDACTED : sanitizeDiagnosticValue(nested);
  }
  return sanitized;
}
