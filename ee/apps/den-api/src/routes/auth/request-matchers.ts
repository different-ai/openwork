/** Which Better Auth endpoint a proxied request targets. Pure, so tests can load it without booting auth. */

export function getBetterAuthProxyPath(pathname: string) {
  const prefix = "/api/auth"
  if (!pathname.startsWith(prefix)) {
    return pathname
  }

  return pathname.slice(prefix.length) || "/"
}

export function isBetterAuthOrganizationCreationRequest(request: Request) {
  const url = new URL(request.url)
  return request.method.toUpperCase() === "POST" && getBetterAuthProxyPath(url.pathname) === "/organization/create"
}

export function isBetterAuthSetActiveOrganizationRequest(request: Request) {
  const url = new URL(request.url)
  return request.method.toUpperCase() === "POST" && getBetterAuthProxyPath(url.pathname) === "/organization/set-active"
}

export function isBetterAuthEmailPasswordRequest(request: Request) {
  const url = new URL(request.url)
  const path = getBetterAuthProxyPath(url.pathname)
  return request.method.toUpperCase() === "POST" && (path === "/sign-in/email" || path === "/sign-up/email")
}

// Email OTP sign-in issues a session (and creates unknown users) just like
// email/password, so SSO-only deployments must reject it as well.
export function isBetterAuthEmailOtpSignInRequest(request: Request) {
  const url = new URL(request.url)
  return request.method.toUpperCase() === "POST" && getBetterAuthProxyPath(url.pathname) === "/sign-in/email-otp"
}

export function isBetterAuthEmailSignupRequest(request: Request) {
  const url = new URL(request.url)
  return request.method.toUpperCase() === "POST" && getBetterAuthProxyPath(url.pathname) === "/sign-up/email"
}

export function isBetterAuthSignOutRequest(request: Request) {
  const url = new URL(request.url)
  return request.method.toUpperCase() === "POST" && getBetterAuthProxyPath(url.pathname) === "/sign-out"
}
