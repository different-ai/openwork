import { isIP } from "node:net"

type Environment = Readonly<Record<string, string | undefined>>

export function gatewayBoolean(value: string | undefined, name: string): boolean {
  if (value === undefined || value === "false") return false
  if (value === "true") return true
  throw new Error(`${name} must be exactly true or false (default: false)`)
}

export function gatewayInteger(value: string | undefined, name: string, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback
  const number = Number(value)
  if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`)
  }
  return number
}

function validHost(host: string): boolean {
  if (isIP(host.replace(/^\[|\]$/g, ""))) return true
  if (host.length > 253 || !host.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) return false
  // mysql: URLs do not normalize numeric hosts. Reject alternate IP spellings
  // before a database client can resolve one to a forbidden loopback address.
  try {
    return new URL(`http://${host}`).hostname === host.toLowerCase()
  } catch {
    return false
  }
}

function localHost(host: string): boolean {
  let normalized = host.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "")
  if (isIP(normalized) === 6) normalized = new URL(`http://[${normalized}]`).hostname.slice(1, -1)
  return normalized === "localhost" || normalized.endsWith(".localhost") || normalized === "localhost.localdomain" || normalized === "0.0.0.0"
    || normalized.startsWith("127.") || normalized === "::1" || normalized === "::"
    || /^::ffff:(?:7f[0-9a-f]{2}:|0:0$)/.test(normalized)
}

export function gatewayOrigin(value: string | undefined, name: string, production: boolean, publicUrl = false): string {
  const message = `${name} must be an exact ${production && publicUrl ? "HTTPS" : "HTTP(S)"} origin without credentials, path, query, or fragment${production ? "; localhost is not allowed in production" : ""}`
  let url: URL
  try {
    url = new URL(value ?? "")
  } catch {
    throw new Error(message)
  }
  const internalHost = !isIP(url.hostname.replace(/^\[|\]$/g, ""))
    && (!url.hostname.includes(".") || /\.(?:local|internal|svc|cluster\.local)$/.test(url.hostname))
  if (!value || value !== value.trim() || !/^https?:\/\/[^/@?#]+\/?$/.test(value) || value.includes("\\") || /:\/?$/.test(value)
    || !["http:", "https:"].includes(url.protocol) || !validHost(url.hostname) || url.username || url.password
    || url.pathname !== "/" || url.search || url.hash || url.port === "0"
    || (production && localHost(url.hostname)) || (production && publicUrl && (url.protocol !== "https:" || internalHost))) {
    throw new Error(message)
  }
  return url.origin
}

// No network/health probes: capability is deployment intent, validated at startup.
export function parseGatewayDeploymentEnv(source: Environment) {
  const enabled = gatewayBoolean(source.GATEWAY_ENABLED, "GATEWAY_ENABLED")
  const proxyBaseUrl = source.GATEWAY_PROXY_BASE_URL ?? source.INFERENCE_PROXY_BASE_URL
  const publicBaseUrl = source.GATEWAY_PUBLIC_BASE_URL
  const production = source.NODE_ENV === "production" || source.OPENWORK_DEV_MODE !== "1"
  let modelsPublicBaseUrl: string | undefined
  // Client destinations are independent of management admission. Optional bad
  // origins must not add startup requirements while management is disabled.
  for (const candidate of [source.INFERENCE_PROXY_BASE_URL, publicBaseUrl]) {
    if (candidate === undefined) continue
    try {
      modelsPublicBaseUrl = gatewayOrigin(candidate, "Models desktop origin", production, true)
      break
    } catch {
      // Try the other public destination before retaining legacy-only behavior.
    }
  }
  if (!enabled) return { enabled, proxyBaseUrl, publicBaseUrl, modelsPublicBaseUrl }

  if (source.OPENWORK_DEV_MODE !== undefined && !["0", "1"].includes(source.OPENWORK_DEV_MODE)) {
    throw new Error("OPENWORK_DEV_MODE must be exactly 0 or 1")
  }
  const proxy = gatewayOrigin(proxyBaseUrl, "GATEWAY_PROXY_BASE_URL (or INFERENCE_PROXY_BASE_URL when absent)", production)
  const publicOrigin = gatewayOrigin(publicBaseUrl, "GATEWAY_PUBLIC_BASE_URL (desktop-reachable)", production, true)
  const mode = source.DB_MODE ?? (source.DATABASE_URL ? "mysql" : "planetscale")
  if (mode === "mysql") {
    let url: URL
    try {
      url = new URL(source.DATABASE_URL ?? "")
    } catch {
      throw new Error("DATABASE_URL must be a valid mysql:// URL with a host, username, and database when GATEWAY_ENABLED=true")
    }
    if (url.protocol !== "mysql:" || !validHost(url.hostname) || !url.username || !/^\/[^/]+$/.test(url.pathname) || url.hash || (url.port && (!/^\d+$/.test(url.port) || Number(url.port) < 1 || Number(url.port) > 65535)) || (production && localHost(url.hostname))) {
      throw new Error("DATABASE_URL must be a valid mysql:// URL with a host, username, database, and valid port; production must not use localhost")
    }
  } else if (mode === "planetscale") {
    if (!source.DATABASE_HOST || !validHost(source.DATABASE_HOST) || (production && localHost(source.DATABASE_HOST))) {
      throw new Error("DATABASE_HOST must be a valid database hostname; production must not use localhost")
    }
    for (const name of ["DATABASE_USERNAME", "DATABASE_PASSWORD"]) {
      if (!source[name]?.trim()) throw new Error(`${name} is required when GATEWAY_ENABLED=true in planetscale mode`)
    }
  } else {
    throw new Error("DB_MODE must be mysql or planetscale")
  }
  if ((source.DEN_DB_ENCRYPTION_KEY?.trim().length ?? 0) < 32) {
    throw new Error("DEN_DB_ENCRYPTION_KEY must contain at least 32 characters when GATEWAY_ENABLED=true")
  }
  return { enabled, proxyBaseUrl: proxy, publicBaseUrl: publicOrigin, modelsPublicBaseUrl: modelsPublicBaseUrl ?? publicOrigin }
}
