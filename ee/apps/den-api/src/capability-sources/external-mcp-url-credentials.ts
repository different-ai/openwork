export const EXTERNAL_MCP_SENSITIVE_URL_PARAMETERS: ReadonlySet<string> = new Set([
  "access_token",
  "api_key",
  "client_secret",
  "token",
  "refresh_token",
  "id_token",
  "code_verifier",
])

export const REDACTED_URL_CREDENTIAL = "[redacted]"

function parse(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

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
