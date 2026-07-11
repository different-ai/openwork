const QUERY_PARAMETER = /([?&])([^=&\s]+)=([^&\s]*)/g
const EXTERNAL_MCP_CALLBACK_PATH = /^\/v1\/mcp-connections\/[^/]+\/connect\/callback$/
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

function decodedParameterName(rawName: string): string | null {
  try {
    return decodeURIComponent(rawName.replace(/\+/g, " ")).toLowerCase()
  } catch {
    return null
  }
}

function redactSensitiveQueryValues(line: string): string {
  return line.replace(QUERY_PARAMETER, (match, separator: string, rawName: string) => {
    const name = decodedParameterName(rawName)
    return name && SENSITIVE_QUERY_PARAMETERS.has(name)
      ? `${separator}${rawName}=[REDACTED]`
      : match
  })
}

function redactExternalMcpCallbackPath(path: string): string {
  let parsed: URL
  try {
    parsed = new URL(path, "http://den-request-log.invalid")
  } catch {
    return redactSensitiveQueryValues(path)
  }
  if (!EXTERNAL_MCP_CALLBACK_PATH.test(parsed.pathname)) {
    return redactSensitiveQueryValues(path)
  }
  // Provider callbacks can add arbitrary tenant-specific fields. Redact the
  // complete query, not just known OAuth parameters, while retaining the
  // route shape needed to correlate the request.
  return parsed.search
    ? `${parsed.pathname}?oauth_callback=%5BREDACTED%5D`
    : parsed.pathname
}

/** Redacts credentials before Hono writes request or response log lines. */
export function redactDenRequestLogLine(line: string): string {
  const match = /^(<--|-->)\s+(\S+)\s+(\S+)(.*)$/.exec(line)
  if (!match) return redactSensitiveQueryValues(line)
  const [, direction, method, path, suffix] = match
  return `${direction} ${method} ${redactExternalMcpCallbackPath(path)}${suffix}`
}

/** Backward-compatible name used by focused structured-diagnostic tests. */
export const redactRequestLogLine = redactDenRequestLogLine
