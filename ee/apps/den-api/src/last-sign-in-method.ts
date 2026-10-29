/**
 * Remembers how a person last signed in (password, Google or GitHub) in a
 * long-lived browser cookie, so Den web can skip the email step next time and
 * mark that method "Last used". SSO sign-ins never set it and clear it: SSO
 * always starts from the email step, which finds the organization.
 *
 * The cookie only names a method. It holds no email and is not an
 * authentication secret, so Den web reads it in the browser (not HttpOnly).
 * Feature: `lastUsedSignIn`.
 */

export const LAST_SIGN_IN_METHOD_COOKIE = "openwork-last-sign-in"

/** Browsers cap cookie lifetime at 400 days. */
export const LAST_SIGN_IN_METHOD_MAX_AGE_SECONDS = 400 * 24 * 60 * 60

export const LAST_SIGN_IN_METHODS = ["password", "google", "github"] as const

export type LastSignInMethod = (typeof LAST_SIGN_IN_METHODS)[number]

export type LastSignInCookieChange =
  | { type: "remember"; method: LastSignInMethod }
  | { type: "forget" }

const SSO_CALLBACK_PATHS = new Set(["/sso/callback/:providerId", "/sso/saml2/sp/acs/:providerId"])
const PASSWORD_PATHS = new Set(["/sign-in/email", "/sign-up/email"])
const SOCIAL_PATHS = new Set(["/callback/:id", "/sign-in/social"])

export function isLastSignInMethod(value: unknown): value is LastSignInMethod {
  return typeof value === "string" && LAST_SIGN_IN_METHODS.some((method) => method === value)
}

/**
 * What a finished Better Auth request means for the cookie. Only requests that
 * created a session change it; `provider` is the social provider id from the
 * callback route or the sign-in body.
 */
export function lastSignInCookieChange(input: {
  path: string
  provider: string | null
  signedIn: boolean
}): LastSignInCookieChange | null {
  if (!input.signedIn) return null
  if (SSO_CALLBACK_PATHS.has(input.path)) return { type: "forget" }
  if (PASSWORD_PATHS.has(input.path)) return { type: "remember", method: "password" }
  if (SOCIAL_PATHS.has(input.path)) {
    const provider = input.provider?.trim().toLowerCase() ?? null
    return provider === "google" || provider === "github" ? { type: "remember", method: provider } : null
  }
  return null
}

export type LastSignInCookieWrite = {
  name: string
  value: string
  options: {
    maxAge: number
    path: "/"
    sameSite: "lax"
    secure: boolean
    httpOnly: false
    domain?: string
  }
}

/**
 * The Set-Cookie writes for a change. Forgetting expires both the host-only
 * cookie and the one on the shared cookie domain, whichever the browser kept.
 */
export function lastSignInCookieWrites(change: LastSignInCookieChange, input: {
  secure: boolean
  cookieDomain?: string | null
}): LastSignInCookieWrite[] {
  const domain = input.cookieDomain?.trim().replace(/^\.+/u, "").toLowerCase() || undefined
  const base = { path: "/" as const, sameSite: "lax" as const, secure: input.secure, httpOnly: false as const }
  if (change.type === "remember") {
    return [{
      name: LAST_SIGN_IN_METHOD_COOKIE,
      value: change.method,
      options: { ...base, maxAge: LAST_SIGN_IN_METHOD_MAX_AGE_SECONDS, ...(domain ? { domain } : {}) },
    }]
  }
  const expired = { name: LAST_SIGN_IN_METHOD_COOKIE, value: "", options: { ...base, maxAge: 0 } }
  return domain ? [expired, { ...expired, options: { ...expired.options, domain } }] : [expired]
}
