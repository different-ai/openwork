const DEFAULT_DESKTOP_HANDOFF_WEB_HOSTS = [
  "app.openworklabs.com",
  "app.openwork.software",
  "*.run.app",
] as const

export type DesktopHandoffUrlOptions = {
  webAppHosts?: readonly string[]
}

function readSingleHeader(value: string | null) {
  const first = value?.split(",")[0]?.trim() ?? ""
  return first || null
}

function normalizeConfiguredHost(value: string) {
  const trimmed = value.trim().toLowerCase().replace(/\.+$/, "")
  if (!trimmed) {
    return null
  }

  if (trimmed.startsWith("*.") || trimmed.startsWith(".")) {
    return trimmed
  }

  try {
    return new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).hostname
  } catch {
    return trimmed.split("/")[0]?.replace(/:\d+$/, "") || null
  }
}

function matchesConfiguredHost(hostname: string, configuredHosts: readonly string[]) {
  const normalized = hostname.trim().toLowerCase().replace(/\.+$/, "")

  for (const host of configuredHosts) {
    const configured = normalizeConfiguredHost(host)
    if (!configured) {
      continue
    }

    if (configured.startsWith("*.")) {
      const suffix = configured.slice(1)
      if (normalized.endsWith(suffix) && normalized.length > suffix.length) {
        return true
      }
      continue
    }

    if (configured.startsWith(".")) {
      if (normalized.endsWith(configured) && normalized.length > configured.length) {
        return true
      }
      continue
    }

    if (normalized === configured) {
      return true
    }
  }

  return false
}

export function isDesktopHandoffWebAppHost(hostname: string, options: DesktopHandoffUrlOptions = {}) {
  const normalized = hostname.trim().toLowerCase()

  if (
    normalized === "localhost"
    || normalized === "0.0.0.0"
    || normalized === "::1"
    || normalized === "[::1]"
    || /^127(?:\.\d{1,3}){3}$/.test(normalized)
  ) {
    return true
  }

  const ipv4Match = normalized.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (ipv4Match) {
    const [first, second, third, fourth] = ipv4Match.slice(1).map(Number)
    const octets = [first, second, third, fourth]
    if (octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)) {
      if (
        first === 10
        || first === 127
        || (first === 172 && second >= 16 && second <= 31)
        || (first === 192 && second === 168)
        || (first === 169 && second === 254)
        || (first === 100 && second >= 64 && second <= 127)
      ) {
        return true
      }
    }
  }

  return normalized.startsWith("app.")
    || matchesConfiguredHost(normalized, [
      ...DEFAULT_DESKTOP_HANDOFF_WEB_HOSTS,
      ...(options.webAppHosts ?? []),
    ])
}

export function withDenProxyPath(origin: string) {
  const url = new URL(origin)
  const pathname = url.pathname.replace(/\/+$/, "")
  if (pathname.toLowerCase().endsWith("/api/den")) {
    return url.toString().replace(/\/+$/, "")
  }
  url.pathname = `${pathname}/api/den`.replace(/\/+/g, "/")
  return url.toString().replace(/\/+$/, "")
}

export function resolveDesktopDenBaseUrl(request: Request, options: DesktopHandoffUrlOptions = {}) {
  const originHeader = readSingleHeader(request.headers.get("origin"))
  if (originHeader) {
    try {
      const originUrl = new URL(originHeader)
      if (
        (originUrl.protocol === "https:" || originUrl.protocol === "http:")
        && isDesktopHandoffWebAppHost(originUrl.hostname, options)
      ) {
        return withDenProxyPath(originUrl.origin)
      }
    } catch {
      // Ignore invalid origins.
    }
  }

  const forwardedProto = readSingleHeader(request.headers.get("x-forwarded-proto"))
  const forwardedHost = readSingleHeader(request.headers.get("x-forwarded-host"))
  const host = readSingleHeader(request.headers.get("host"))
  const protocol = forwardedProto ?? new URL(request.url).protocol.replace(/:$/, "")
  const targetHost = forwardedHost ?? host
  if (!targetHost) {
    return "https://app.openworklabs.com/api/den"
  }

  const origin = `${protocol}://${targetHost}`
  try {
    const url = new URL(origin)
    if (isDesktopHandoffWebAppHost(url.hostname, options)) {
      return withDenProxyPath(url.origin)
    }
  } catch {
    // Ignore invalid forwarded origins.
  }

  return origin
}
