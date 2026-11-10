/**
 * Credentials an MCP server URL must not carry: a user name or password, or
 * a query parameter that holds a token or key. Shared by POST/PUT
 * /v1/mcp-connections (the route schema) and config-blob imports
 * (`connectors.mcp`), which write through the route's handlers without its
 * schema. Messages name the parameter, never its value.
 */

/** Query parameters (compared lowercase) an MCP URL may not have. */
export const EXTERNAL_MCP_SENSITIVE_URL_PARAMETERS: ReadonlySet<string> = new Set([
  "access_token",
  "api_key",
  "client_secret",
  "token",
  "refresh_token",
  "id_token",
  "code_verifier",
])

/** What an export puts in place of a credential found in a stored URL. */
export const REDACTED_URL_CREDENTIAL = "[redacted]"

function parse(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

/** The plain-English problems with credentials in `value`; empty when it carries none or is not a URL. */
export function externalMcpUrlCredentialProblems(value: string): string[] {
  const url = parse(value.trim())
  if (!url) return []
  const problems: string[] = []
  if (url.username || url.password) problems.push("MCP URLs must not contain embedded credentials.")
  for (const parameter of new Set(url.searchParams.keys())) {
    if (EXTERNAL_MCP_SENSITIVE_URL_PARAMETERS.has(parameter.toLowerCase())) {
      problems.push(`MCP URL query parameter "${parameter}" must not contain credentials.`)
    }
  }
  return problems
}

function decoded(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * `value` with every credential replaced by `[redacted]`: the user name and
 * password, and the value of each sensitive query parameter. `found` lists
 * what held a real credential (a value that was not already `[redacted]`).
 * A value that is not a URL is returned unchanged.
 */
export function redactExternalMcpUrlCredentials(value: string): { url: string; found: string[] } {
  const url = parse(value.trim())
  if (!url) return { url: value, found: [] }
  const found: string[] = []
  let changed = false
  if (url.username || url.password) {
    if (decoded(url.username) !== REDACTED_URL_CREDENTIAL || (url.password && decoded(url.password) !== REDACTED_URL_CREDENTIAL)) found.push("embedded credentials")
    url.username = REDACTED_URL_CREDENTIAL
    if (url.password) url.password = REDACTED_URL_CREDENTIAL
    changed = true
  }
  const entries = [...url.searchParams.entries()]
  if (entries.some(([parameter]) => EXTERNAL_MCP_SENSITIVE_URL_PARAMETERS.has(parameter.toLowerCase()))) {
    const next = new URLSearchParams()
    for (const [parameter, entry] of entries) {
      const sensitive = EXTERNAL_MCP_SENSITIVE_URL_PARAMETERS.has(parameter.toLowerCase())
      if (sensitive && entry !== REDACTED_URL_CREDENTIAL && !found.includes(`query parameter "${parameter}"`)) found.push(`query parameter "${parameter}"`)
      next.append(parameter, sensitive ? REDACTED_URL_CREDENTIAL : entry)
    }
    url.search = next.toString()
    changed = true
  }
  return { url: changed ? url.toString() : value, found }
}
