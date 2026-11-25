import { sanitizeDiagnosticString } from "./diagnostic-sanitizer";

const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>()]+/gi;
const SECRET_PAIR_PATTERN = /(token|grant|code|secret|key)=(?:"(?:\\[\s\S]?|[^"\\])*(?:"|$)|'(?:\\[\s\S]?|[^'\\])*(?:'|$)|[^&\s"'<>()]+)/gi;
const SECRET_JSON_PAIR_PATTERN = /((["'])(?:token|grant|code|secret|key|password|authorization)\2\s*:\s*)(?:"(?:\\[\s\S]?|[^"\\])*(?:"|$)|'(?:\\[\s\S]?|[^'\\])*(?:'|$)|[^,\s"'{}\[\]]+)/gi;
const FALLBACK_MESSAGE = "An unexpected error occurred.";

function stripUserinfo(url: string, cutShort: boolean): string {
  const start = url.indexOf("//") + 2;
  const end = url.slice(start).search(/[/?#]/);
  if (end === -1 && cutShort) return url.slice(0, start);
  const authorityEnd = end === -1 ? url.length : start + end;
  const authority = url.slice(start, authorityEnd);
  return url.slice(0, start) + authority.replace(/^.*(@|%40)/i, "") + url.slice(authorityEnd);
}

export function redactCrashText(text: string): string {
  const bounded = text.slice(0, 16000);
  const urlsRemoved = bounded.replace(URL_PATTERN, (url, offset: number) => {
    const cutShort = text.length > bounded.length && offset + url.length === bounded.length;
    const withoutUserinfo = stripUserinfo(url, cutShort);
    const cut = withoutUserinfo.search(/[?#]/);
    if (cut === -1) return withoutUserinfo;
    const position = /(:\d+){1,2}$/.exec(withoutUserinfo)?.[0] ?? "";
    return withoutUserinfo.slice(0, cut) + position;
  });
  return sanitizeDiagnosticString(urlsRemoved)
    .replace(SECRET_JSON_PAIR_PATTERN, '$1"[redacted]"')
    .replace(SECRET_PAIR_PATTERN, "$1=[redacted]");
}

function diagnosticField(value: unknown, key: string): string | undefined {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return undefined;
  try {
    const field: unknown = Reflect.get(value, key);
    return typeof field === "string" ? field : undefined;
  } catch {
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
