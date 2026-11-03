/**
 * Administrator-configured request headers for external MCP connections.
 *
 * Values are secrets: they are stored encrypted, sent only to the MCP server
 * URL itself, and never returned, logged, audited or put in a diagnostic.
 * Only header names leave this module.
 */

export const EXTERNAL_MCP_REQUEST_HEADERS_LIMIT = 4
export const EXTERNAL_MCP_REQUEST_HEADER_NAME_MAX = 64
export const EXTERNAL_MCP_REQUEST_HEADER_VALUE_MAX = 4096

export type ExternalMcpRequestHeader = { name: string; value: string }
export type ExternalMcpRequestHeaderUpdate = { name: string; value?: string }

/** Who sets `authorization`: OpenWork for OAuth and API-key connections; the administrator otherwise. */
export type ExternalMcpRequestHeaderContext = "oauth" | "apikey" | "none" | "discover"

export type RequestHeadersResult =
  | { ok: true; headers: ExternalMcpRequestHeader[] }
  | { ok: false; message: string }

// RFC 7230 token: 1*tchar.
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

const RESERVED_HEADER_NAMES = new Set([
  "host",
  "content-length",
  "content-type",
  "accept",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "proxy-authorization",
  "proxy-connection",
  "cookie",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
])

function headerNameProblem(name: string, context: ExternalMcpRequestHeaderContext): string | null {
  if (name.length === 0) return "Each request header needs a name."
  if (name.length > EXTERNAL_MCP_REQUEST_HEADER_NAME_MAX) {
    return `The request header name "${name.slice(0, EXTERNAL_MCP_REQUEST_HEADER_NAME_MAX)}…" is too long. Use at most ${EXTERNAL_MCP_REQUEST_HEADER_NAME_MAX} characters.`
  }
  if (!HEADER_NAME_PATTERN.test(name)) {
    return `"${name}" is not a valid request header name. Use letters, numbers and dashes, with no spaces.`
  }
  const lower = name.toLowerCase()
  if (RESERVED_HEADER_NAMES.has(lower) || lower.startsWith("x-openwork-")) {
    return `The request header "${name}" is set by OpenWork and can't be added.`
  }
  if (lower === "authorization" && (context === "oauth" || context === "apikey")) {
    return `The request header "${name}" is set by OpenWork for this sign-in method and can't be added.`
  }
  return null
}

function headerValueProblem(name: string, value: string): string | null {
  if (value.length === 0) return `Enter a value for the request header "${name}".`
  if (value.length > EXTERNAL_MCP_REQUEST_HEADER_VALUE_MAX) {
    return `The value for the request header "${name}" is too long. Use at most ${EXTERNAL_MCP_REQUEST_HEADER_VALUE_MAX} characters.`
  }
  if (/[\r\n\0]/.test(value)) return `The value for the request header "${name}" can't contain line breaks.`
  return null
}

/** Validates a complete header set. Messages name the header but never echo a value. */
export function validateExternalMcpRequestHeaders(
  headers: ExternalMcpRequestHeader[],
  context: ExternalMcpRequestHeaderContext,
): RequestHeadersResult {
  if (headers.length > EXTERNAL_MCP_REQUEST_HEADERS_LIMIT) {
    return { ok: false, message: `You can add up to ${EXTERNAL_MCP_REQUEST_HEADERS_LIMIT} request headers.` }
  }
  const seen = new Set<string>()
  for (const header of headers) {
    const problem = headerNameProblem(header.name, context) ?? headerValueProblem(header.name, header.value)
    if (problem) return { ok: false, message: problem }
    const lower = header.name.toLowerCase()
    if (seen.has(lower)) return { ok: false, message: `The request header "${header.name}" is listed more than once.` }
    seen.add(lower)
  }
  return { ok: true, headers: headers.map((header) => ({ name: header.name, value: header.value })) }
}

/**
 * Applies an update to the stored set. Omitted keeps the stored headers;
 * an array replaces them; an entry without a value keeps the stored value of
 * the header with the same name (case-insensitive). The result still needs
 * validateExternalMcpRequestHeaders for the connection's sign-in method.
 */
export function mergeExternalMcpRequestHeaderUpdate(
  stored: ExternalMcpRequestHeader[],
  update: ExternalMcpRequestHeaderUpdate[] | undefined,
): RequestHeadersResult {
  if (update === undefined) return { ok: true, headers: stored }
  const merged: ExternalMcpRequestHeader[] = []
  for (const entry of update) {
    if (entry.value !== undefined) {
      merged.push({ name: entry.name, value: entry.value })
      continue
    }
    const existing = stored.find((header) => header.name.toLowerCase() === entry.name.toLowerCase())
    if (!existing) {
      return { ok: false, message: `Enter a value for the request header "${entry.name}". No value is saved for it yet.` }
    }
    merged.push({ name: entry.name, value: existing.value })
  }
  return { ok: true, headers: merged }
}

export function sameExternalMcpRequestHeaders(a: ExternalMcpRequestHeader[], b: ExternalMcpRequestHeader[]): boolean {
  return a.length === b.length && a.every((header, index) => header.name === b[index]?.name && header.value === b[index]?.value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/** Reads the decrypted column. Malformed data yields no headers rather than failing the connection. */
export function parseStoredExternalMcpRequestHeaders(stored: string | null | undefined): ExternalMcpRequestHeader[] {
  if (!stored) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(stored)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const headers: ExternalMcpRequestHeader[] = []
  for (const entry of parsed) {
    if (isRecord(entry) && typeof entry.name === "string" && typeof entry.value === "string") {
      headers.push({ name: entry.name, value: entry.value })
    }
  }
  return headers
}

export function serializeExternalMcpRequestHeaders(headers: ExternalMcpRequestHeader[]): string | null {
  return headers.length > 0 ? JSON.stringify(headers.map((header) => ({ name: header.name, value: header.value }))) : null
}

export function externalMcpRequestHeaderNames(stored: string | null | undefined): string[] {
  return parseStoredExternalMcpRequestHeaders(stored).map((header) => header.name)
}

function sameMcpEndpoint(requestUrl: string, mcpUrl: URL): boolean {
  let parsed: URL
  try {
    parsed = new URL(requestUrl)
  } catch {
    return false
  }
  return parsed.origin === mcpUrl.origin && parsed.pathname === mcpUrl.pathname
}

export type ExternalMcpFetch = (url: string | URL, init?: RequestInit) => Promise<Response>

/**
 * Adds the headers only to requests for the MCP server URL itself (same
 * origin and path). OAuth, authorization-server and metadata requests on
 * other URLs never see them. An `authorization` header OpenWork already set
 * (API key or OAuth bearer) always wins over a custom one.
 *
 * Wrap the innermost network fetch (inside diagnostics and tool-call
 * inspection) so header values never reach a diagnostic or inspection record.
 */
export function withExternalMcpRequestHeaders(
  fetchImpl: ExternalMcpFetch,
  mcpUrl: string,
  headers: ExternalMcpRequestHeader[],
): ExternalMcpFetch {
  if (headers.length === 0) return fetchImpl
  const endpoint = new URL(mcpUrl)
  return (url, init) => {
    if (!sameMcpEndpoint(url instanceof URL ? url.href : url, endpoint)) return fetchImpl(url, init)
    const merged = new Headers(init?.headers)
    for (const header of headers) {
      if (header.name.toLowerCase() === "authorization" && merged.has("authorization")) continue
      merged.set(header.name, header.value)
    }
    // Never let a redirect carry the headers to another destination: the
    // caller (the MCP SDK follows same-origin redirects itself) re-enters
    // this wrapper for each hop, which re-checks the destination.
    return fetchImpl(url, { ...init, headers: merged, redirect: init?.redirect === "error" ? "error" : "manual" })
  }
}

export type RequestHeaderUpdateResolution =
  | { ok: true; headers: ExternalMcpRequestHeader[]; changed: boolean }
  | { ok: false; message: string }

/**
 * Resolves an edit against the stored (decrypted) column and validates the
 * result for the connection's new sign-in method. When the server itself
 * changes, saved values are never carried to it: every header must be
 * entered again (or removed with an empty array).
 */
export function resolveRequestHeaderUpdate(input: {
  stored: string | null | undefined
  update: ExternalMcpRequestHeaderUpdate[] | undefined
  authType: "oauth" | "apikey" | "none"
  serverChanged: boolean
}): RequestHeaderUpdateResolution {
  const stored = parseStoredExternalMcpRequestHeaders(input.stored)
  if (input.serverChanged && stored.length > 0) {
    const keepsSavedValue = input.update === undefined || input.update.some((entry) => entry.value === undefined)
    if (keepsSavedValue) {
      return { ok: false, message: "The server address changed, so saved request header values won't be sent to it. Enter each request header value again, or remove the headers." }
    }
  }
  const merged = mergeExternalMcpRequestHeaderUpdate(stored, input.update)
  if (!merged.ok) return merged
  const validated = validateExternalMcpRequestHeaders(merged.headers, input.authType)
  if (!validated.ok) return validated
  return { ok: true, headers: validated.headers, changed: !sameExternalMcpRequestHeaders(stored, validated.headers) }
}
