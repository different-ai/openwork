const REDACTED = "[REDACTED]";

// Credential detection is deliberately bounded; this is not general PII detection.
const SENSITIVE_KEY = /^(?:authorization|proxyauthorization|cookie|setcookie|password|passwd|secret|clientsecret|token|accesstoken|refreshtoken|idtoken|apikey|xapikey|credential|credentials|privatekey|sessiontoken|clienttoken|ownertoken|hosttoken)$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[-_\s]/g, "");
  return SENSITIVE_KEY.test(normalized) || /(?:apiKey|accessToken|refreshToken|clientSecret|password|privateKey)$/i.test(normalized);
}

export function sanitizeDiagnosticString(value: string): string {
  return value
    .replace(/^(\s*(?:authorization|proxy-authorization|cookie|set-cookie)\s*:\s*)[^\r\n]+/gim, `$1${REDACTED}`)
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi, (match) => `${match.split(/\s/)[0]} ${REDACTED}`)
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g, REDACTED)
    .replace(/\b(?:ow[thc]_|sk-(?:proj-|ant-)?|gh[pousr]_|github_pat_|xox[a-z]-|xoxe-(?:\d-)?|ya29\.|AIza)[A-Za-z0-9_.-]+/g, REDACTED)
    // JSON, environment assignments, CLI flags and URL query credentials.
    .replace(/(["']?)\b((?:[\w-]*(?:token|secret|password|api[_-]?key|private[_-]?key)|authorization|proxy[_-]?authorization|cookie|set[_-]?cookie|passwd|credentials?))\1(\s*[:=]\s*)(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s&,;)}\]]+)/gi,
      (match, quote: string, key: string, separator: string) =>
        isSensitiveKey(key.replace(/^--/, "")) ? `${quote}${key}${quote}${separator}"${REDACTED}"` : match)
    .replace(/(--[\w-]+)\s+("[^"]*"|'[^']*'|[^\s]+)/g,
      (match, key: string) => isSensitiveKey(key) ? `${key} ${REDACTED}` : match)
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, `$1${REDACTED}@`);
}

export function sanitizeDiagnosticValue(value: unknown): unknown {
  if (typeof value === "string") return sanitizeDiagnosticString(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.map((item, index) => {
    const previous = value[index - 1];
    return typeof previous === "string" && previous.startsWith("--") && isSensitiveKey(previous)
      ? REDACTED : sanitizeDiagnosticValue(item);
  });
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
