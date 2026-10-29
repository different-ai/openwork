/** Redact unregistered credentials too, including truncated JSON error previews. */
export function redactWorkshopDiagnostic(text: string, secrets: readonly string[]): string {
  return secrets.filter(Boolean).reduce((value, secret) => value.replaceAll(secret, "[secret]"), text)
    .replace(/("(?:token|access_token|password|authorization|cookie)"\s*:\s*)("(?:\\.|[^"\\])*"?|[^,}\]\s]+)/gi, '$1"[secret]"')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [secret]")
    .replace(/https?:\/\/[^\s"'<>]+/g, "[private URL]")
    .replace(/(^|[^a-z0-9-]|\\[nrt])\d{2,5}-[a-z0-9-]+\.daytonaproxy[a-z0-9.-]+\b/gi, "$1[private host]")
    .replace(/\b[a-f0-9]{64}\b/gi, "[secret]");
}
