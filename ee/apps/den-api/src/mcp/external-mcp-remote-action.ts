import { ElicitRequestURLParamsSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js"

/**
 * Normalizes a downstream MCP "a user must connect or sign in before this can
 * run" response into ONE OpenWork connection action, independent of the wire
 * dialect the provider used to express it. This is the single place that turns
 * an external MCP remote error into a user-facing connect action, so every MCP
 * harness (OpenWork, Codex, Claude Code, ...) receives the same shape without an
 * OpenWork-specific plugin.
 *
 * Two dialects are recognized, standards-first:
 *
 *  1. The MCP SDK 1.29 URL elicitation standard: a JSON-RPC error whose code is
 *     `ErrorCode.UrlElicitationRequired` (-32042) carrying `data.elicitations`
 *     validated against the SDK's own `ElicitRequestURLParamsSchema`. This is
 *     the preferred path; when providers migrate to it, no OpenWork change is
 *     needed.
 *
 *  2. A compatibility gateway dialect: any JSON-RPC error carrying a structured
 *     `error.data.connect_url` (+ optional `error.data.provider`). Detection is
 *     by STRUCTURED fields only — never the numeric code, never free text — so
 *     it is locale-independent, injection-resistant, and works under whatever
 *     server-defined code the gateway happens to return.
 *
 * Every candidate link passes ONE safety policy (`safeConnectionActionUrl`):
 * http(s) only, a single Markdown link flattened to its destination, embedded
 * credentials rejected, and the link origin bound to the admin-registered MCP
 * connection origin. Untrusted provider text is never echoed to the agent; the
 * action is described using the trusted OpenWork connection identity by the
 * caller. The URL is only ever relayed for the user to open — never opened or
 * retried automatically.
 *
 * NOTE ON ORIGIN BINDING: the policy requires the connect link to share the
 * registered MCP connection's origin. Real gateways already serve their connect
 * endpoint on the same origin as the MCP endpoint, so this holds today. If a
 * legitimate standard URL elicitation ever needs a different origin, this gate
 * refuses the link (the capability still fails honestly) rather than silently
 * trusting a cross-origin destination; lifting that would require an explicit,
 * reviewed per-connection trusted-origin allowlist, not a weakening here.
 */

const CAUSE_CHAIN_DEPTH = 6

export type ExternalMcpConnectionActionData = {
  connect_url: string
  provider?: string
}

// The provider label is untrusted remote input: validated against a small safe
// character set or dropped in favor of the trusted OpenWork connection name.
const SAFE_PROVIDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function causeChain(error: unknown): unknown[] {
  const chain: unknown[] = []
  let current: unknown = error
  const seen = new Set<unknown>()
  for (let depth = 0; depth < CAUSE_CHAIN_DEPTH && current !== undefined && current !== null && !seen.has(current); depth += 1) {
    seen.add(current)
    chain.push(current)
    current = isRecord(current) ? current.cause : undefined
  }
  return chain
}

/**
 * The single URL safety gate for a relayed connection link. Accepts only an
 * http(s) URL whose origin matches the registered MCP connection origin, with a
 * lone Markdown link flattened to its destination and any embedded credentials
 * refused. Returns the canonical URL string, or null when the value is missing,
 * malformed, non-http(s), credential-bearing, or cross-origin.
 */
export function safeConnectionActionUrl(value: unknown, connectionUrl: string): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const connectionOrigin = originOf(connectionUrl)
  if (!connectionOrigin) return null
  const markdownDestination = /^\[[^\]]*\]\((https?:\/\/[^)\s]+)\)$/i.exec(trimmed)?.[1]
  let url: URL
  try {
    url = new URL(markdownDestination ?? trimmed)
  } catch {
    return null
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null
  // Credentials embedded in the authority (user:pass@host) are a classic
  // phishing/exfiltration vector and never part of a legitimate connect URL.
  if (url.username !== "" || url.password !== "") return null
  // Bind the action to the trusted connection: a link the provider returns may
  // only point at the origin an admin already registered for this connection.
  if (url.origin !== connectionOrigin) return null
  return url.toString()
}

function originOf(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).origin
  } catch {
    return null
  }
}

function safeProvider(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const provider = value.trim()
  return SAFE_PROVIDER_PATTERN.test(provider) ? provider : undefined
}

/**
 * Standards-first adapter: the MCP SDK 1.29 URL elicitation. A remote
 * `-32042` with `data.elicitations` is delivered by the SDK as a
 * `UrlElicitationRequiredError` (an `McpError` subclass). Recognize it by the
 * standard error code and validate every elicitation against the SDK's own
 * `ElicitRequestURLParamsSchema` rather than casting the payload. Deterministic:
 * the first elicitation whose URL passes the safety + origin policy wins, and
 * only that validated URL is kept — no other elicitation field is surfaced.
 */
function urlElicitationAction(error: unknown, connectionUrl: string): ExternalMcpConnectionActionData | null {
  for (const rpcError of jsonRpcErrorRecords(error)) {
    if (rpcError.code !== ErrorCode.UrlElicitationRequired || !isRecord(rpcError.data)) continue
    const elicitations = Array.isArray(rpcError.data.elicitations) ? rpcError.data.elicitations : []
    for (const candidate of elicitations) {
      const parsed = ElicitRequestURLParamsSchema.safeParse(candidate)
      if (!parsed.success) continue
      const connectUrl = safeConnectionActionUrl(parsed.data.url, connectionUrl)
      if (connectUrl) return { connect_url: connectUrl }
    }
  }
  return null
}

/**
 * Compatibility adapter for the existing gateway dialect: a JSON-RPC error
 * carrying a structured `error.data.connect_url`. Recognized by fields only, so
 * it is code-independent — the same structured data under any server-defined
 * code normalizes identically — and free of any locale-dependent message text.
 */
function connectUrlAction(error: unknown, connectionUrl: string): ExternalMcpConnectionActionData | null {
  for (const rpcError of jsonRpcErrorRecords(error)) {
    if (!isRecord(rpcError.data)) continue
    const connectUrl = safeConnectionActionUrl(rpcError.data.connect_url, connectionUrl)
    if (!connectUrl) continue
    const provider = safeProvider(rpcError.data.provider)
    return { connect_url: connectUrl, ...(provider ? { provider } : {}) }
  }
  return null
}

/**
 * Yields candidate JSON-RPC error records from the cause chain: a remote
 * `McpError` (whose `.data` preserves the provider's structured payload), a
 * plain `{ error: {...} }` / `{ code, data }` object, or a JSON-RPC envelope
 * flattened into an error message string by an SDK transport wrapper.
 */
function* jsonRpcErrorRecords(error: unknown): Generator<Record<string, unknown>> {
  for (const current of causeChain(error)) {
    if (current instanceof McpError) {
      yield {
        code: current.code,
        ...(isRecord(current.data) ? { data: current.data } : {}),
      }
      continue
    }
    const direct = jsonRpcErrorFromValue(current)
    if (direct) yield direct
  }
}

function jsonRpcErrorFromValue(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) {
    if (isRecord(value.error)) return value.error
    if (isRecord(value.data) || typeof value.code === "number") return value
  }
  const message = value instanceof Error ? value.message : typeof value === "string" ? value : null
  const jsonStart = message?.indexOf("{") ?? -1
  if (!message || jsonStart < 0) return null
  try {
    const parsed: unknown = JSON.parse(message.slice(jsonStart))
    if (!isRecord(parsed)) return null
    return isRecord(parsed.error) ? parsed.error : parsed
  } catch {
    return null
  }
}

/**
 * The public normalizer. Returns the single connect action a downstream MCP
 * asked OpenWork to relay, or null when no recognized connect/sign-in dialect
 * is present (so the caller falls through to honest error classification).
 * Standards-first (URL elicitation), then the compatibility connect_url dialect.
 */
export function externalMcpConnectionActionRequired(
  error: unknown,
  input: { connectionUrl: string },
): ExternalMcpConnectionActionData | null {
  return urlElicitationAction(error, input.connectionUrl)
    ?? connectUrlAction(error, input.connectionUrl)
}
