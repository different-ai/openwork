import { createHash, timingSafeEqual } from "node:crypto"

export const CONNECT_DEBUG_PROXY_KEY_HEADER = "x-connect-debug-proxy-key"
export const CONNECT_DEBUG_PROXY_DEFAULT_UPSTREAM = "https://app.openworklabs.com"
export const CONNECT_DEBUG_PROXY_LOCAL_ACCESS_KEY = "local-connect-debug-proxy"

export type ConnectDebugProxyConfig = {
  accessKey: string
  allowedUpstreams: readonly string[]
  defaultUpstream: string
  errors: readonly string[]
  flakyWindowMs: number
  slowMs: number
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
}

function normalizedRootOrigin(value: string): string | null {
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`)
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname)))
      || url.username || url.password || (url.pathname !== "/" && url.pathname !== "")
      || url.search || url.hash) return null
    return url.origin
  } catch {
    return null
  }
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback
}

function configuredAllowedUpstreams(value: string | undefined): readonly string[] {
  if (!value) return []
  return [...new Set(value.split(",").map((item) => normalizedRootOrigin(item.trim())).filter((item): item is string => Boolean(item)))]
}

export function connectDebugProxyConfig(): ConnectDebugProxyConfig {
  const hosted = Boolean(process.env.VERCEL)
  const configuredDefault = process.env.DEBUG_PROXY_DEFAULT_UPSTREAM?.trim() || CONNECT_DEBUG_PROXY_DEFAULT_UPSTREAM
  const defaultUpstream = normalizedRootOrigin(configuredDefault) ?? ""
  const accessKey = process.env.DEBUG_PROXY_ACCESS_KEY ?? (hosted ? "" : CONNECT_DEBUG_PROXY_LOCAL_ACCESS_KEY)
  const allowedUpstreams = configuredAllowedUpstreams(process.env.DEBUG_PROXY_ALLOWED_UPSTREAMS)
  const errors: string[] = []
  if (!defaultUpstream) errors.push("DEBUG_PROXY_DEFAULT_UPSTREAM")
  if (!accessKey || (hosted && (!/^[A-Za-z0-9._~-]+$/u.test(accessKey) || accessKey.length < 16))) {
    errors.push("DEBUG_PROXY_ACCESS_KEY")
  }
  return {
    accessKey,
    allowedUpstreams,
    defaultUpstream,
    errors,
    flakyWindowMs: boundedInteger(process.env.DEBUG_PROXY_FLAKY_WINDOW_MS, 60_000, 1_000, 3_600_000),
    slowMs: boundedInteger(process.env.DEBUG_PROXY_SLOW_MS, 7_000, 5_000, 10_000),
  }
}

export function accessKeyMatches(supplied: string | null | undefined, expected: string): boolean {
  const suppliedDigest = createHash("sha256").update(supplied ?? "").digest()
  const expectedDigest = createHash("sha256").update(expected).digest()
  return Boolean(expected) && timingSafeEqual(suppliedDigest, expectedDigest)
}

export function encodeUpstreamParameter(origin: string): string {
  return `~${Buffer.from(origin, "utf8").toString("base64url")}`
}

export function decodeUpstreamParameter(parameter: string): string | null {
  if (!parameter.startsWith("~") || parameter.length > 700) return null
  try {
    const decoded = Buffer.from(parameter.slice(1), "base64url").toString("utf8")
    if (encodeUpstreamParameter(decoded) !== parameter) return null
    return normalizedRootOrigin(decoded)
  } catch {
    return null
  }
}

export function allowedUpstreamOverride(parameter: string, config: ConnectDebugProxyConfig): string | null {
  const decoded = decodeUpstreamParameter(parameter)
  if (!decoded) return null
  const decodedHost = new URL(decoded).host.toLowerCase()
  return config.allowedUpstreams.some((allowed) => new URL(allowed).host.toLowerCase() === decodedHost)
    ? decoded
    : null
}
