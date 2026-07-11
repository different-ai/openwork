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
  constructor(url: string, detail: string) {
    super(`URL "${url}" is not allowed: ${detail}`)
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

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase()
  // IPv4-mapped (::ffff:a.b.c.d) — judge by the embedded IPv4.
  const mappedMatch = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mappedMatch) return isPrivateIpv4(mappedMatch[1])
  if (normalized === "::" || normalized === "::1") return true // unspecified / loopback
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true // fc00::/7 unique-local
  if (normalized.startsWith("fe8") || normalized.startsWith("fe9")
    || normalized.startsWith("fea") || normalized.startsWith("feb")) return true // fe80::/10 link-local
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

/**
 * Rejects (throws PrivateUrlError) unless the URL is http(s) and its host
 * resolves exclusively to public addresses.
 */
export async function assertPublicUrl(rawUrl: string): Promise<void> {
  const url = parseHttpUrl(rawUrl)

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
    addresses = await lookup(hostname, { all: true, verbatim: true })
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

type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>
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
  return new globalThis.Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  })
}

function redirectedRequestInit(init: RequestInit | undefined, status: number, from: URL, to: URL): RequestInit {
  const headers = new Headers(init?.headers)
  if (from.protocol === "https:" && to.protocol !== "https:") {
    throw new PrivateUrlError(to.toString(), "an HTTPS request cannot redirect to a less secure protocol")
  }

  const method = (init?.method ?? "GET").toUpperCase()
  if (from.origin !== to.origin) {
    if ((method !== "GET" && method !== "HEAD") || init?.body != null) {
      throw new PrivateUrlError(to.toString(), "a request body cannot be redirected to another origin")
    }
    for (const name of [...headers.keys()]) {
      if (/^(authorization|cookie|proxy-authorization|mcp-session-id|last-event-id)$/iu.test(name)
        || /(?:^|[-_])(?:api[-_]?key|token|session|resume)(?:[-_]|$)/iu.test(name)
      ) headers.delete(name)
    }
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
  fetchImpl: FetchLike,
  validateUrl: (url: string) => Promise<void>,
): FetchLike {
  return async (input, init) => {
    let current = parseHttpUrl(String(input))
    let currentInit: RequestInit = { ...init, redirect: "manual" }
    for (let redirectCount = 0; ; redirectCount += 1) {
      await validateUrl(current.toString())
      const response = await fetchImpl(current, currentInit)
      const location = response.headers.get("location")
      if (!REDIRECT_STATUSES.has(response.status) || !location) {
        return normalizeResponseRealm(response)
      }
      try {
        if (redirectCount >= MAX_GUARDED_REDIRECTS) {
          throw new Error("MCP outbound request exceeded the guarded redirect limit.")
        }
        const next = parseHttpUrl(new URL(location, current).toString())
        await validateUrl(next.toString())
        currentInit = redirectedRequestInit(currentInit, response.status, current, next)
        current = next
      } finally {
        // A redirect response is never returned to the caller. Always release
        // its body exactly once, including when Location parsing, per-hop SSRF
        // validation, downgrade/body-replay checks, or the hop cap rejects it.
        await response.body?.cancel().catch(() => undefined)
      }
    }
  }
}

/**
 * A fetch wrapper that re-applies assertPublicUrl to EVERY outbound request
 * — the MCP SDK follows discovery documents to other hosts (authorization
 * servers, token endpoints), and DNS answers can change after create-time
 * validation, so each request is checked at the moment it's made.
 */
export function createGuardedFetch(fetchImpl: FetchLike = fetch): FetchLike {
  return createRedirectSafeFetch(fetchImpl, assertPublicUrl)
}

export function createRealmSafeFetch(fetchImpl: FetchLike = fetch): FetchLike {
  return createRedirectSafeFetch(fetchImpl, async (rawUrl) => {
    parseHttpUrl(rawUrl)
  })
}
