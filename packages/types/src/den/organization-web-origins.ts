import { z } from "zod"

/** Maximum approved web origins per organization. */
export const ORGANIZATION_WEB_ORIGIN_LIMIT = 20

/**
 * Returns the canonical origin when `value` is an exact HTTPS origin, or null.
 *
 * Exact means: `https:` scheme, a concrete hostname (no wildcard), an optional
 * port, and nothing else — no credentials, path, query, or fragment. A single
 * trailing slash is tolerated because browsers and people commonly paste it.
 */
export function normalizeExactHttpsOrigin(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 255) return null

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }

  if (
    url.protocol !== "https:"
    || !url.hostname
    || url.hostname.includes("*")
    || url.username
    || url.password
    || url.search
    || url.hash
    || url.pathname !== "/"
  ) {
    return null
  }

  const written = (trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed).toLowerCase()
  // Reject inputs whose written form differs from the parsed origin beyond a
  // trailing slash or an explicit default port (for example "https://host/?"
  // or "https://host#"). "https://host:443" is the same origin as "https://host".
  const equivalentForms = [url.origin.toLowerCase()]
  if (url.port === "") equivalentForms.push(`${url.origin.toLowerCase()}:443`)
  if (!equivalentForms.includes(written)) return null

  return url.origin
}

export const organizationWebOriginInputSchema = z.object({
  origin: z.string().trim().min(1).max(255),
}).strict()
export type OrganizationWebOriginInput = z.infer<typeof organizationWebOriginInputSchema>

export const organizationWebOriginSchema = z.object({
  id: z.string().min(1),
  origin: z.string().min(1),
  createdAt: z.string(),
  createdByName: z.string().nullable(),
})
export type OrganizationWebOrigin = z.infer<typeof organizationWebOriginSchema>

export const organizationWebOriginListSchema = z.object({
  origins: z.array(organizationWebOriginSchema).max(ORGANIZATION_WEB_ORIGIN_LIMIT),
  limit: z.number().int().positive(),
})
export type OrganizationWebOriginList = z.infer<typeof organizationWebOriginListSchema>

export const organizationWebOriginErrorCodeSchema = z.enum([
  "invalid_web_origin",
  "web_origin_already_approved",
  "web_origin_limit_reached",
  "web_origin_not_found",
])
export type OrganizationWebOriginErrorCode = z.infer<typeof organizationWebOriginErrorCodeSchema>
