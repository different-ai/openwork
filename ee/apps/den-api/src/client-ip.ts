import { BlockList, isIP } from "node:net"
import { CLIENT_IP_SIGNATURE_HEADER, SIGNED_CLIENT_IP_HEADER, verifyClientIpSignature } from "@openwork-ee/utils/client-ip-signature"

export const RESOLVED_CLIENT_IP_HEADER = "x-openwork-resolved-client-ip"

export const DEFAULT_CLIENT_IP_HEADERS = ["x-forwarded-for", "x-real-ip", "cf-connecting-ip"] as const
export const CLIENT_IP_IPV6_SUBNET = 64

export type ClientIpSource = "signed" | "header" | "none"

export type ClientIpResolution = {
  ip: string | null
  source: ClientIpSource
  header: string | null
}

export type ClientIpOptions = {
  headers: readonly string[]
  trustedProxies: readonly string[]
  signedClientIpSecret?: string | null
  now?: number
}

type ParsedProxies = { list: BlockList; count: number }

const proxyCache = new Map<string, ParsedProxies>()

function parseTrustedProxies(entries: readonly string[]): ParsedProxies {
  const cacheKey = entries.join(",")
  const cached = proxyCache.get(cacheKey)
  if (cached) return cached
  const list = new BlockList()
  let count = 0
  for (const entry of entries) {
    const slash = entry.lastIndexOf("/")
    const address = slash === -1 ? entry : entry.slice(0, slash)
    const family = isIP(address)
    if (family === 0) continue
    const maxBits = family === 4 ? 32 : 128
    const prefix = slash === -1 ? maxBits : Number(entry.slice(slash + 1))
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxBits) continue
    list.addSubnet(address, prefix, family === 4 ? "ipv4" : "ipv6")
    count += 1
  }
  const parsed = { list, count }
  proxyCache.set(cacheKey, parsed)
  return parsed
}

function mappedIpv4(ip: string) {
  const match = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip)
  return match?.[1] && isIP(match[1]) === 4 ? match[1] : null
}

function expandIpv6(ip: string) {
  const [head = "", tail] = ip.split("::")
  const left = head ? head.split(":") : []
  const right = tail ? tail.split(":") : []
  const missing = tail === undefined ? 0 : 8 - left.length - right.length
  return [...left, ...Array<string>(missing).fill("0"), ...right].map((group) => group.padStart(4, "0").toLowerCase())
}

export function normalizeClientIp(value: string): string | null {
  const ip = value.trim()
  const family = isIP(ip)
  if (family === 4) return ip
  if (family !== 6) return null
  const ipv4 = mappedIpv4(ip)
  if (ipv4) return ipv4
  if (ip.includes(".")) return ip.toLowerCase()
  const keep = CLIENT_IP_IPV6_SUBNET / 16
  return expandIpv6(ip).map((group, index) => (index < keep ? group : "0000")).join(":")
}

function isTrustedProxy(ip: string, proxies: ParsedProxies) {
  const address = mappedIpv4(ip) ?? ip
  const family = isIP(address)
  if (family === 0) return false
  return proxies.list.check(address, family === 4 ? "ipv4" : "ipv6")
}

function readForwardedFor(value: string, proxies: ParsedProxies) {
  const chain = value.split(",").map((entry) => entry.trim()).filter(Boolean)
  if (chain.length === 0) return null
  if (proxies.count > 0) {
    for (let index = chain.length - 1; index >= 0; index -= 1) {
      const entry = chain[index]
      if (!entry || isIP(entry) === 0) return null
      if (isTrustedProxy(entry, proxies)) continue
      return normalizeClientIp(entry)
    }
    return null
  }
  return chain.length === 1 && chain[0] ? normalizeClientIp(chain[0]) : null
}

function readSignedClientIp(headers: Headers, secret: string, now: number) {
  const value = headers.get(SIGNED_CLIENT_IP_HEADER)?.trim() ?? ""
  const signature = headers.get(CLIENT_IP_SIGNATURE_HEADER) ?? ""
  return value && verifyClientIpSignature(secret, value, signature, now) ? normalizeClientIp(value) : null
}

export function resolveClientIp(headers: Headers, options: ClientIpOptions): ClientIpResolution {
  const signed = options.signedClientIpSecret ? readSignedClientIp(headers, options.signedClientIpSecret, options.now ?? Date.now()) : null
  if (signed) return { ip: signed, source: "signed", header: SIGNED_CLIENT_IP_HEADER }
  const proxies = parseTrustedProxies(options.trustedProxies)
  for (const name of options.headers) {
    const header = name.toLowerCase()
    if (header === RESOLVED_CLIENT_IP_HEADER || header === SIGNED_CLIENT_IP_HEADER) continue
    const value = headers.get(header)
    if (!value) continue
    const ip = header === "x-forwarded-for" ? readForwardedFor(value, proxies) : normalizeClientIp(value.split(",")[0] ?? "")
    if (ip) return { ip, source: "header", header }
  }
  return { ip: null, source: "none", header: null }
}

export function clientIpRateLimitKey(resolution: ClientIpResolution) {
  return resolution.ip ?? "unknown"
}

export function withResolvedClientIp(request: Request, resolution: ClientIpResolution) {
  const headers = new Headers(request.headers)
  headers.delete(RESOLVED_CLIENT_IP_HEADER)
  if (resolution.ip) headers.set(RESOLVED_CLIENT_IP_HEADER, resolution.ip)
  return new Request(request, { headers })
}
