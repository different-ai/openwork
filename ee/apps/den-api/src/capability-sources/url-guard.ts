import { lookup } from "node:dns/promises"
import { isIP } from "node:net"

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
  if (!octets) return true
  const [a, b] = octets
  if (a === 0) return true
  if (a === 10) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 198 && (b === 18 || b === 19)) return true
  if (a >= 224) return true
  return false
}

function parseIpv6Words(address: string): number[] | null {
  let normalized = address.toLowerCase()
  if (normalized.includes("%")) return null

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

function isPrivateIpv6(address: string): boolean {
  const words = parseIpv6Words(address)
  if (!words) return true
  const [first, second, third] = words
  const fifth = words[4]
  const sixth = words[5]

  if (words.slice(0, 7).every((word) => word === 0) && (words[7] === 0 || words[7] === 1)) return true

  if (words.slice(0, 5).every((word) => word === 0) && sixth === 0xffff) {
    return isPrivateIpv4(embeddedIpv4(words, 6))
  }
  if (words.slice(0, 4).every((word) => word === 0) && fifth === 0xffff && sixth === 0) {
    return isPrivateIpv4(embeddedIpv4(words, 6))
  }
  if (words.slice(0, 6).every((word) => word === 0)) return true
  if (
    first === 0x0064
    && second === 0xff9b
    && words.slice(2, 6).every((word) => word === 0)
    && isPrivateIpv4(embeddedIpv4(words, 6))
  ) return true

  if ((first & 0xfe00) === 0xfc00) return true
  if ((first & 0xffc0) === 0xfe80) return true
  if ((first & 0xffc0) === 0xfec0) return true
  if ((first & 0xff00) === 0xff00) return true
  if (first === 0x0100 && words.slice(1, 4).every((word) => word === 0)) return true
  if (first === 0x2001 && second === 0x0db8) return true
  if (first === 0x2001 && second === 0x0002 && third === 0) return true
  if (first === 0x2001 && ((second & 0xfff0) === 0x0010 || (second & 0xfff0) === 0x0020)) return true

  if (first === 0x2002 && isPrivateIpv4(embeddedIpv4(words, 1))) return true
  return false
}

export function isPrivateAddress(address: string): boolean {
  const version = isIP(address)
  if (version === 4) return isPrivateIpv4(address)
  if (version === 6) return isPrivateIpv6(address)
  return true
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

export async function assertPublicUrl(rawUrl: string): Promise<void> {
  const url = parseHttpUrl(rawUrl)
  if (url.protocol !== "https:") {
    throw new PrivateUrlError(rawUrl, "hosted MCP egress requires HTTPS")
  }

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
    for (const name of [
      "authorization",
      "cookie",
      "proxy-authorization",
      "mcp-session-id",
      "last-event-id",
      "x-api-key",
      "x-auth-token",
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
  fetchImpl: FetchLike,
  validateUrl: (url: string) => Promise<void>,
): FetchLike {
  return async (input, init) => {
    let current = new URL(String(input))
    let currentInit: RequestInit = { ...init, redirect: "manual" }
    for (let redirectCount = 0; ; redirectCount += 1) {
      await validateUrl(current.toString())
      const response = await fetchImpl(current, currentInit)
      const location = response.headers.get("location")
      if (!REDIRECT_STATUSES.has(response.status) || !location) {
        return normalizeResponseRealm(response)
      }
      if (init?.redirect === "manual") return normalizeResponseRealm(response)
      if (init?.redirect === "error") {
        await response.body?.cancel()
        throw new Error("MCP outbound request refused a redirect.")
      }
      if (redirectCount >= MAX_GUARDED_REDIRECTS) {
        await response.body?.cancel()
        throw new Error("MCP outbound request exceeded the guarded redirect limit.")
      }
      const next = new URL(location, current)
      await validateUrl(next.toString())
      try {
        currentInit = redirectedRequestInit(currentInit, response.status, current, next)
      } catch (error) {
        await response.body?.cancel()
        throw error
      }
      current = next
      await response.body?.cancel()
    }
  }
}

export function createGuardedFetch(fetchImpl: FetchLike = fetch): FetchLike {
  return createRedirectSafeFetch(fetchImpl, assertPublicUrl)
}

export function createRealmSafeFetch(fetchImpl: FetchLike = fetch): FetchLike {
  return createRedirectSafeFetch(fetchImpl, async (rawUrl) => {
    parseHttpUrl(rawUrl)
  })
}
