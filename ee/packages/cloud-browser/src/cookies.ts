import { isRecord, numberField, stringField } from "./cdp"

/** How long a promoted sign-in cookie lasts. */
export const REMEMBER_LOGIN_MS = 30 * 24 * 60 * 60 * 1_000

/** `Storage.setCookies` input. Host-only cookies keep `url` so they stay host-only. */
export type CookieParam = {
  name: string
  value: string
  url?: string
  domain?: string
  path: string
  secure: boolean
  httpOnly: boolean
  expires: number
  sameSite?: string
  priority?: string
  partitionKey?: string | Record<string, unknown>
}

/**
 * Session cookies (no expiry) vanish when Chrome restarts, which is when a
 * stopped box wakes up. Many sites keep their sign-in in exactly those
 * cookies, so after the person signs in they become persistent for
 * `ttlMs`. Cookies that already expire are left alone.
 *
 * Re-setting a host-only cookie with its `domain` would widen it to every
 * subdomain (and break `__Host-` cookies), so host-only cookies are re-set by
 * `url` instead.
 */
export function cookiesToRemember(cookies: readonly unknown[], nowMs: number, ttlMs: number = REMEMBER_LOGIN_MS): CookieParam[] {
  const expires = Math.floor((nowMs + ttlMs) / 1_000)
  const promoted: CookieParam[] = []
  for (const cookie of cookies) {
    if (!isRecord(cookie)) continue
    const name = stringField(cookie, "name")
    const value = stringField(cookie, "value")
    const domain = stringField(cookie, "domain")
    if (name === undefined || value === undefined || !domain) continue
    const cookieExpires = numberField(cookie, "expires")
    const isSession = cookie.session === true || cookieExpires === undefined || cookieExpires <= 0
    if (!isSession) continue
    const path = stringField(cookie, "path") || "/"
    const secure = cookie.secure === true
    const param: CookieParam = {
      name,
      value,
      path,
      secure,
      httpOnly: cookie.httpOnly === true,
      expires,
    }
    if (domain.startsWith(".")) param.domain = domain
    else param.url = `${secure ? "https" : "http"}://${domain}${path.startsWith("/") ? path : `/${path}`}`
    const sameSite = stringField(cookie, "sameSite")
    if (sameSite) param.sameSite = sameSite
    const priority = stringField(cookie, "priority")
    if (priority) param.priority = priority
    const partitionKey = cookie.partitionKey
    if (typeof partitionKey === "string" || isRecord(partitionKey)) param.partitionKey = partitionKey
    promoted.push(param)
  }
  return promoted
}
