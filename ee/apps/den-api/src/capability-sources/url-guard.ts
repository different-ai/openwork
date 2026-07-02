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

/**
 * Rejects (throws PrivateUrlError) unless the URL is http(s) and its host
 * resolves exclusively to public addresses.
 */
export async function assertPublicUrl(rawUrl: string): Promise<void> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new PrivateUrlError(rawUrl, "not a valid URL")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PrivateUrlError(rawUrl, `protocol "${url.protocol}" is not allowed`)
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

/**
 * A fetch wrapper that re-applies assertPublicUrl to EVERY outbound request
 * — the MCP SDK follows discovery documents to other hosts (authorization
 * servers, token endpoints), and DNS answers can change after create-time
 * validation, so each request is checked at the moment it's made.
 */
export function createGuardedFetch(): FetchLike {
  return async (input, init) => {
    await assertPublicUrl(String(input))
    return fetch(input, init)
  }
}
