export type LoginOptionKind = "sso" | "google" | "github" | "password" | "new_account"

export type LoginOptionAccount = {
  providerId: string
  hasPassword: boolean
}

const BETTER_AUTH_SECURE_SESSION_COOKIES = [
  "__Secure-openwork-den.session_token",
  "__Secure-better-auth.session_token",
] as const

export function buildLoginOptionsSessionCookieClearHeaders(cookieDomain?: string) {
  const normalizedDomain = cookieDomain?.trim().toLowerCase()
  return BETTER_AUTH_SECURE_SESSION_COOKIES.flatMap((cookieName) => {
    const expiredCookie = `${cookieName}=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; HttpOnly; SameSite=Lax`
    return normalizedDomain ? [`${expiredCookie}; Domain=${normalizedDomain}`, expiredCookie] : [expiredCookie]
  })
}

export function normalizeLoginEmail(email: string) {
  return email.trim().toLowerCase()
}

function normalizeProviderId(providerId: string) {
  return providerId.trim().toLowerCase()
}

function isPasswordAccount(account: LoginOptionAccount) {
  const providerId = normalizeProviderId(account.providerId)
  return account.hasPassword || providerId === "credential" || providerId === "email" || providerId === "email-password"
}

function hasProvider(accounts: readonly LoginOptionAccount[], providerId: string) {
  return accounts.some((account) => normalizeProviderId(account.providerId) === providerId)
}

export function resolveLoginOptionKind(input: {
  requireSso: boolean
  accounts: readonly LoginOptionAccount[]
  allowNewAccount?: boolean
}): LoginOptionKind {
  if (input.requireSso) {
    return "sso"
  }

  if (hasProvider(input.accounts, "google")) {
    return "google"
  }

  if (input.accounts.some(isPasswordAccount)) {
    return "password"
  }

  if (hasProvider(input.accounts, "github")) {
    return "github"
  }

  return input.allowNewAccount === false ? "password" : "new_account"
}
