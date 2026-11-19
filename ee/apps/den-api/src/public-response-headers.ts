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
// x-robots-tag is a standard header for search engines, not an internal one.
const SAFE_X_RESPONSE_HEADERS = new Set(["x-content-type-options", "x-robots-tag", "x-audit-next-cursor", "x-audit-snapshot-at", "x-audit-resource-scope"])

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

/**
 * Nothing this API serves belongs in a search index: search engines may fetch
 * a URL but must not list it, follow its links or keep a copy. Sent on every
 * response, as Google's block-indexing guidance asks: the header works for
 * JSON, event streams and files, where a <meta> tag cannot. No robots.txt
 * disallows these paths, because a crawler that may not fetch a URL never
 * sees the rule and can still list the bare link.
 */
export const ROBOTS_HEADER = "X-Robots-Tag"
export const NO_INDEX = "noindex, nofollow, noarchive"

/** Marks the response noindex whatever the handler set, including refusals and errors. */
export async function noIndex(c: { header: (name: string, value: string) => void }, next: () => Promise<void>) {
  await next()
  c.header(ROBOTS_HEADER, NO_INDEX)
}
