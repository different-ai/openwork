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

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.trim().toLowerCase());
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

export function sanitizeDiagnosticRecord(value: Record<string, unknown>): Record<string, unknown> {
  const sanitized = sanitizeDiagnosticValue(value);
  return isRecord(sanitized) ? sanitized : {};
}

function isSafeCloudTokenMetadataKey(key: string): boolean {
  const normalized = key.trim().toLowerCase();
  return normalized.includes("fingerprint") ||
    normalized.includes("hash") ||
    normalized.includes("expir") ||
    normalized === "scope" ||
    normalized === "scopes";
}

function safeCloudTokenMetadata(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (!isSafeCloudTokenMetadataKey(key)) continue;
    if (typeof nested === "string") output[key] = sanitizeDiagnosticString(nested);
    else if (typeof nested === "number" || typeof nested === "boolean" || nested === null) output[key] = nested;
    else if (Array.isArray(nested)) output[key] = nested.map((item) => typeof item === "string" ? sanitizeDiagnosticString(item) : String(item));
  }
  return Object.keys(output).length ? output : null;
}

export function sanitizeCloudMcpHealthDiagnostic(value: unknown): unknown {
  const sanitized = sanitizeDiagnosticValue(value);
  if (!isRecord(value) || !isRecord(sanitized)) return sanitized;
  const desired = isRecord(value.desired) ? value.desired : null;
  const desiredSanitized = isRecord(sanitized.desired) ? sanitized.desired : null;
  const token = desired && isRecord(desired.token) ? desired.token : null;
  const metadata = token ? safeCloudTokenMetadata(token.metadata) : null;
  if (!desiredSanitized || !metadata) return sanitized;
  return {
    ...sanitized,
    desired: {
      ...desiredSanitized,
      tokenMetadata: metadata,
    },
  };
}
