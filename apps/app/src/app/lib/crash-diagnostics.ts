import { sanitizeDiagnosticString } from "./diagnostic-sanitizer";

const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>()]+/gi;
const SECRET_PAIR_PATTERN = /(token|grant|code|secret|key)=[^&\s"'<>()]+/gi;
const FALLBACK_MESSAGE = "An unexpected error occurred.";

/**
 * Drop userinfo from a matched URL: everything from the scheme's `//` through the
 * LAST `@` (or encoded `%40`) inside the authority, which ends at the first `/`, `?`
 * or `#`. A password may itself contain `@`, so stopping at the first one leaks it.
 */
function stripUserinfo(url: string): string {
  const start = url.indexOf("//") + 2;
  const end = url.slice(start).search(/[/?#]/);
  const authorityEnd = end === -1 ? url.length : start + end;
  const authority = url.slice(start, authorityEnd);
  return url.slice(0, start) + authority.replace(/^.*(@|%40)/i, "") + url.slice(authorityEnd);
}

/** Bound work before redaction; bound output only after credentials are removed. */
export function redactCrashText(text: string): string {
  const urlsRemoved = text.slice(0, 16000).replace(URL_PATTERN, (url) => {
    const withoutUserinfo = stripUserinfo(url);
    const cut = withoutUserinfo.search(/[?#]/);
    if (cut === -1) return withoutUserinfo;
    const position = /(:\d+){1,2}$/.exec(withoutUserinfo)?.[0] ?? "";
    return withoutUserinfo.slice(0, cut) + position;
  });
  // URLs first: masking a query pair first could eat its frame's :line:column.
  return sanitizeDiagnosticString(urlsRemoved).replace(SECRET_PAIR_PATTERN, "$1=[redacted]");
}

/** Read each field defensively, without recursive inspection or string coercion. */
function diagnosticField(value: unknown, key: string): string | undefined {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return undefined;
  try {
    // V8 exposes even ordinary Error stacks through a lazy accessor. Do not
    // discard those diagnostics, but contain accessors/proxies that throw.
    const field: unknown = Reflect.get(value, key);
    return typeof field === "string" ? field : undefined;
  } catch {
    // Revoked proxies and lazy engine stack properties may themselves throw.
  }
  return undefined;
}

export function formatCrashDiagnostic(thrown: unknown, fallbackName = "Error"): { name: string; message: string; stack: string } {
  const primitive = thrown === null || (typeof thrown !== "object" && typeof thrown !== "function");
  const message = diagnosticField(thrown, "message") ?? (primitive ? String(thrown) : FALLBACK_MESSAGE);
  return {
    name: redactCrashText(diagnosticField(thrown, "name") ?? fallbackName).slice(0, 100),
    message: redactCrashText(message).slice(0, 1000),
    stack: redactCrashText(diagnosticField(thrown, "stack") ?? "").slice(0, 8000),
  };
}
