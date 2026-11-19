/** Hides emails, bearer tokens, and token/secret/password values in text that is written to evidence. */
export function redactText(value: string): string {
  return value
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "<email>")
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer <redacted>")
    .replace(/((?:["']?[\w.-]*(?:token|secret|password)[\w.-]*["']?)\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}&]+)/gi, "$1<redacted>");
}
