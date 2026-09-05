import { sanitizeDiagnosticString, sanitizeDiagnosticValue } from "@openwork/types/diagnostic-sanitizer";
export { sanitizeDiagnosticString, sanitizeDiagnosticValue, sanitizeDiagnosticRecord } from "@openwork/types/diagnostic-sanitizer";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
