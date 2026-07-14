type PublicRequestUrlOptions = {
  trustedOrigins?: readonly string[]
}

function firstForwardedValue(value: string | null): string | null {
  const first = value?.split(",", 1)[0]?.trim()
  return first || null
}

function isTrustedOrigin(origin: string, trustedOrigins: readonly string[]): boolean {
  return trustedOrigins.some((entry) => {
    if (!entry || entry === "*") return false
    try {
      return new URL(entry).origin === origin
    } catch {
      return false
    }
  })
}

function forwardedOrigin(request: Request, protocol: string, trustedOrigins: readonly string[]): URL | null {
  const host = firstForwardedValue(request.headers.get("x-forwarded-host"))
  if (!host) return null

  try {
    const candidate = new URL(`${protocol}//${host}`)
    if (
      candidate.username
      || candidate.password
      || candidate.pathname !== "/"
      || candidate.search
      || candidate.hash
      || !isTrustedOrigin(candidate.origin, trustedOrigins)
    ) {
      return null
    }
    return candidate
  } catch {
    return null
  }
}

export function publicRequestUrl(request: Request, options: PublicRequestUrlOptions = {}): URL {
  const url = new URL(request.url)
  const proto = firstForwardedValue(request.headers.get("x-forwarded-proto"))?.toLowerCase()
  if (proto === "https" || proto === "http") {
    url.protocol = `${proto}:`
  }

  const forwarded = forwardedOrigin(request, url.protocol, options.trustedOrigins ?? [])
  if (forwarded) {
    url.hostname = forwarded.hostname
    url.port = forwarded.port
  }
  return url
}

/**
 * Appends an API route to a configured public base URL without discarding a
 * reverse-proxy pathname prefix (for example `/api/den`). `new URL("/v1/...",
 * base)` is deliberately not used here because a leading slash resets the
 * pathname to the public origin root.
 */
export function appendPublicApiPath(baseUrl: string, routePath: string): string {
  const url = new URL(baseUrl)
  const basePath = url.pathname.replace(/\/+$/, "")
  const normalizedRoutePath = routePath.replace(/^\/+/, "")
  url.pathname = `${basePath === "/" ? "" : basePath}/${normalizedRoutePath}`
  url.search = ""
  url.hash = ""
  return url.toString()
}

function isLocalPublicApiHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  return normalized === "localhost"
    || normalized.endsWith(".localhost")
    || normalized === "127.0.0.1"
    || normalized === "::1"
}

export function normalizeConfiguredPublicApiBaseUrl(
  value: string | undefined,
  options: { allowInsecureHttp: boolean },
): string | undefined {
  const configured = value?.trim()
  if (!configured) return undefined

  let url: URL
  try {
    url = new URL(configured)
  } catch {
    throw new Error("DEN_API_PUBLIC_URL must be an absolute http or https URL.")
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("DEN_API_PUBLIC_URL must be an absolute http or https URL.")
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("DEN_API_PUBLIC_URL cannot contain credentials, a query string, or a fragment.")
  }
  if (url.protocol !== "https:" && !options.allowInsecureHttp && !isLocalPublicApiHost(url.hostname)) {
    throw new Error("DEN_API_PUBLIC_URL must use HTTPS outside development and localhost.")
  }

  const pathname = url.pathname.replace(/\/+$/, "")
  return `${url.origin}${pathname === "/" ? "" : pathname}`
}
