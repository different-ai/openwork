const QUERY_PARAMETER = /([?&])([^=&\s]+)=([^&\s]*)/g
const SENSITIVE_QUERY_PARAMETERS = new Set([
  "code",
  "state",
  "access_token",
  "refresh_token",
  "id_token",
  "client_secret",
  "code_verifier",
  "api_key",
  "token",
  "error",
  "error_description",
  "error_uri",
  "session_state",
])

/**
 * Hono's request logger includes the full query string. OAuth callbacks carry
 * short-lived credentials in that query, so redact them before the line
 * reaches stdout. Parameter names and route shape remain available for
 * diagnostics while values never enter routine logs.
 */
export function redactRequestLogLine(line: string): string {
  return line.replace(QUERY_PARAMETER, (match, separator: string, rawName: string) => {
    let name: string
    try {
      name = decodeURIComponent(rawName.replace(/\+/g, " ")).toLowerCase()
    } catch {
      return match
    }
    return SENSITIVE_QUERY_PARAMETERS.has(name)
      ? `${separator}${rawName}=[REDACTED]`
      : match
  })
}
