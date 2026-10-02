const INTERNAL_RESPONSE_HEADERS = new Set([
  "alt-svc",
  "cf-cache-status",
  "cf-ray",
  "rndr-id",
  "server",
  "via",
  "x-amzn-trace-id",
  "x-envoy-upstream-service-time",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-prefix",
  "x-forwarded-proto",
  "x-real-ip",
  "x-render-origin-server",
  "x-request-id",
  "x-vercel-id",
])
const SAFE_X_RESPONSE_HEADERS = new Set(["x-content-type-options", "x-audit-next-cursor", "x-audit-snapshot-sequence", "x-audit-resource-scope"])

function isInternalResponseHeader(name: string) {
  const normalized = name.toLowerCase()
  return !SAFE_X_RESPONSE_HEADERS.has(normalized)
    && (INTERNAL_RESPONSE_HEADERS.has(normalized) || normalized.startsWith("x-"))
}

function sanitizeExposeHeaders(headers: Headers) {
  const exposedHeaders = headers.get("access-control-expose-headers")
  if (!exposedHeaders) return

  const safeHeaders = exposedHeaders
    .split(",")
    .map((header) => header.trim())
    .filter((header) => header && !isInternalResponseHeader(header))
  if (safeHeaders.length > 0) {
    headers.set("access-control-expose-headers", safeHeaders.join(", "))
  } else {
    headers.delete("access-control-expose-headers")
  }
}

export function sanitizePublicResponseHeaders(headers: Headers) {
  const internalHeaders: string[] = []
  headers.forEach((_value, name) => {
    if (isInternalResponseHeader(name)) internalHeaders.push(name)
  })
  for (const name of internalHeaders) headers.delete(name)
  sanitizeExposeHeaders(headers)
}
