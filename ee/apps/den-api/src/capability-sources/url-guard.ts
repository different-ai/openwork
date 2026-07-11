import { lookup } from "node:dns/promises"
import { isIP } from "node:net"

/**
 * SSRF guard for External MCP Connection URLs.
 *
 * Den itself fetches these URLs server-side (OAuth discovery, dynamic
 * client registration, tools/list, tool calls). On a hosted multi-tenant
 * deployment, any signed-up user can create an org (becoming its admin)
 * and register a connection URL — so without this guard, anyone could make
 * Den's servers fetch internal targets they can reach but the user can't:
 * localhost service ports, private-network neighbors, and, worst of all,
 * the cloud metadata endpoint (169.254.169.254) that can leak our own
 * infrastructure credentials.
 *
 * The check is resolve-then-check, not string matching: an attacker can
 * point a legitimate-looking domain's DNS at 127.0.0.1 (DNS rebinding), so
 * we resolve the hostname and reject if ANY resulting address is
 * private/reserved. Because DNS answers can change AFTER a connection is
 * created, callers must also apply createGuardedFetch() at request time
 * (the MCP client threads it into every outbound fetch), not just validate
 * once at create time.
 *
 * Self-hosted deployments whose MCP servers legitimately live on a private
 * network disable this with DEN_ALLOW_PRIVATE_MCP_URLS=1 (see env.ts);
 * local dev is exempt via OPENWORK_DEV_MODE=1.
 */

export class PrivateUrlError extends Error {
  constructor(_url: string, detail: string) {
    super(`The outbound URL is not allowed: ${detail}`)
    this.name = "PrivateUrlError"
  }
}

function parseIpv4(address: string): number[] | null {
  const parts = address.split(".")
  if (parts.length !== 4) return null
  const octets = parts.map((part) => Number(part))
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null
  return octets
}

function isPrivateIpv4(address: string): boolean {
  const octets = parseIpv4(address)
  if (!octets) return true // unparseable: fail closed
  const [a, b] = octets
  if (a === 0) return true // 0.0.0.0/8 "this network"
  if (a === 10) return true // 10.0.0.0/8 private
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64.0.0/10 CGNAT
  if (a === 127) return true // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true // 169.254.0.0/16 link-local incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true // 192.168.0.0/16 private
  if (a === 198 && (b === 18 || b === 19)) return true // 198.18.0.0/15 benchmarking
  if (a >= 224) return true // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved + broadcast
  return false
}

function parseIpv6Words(address: string): number[] | null {
  let normalized = address.toLowerCase()
  if (normalized.includes("%")) return null // scoped literals are never valid hosted targets

  // Normalize an embedded dotted IPv4 tail into its two 16-bit words before
  // expanding `::`. WHATWG URL parsing normally canonicalizes it already, but
  // DNS APIs and direct unit callers may return either representation.
  if (normalized.includes(".")) {
    const lastColon = normalized.lastIndexOf(":")
    if (lastColon < 0) return null
    const octets = parseIpv4(normalized.slice(lastColon + 1))
    if (!octets) return null
    const high = ((octets[0] << 8) | octets[1]).toString(16)
    const low = ((octets[2] << 8) | octets[3]).toString(16)
    normalized = `${normalized.slice(0, lastColon + 1)}${high}:${low}`
  }

  const halves = normalized.split("::")
  if (halves.length > 2) return null
  const parseHalf = (value: string): number[] | null => {
    if (!value) return []
    const parts = value.split(":")
    if (parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null
    return parts.map((part) => Number.parseInt(part, 16))
  }
  const head = parseHalf(halves[0])
  const tail = parseHalf(halves[1] ?? "")
  if (!head || !tail) return null
  if (halves.length === 1) return head.length === 8 ? head : null
  const omitted = 8 - head.length - tail.length
  if (omitted < 1) return null
  return [...head, ...Array.from({ length: omitted }, () => 0), ...tail]
}

function embeddedIpv4(words: number[], offset: number): string {
  return [
    words[offset] >> 8,
    words[offset] & 0xff,
    words[offset + 1] >> 8,
    words[offset + 1] & 0xff,
  ].join(".")
}

function localNat64Ipv4(words: number[]): string | null {
  if (words[0] !== 0x0064 || words[1] !== 0xff9b || words[2] !== 0x0001) return null
  // Accept the common last-32-bit form and RFC 6052's /48 layout (which
  // inserts the reserved u octet between the two halves of the IPv4 address).
  if (words.slice(3, 6).every((word) => word === 0)) return embeddedIpv4(words, 6)
  if ((words[4] >> 8) === 0) {
    return [words[3] >> 8, words[3] & 0xff, words[4] & 0xff, words[5] >> 8].join(".")
  }
  return null
}

function isPrivateIpv6(address: string): boolean {
  const words = parseIpv6Words(address)
  if (!words) return true // malformed/scoped: fail closed
  const [first, second, third] = words
  const fifth = words[4]
  const sixth = words[5]

  if (words.slice(0, 7).every((word) => word === 0) && (words[7] === 0 || words[7] === 1)) return true

  // URL canonicalization turns mapped dotted literals into hex
  // (`::ffff:7f00:1`). Parse words structurally and apply the exact IPv4
  // private/reserved policy to mapped, translated, compatible, and NAT64
  // destinations rather than relying on textual spellings.
  if (words.slice(0, 5).every((word) => word === 0) && sixth === 0xffff) {
    return isPrivateIpv4(embeddedIpv4(words, 6))
  }
  if (words.slice(0, 4).every((word) => word === 0) && fifth === 0xffff && sixth === 0) {
    return isPrivateIpv4(embeddedIpv4(words, 6))
  }
  if (words.slice(0, 6).every((word) => word === 0)) return true // deprecated IPv4-compatible ::/96
  if (
    first === 0x0064
    && second === 0xff9b
    && words.slice(2, 6).every((word) => word === 0)
    && isPrivateIpv4(embeddedIpv4(words, 6))
  ) return true // well-known NAT64 prefix
  const localNat64 = localNat64Ipv4(words)
  if (localNat64 && isPrivateIpv4(localNat64)) return true

  if ((first & 0xfe00) === 0xfc00) return true // fc00::/7 unique-local
  if ((first & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  if ((first & 0xffc0) === 0xfec0) return true // fec0::/10 deprecated site-local
  if ((first & 0xff00) === 0xff00) return true // ff00::/8 multicast
  if (first === 0x0100 && words.slice(1, 4).every((word) => word === 0)) return true // 100::/64 discard-only
  if (first === 0x2001 && second === 0x0db8) return true // documentation
  if (first === 0x2001 && second === 0x0002 && third === 0) return true // benchmarking
  if (first === 0x2001 && ((second & 0xfff0) === 0x0010 || (second & 0xfff0) === 0x0020)) return true // ORCHID
  if (first === 0x2002 && isPrivateIpv4(embeddedIpv4(words, 1))) return true // 6to4 private relay target
  return false
}

/** True when the (already-resolved) IP address is private, loopback, link-local, or otherwise reserved. Exported for tests. */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address)
  if (version === 4) return isPrivateIpv4(address)
  if (version === 6) return isPrivateIpv6(address)
  return true // not an IP at all: fail closed
}

function parseHttpUrl(rawUrl: string): URL {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new PrivateUrlError(rawUrl, "not a valid URL")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PrivateUrlError(rawUrl, `protocol "${url.protocol}" is not allowed`)
  }
  if (url.username || url.password) {
    throw new PrivateUrlError(rawUrl, "embedded URL credentials are not allowed")
  }
  return url
}

type ResolveAddresses = (hostname: string) => Promise<{ address: string }[]>

async function resolveAddresses(hostname: string): Promise<{ address: string }[]> {
  return lookup(hostname, { all: true, verbatim: true })
}

/** Hosted Den egress accepts only public HTTPS destinations. */
export async function assertPublicUrl(rawUrl: string, resolve: ResolveAddresses = resolveAddresses): Promise<void> {
  const url = parseHttpUrl(rawUrl)
  if (url.protocol !== "https:") {
    throw new PrivateUrlError(rawUrl, "hosted MCP egress requires HTTPS")
  }

  // URL brackets IPv6 literals: strip them for isIP().
  const hostname = url.hostname.replace(/^\[|\]$/g, "")
  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new PrivateUrlError(rawUrl, "the address is private or reserved")
    }
    return
  }

  let addresses: { address: string }[]
  try {
    addresses = await resolve(hostname)
  } catch {
    throw new PrivateUrlError(rawUrl, "the hostname does not resolve")
  }
  if (addresses.length === 0) {
    throw new PrivateUrlError(rawUrl, "the hostname does not resolve")
  }
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new PrivateUrlError(rawUrl, `the hostname resolves to a private or reserved address (${address})`)
    }
  }
}

export type ExternalMcpFetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const MAX_GUARDED_REDIRECTS = 5

function isCurrentResponseRealm(res: Response): boolean {
  return res instanceof globalThis.Response
}

/**
 * @hono/node-server overrides globalThis.Response with its own Response2
 * constructor when Den starts serving. Real undici fetch() error responses do
 * not chain to that new prototype, so the MCP SDK's OAuth error parser sees
 * `input instanceof Response` as false and stringifies the whole response — the
 * production symptom was `Invalid OAuth error response: SyntaxError: ... Raw
 * body: [object Response]`, hiding the upstream OAuth server's JSON error.
 * Success responses pass through untouched so streaming/SSE bodies stay live.
 */
export async function normalizeResponseRealm(res: Response): Promise<Response> {
  if (res.ok || isCurrentResponseRealm(res)) return res
  // Keep the old-realm body streaming. Buffering here would consume an
  // attacker-controlled OAuth/MCP error before the diagnostic byte ceiling.
  return new globalThis.Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  })
}

/**
 * A fetch wrapper that re-applies assertPublicUrl to EVERY outbound request
 * — the MCP SDK follows discovery documents to other hosts (authorization
 * servers, token endpoints), and DNS answers can change after create-time
 * validation, so each request is checked at the moment it's made.
 */
function redirectedRequestInit(init: RequestInit | undefined, status: number, from: URL, to: URL): RequestInit {
  const headers = new Headers(init?.headers)
  if (from.protocol === "https:" && to.protocol !== "https:") {
    throw new PrivateUrlError(to.toString(), "an HTTPS request cannot redirect to a less secure protocol")
  }

  const method = (init?.method ?? "GET").toUpperCase()
  if (from.origin !== to.origin) {
    // Never replay authorization codes, PKCE values, MCP JSON-RPC bodies, or
    // tool arguments to a different origin through a preserving redirect.
    if ((method !== "GET" && method !== "HEAD") || init?.body != null) {
      throw new PrivateUrlError(to.toString(), "a request body cannot be redirected to another origin")
    }
    for (const name of [
      "authorization",
      "cookie",
      "proxy-authorization",
      "mcp-session-id",
      "last-event-id",
      "x-api-key",
      "api-key",
      "x-auth-token",
      "x-goog-api-key",
    ]) headers.delete(name)
  }

  const switchToGet = (status === 303 && method !== "HEAD")
    || ((status === 301 || status === 302) && method === "POST")
  if (switchToGet) {
    headers.delete("content-length")
    headers.delete("content-type")
    return { ...init, method: "GET", body: undefined, headers, redirect: "manual" }
  }
  return { ...init, headers, redirect: "manual" }
}

function createRedirectSafeFetch(
  fetchImpl: ExternalMcpFetchLike,
  validateUrl: (url: string) => Promise<void>,
): ExternalMcpFetchLike {
  const cancelRedirectBody = async (response: Response) => {
    try {
      await response.body?.cancel()
    } catch {
      // Cancellation is cleanup only and must not replace the hop failure.
    }
  }
  return async (input, init) => {
    let current = new URL(String(input))
    let currentInit: RequestInit = { ...init, redirect: "manual" }
    const seen = new Set<string>()
    for (let redirectCount = 0; ; redirectCount += 1) {
      const key = current.toString()
      if (seen.has(key)) throw new Error("MCP outbound request entered a guarded redirect loop.")
      seen.add(key)
      await validateUrl(key)
      const response = await fetchImpl(current, currentInit)
      const location = response.headers.get("location")
      if (!REDIRECT_STATUSES.has(response.status) || !location) {
        return normalizeResponseRealm(response)
      }
      try {
        if (redirectCount >= MAX_GUARDED_REDIRECTS) {
          throw new Error("MCP outbound request exceeded the guarded redirect limit.")
        }
        const next = new URL(location, current)
        await validateUrl(next.toString())
        currentInit = redirectedRequestInit(currentInit, response.status, current, next)
        current = next
      } finally {
        // Redirect response bodies are never returned. Dispose each hop once,
        // while ensuring a cancel failure cannot hide the causal hop error.
        await cancelRedirectBody(response)
      }
    }
  }
}

export function createGuardedFetch(fetchImpl: ExternalMcpFetchLike = fetch): ExternalMcpFetchLike {
  return createRedirectSafeFetch(fetchImpl, assertPublicUrl)
}

export function createRealmSafeFetch(fetchImpl: ExternalMcpFetchLike = fetch): ExternalMcpFetchLike {
  // Private mode skips DNS/address restrictions only. Redirects still enforce
  // schemes, credential boundaries, downgrade protection, and body replay.
  return createRedirectSafeFetch(fetchImpl, async (rawUrl) => {
    parseHttpUrl(rawUrl)
  })
}
