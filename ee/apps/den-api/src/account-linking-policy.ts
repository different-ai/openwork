import type { BetterAuthOptions } from "better-auth"

type DenUserOptions = NonNullable<BetterAuthOptions["user"]>
type ValidateUserInfo = NonNullable<DenUserOptions["validateUserInfo"]>
type AuthEndpointContext = Parameters<ValidateUserInfo>[1]

export const DEN_ACCOUNT_CONFIG = {
  accountLinking: {
    enabled: true,
    // Better Auth checks this before any hook and allows no exception, so it
    // would also refuse a verified-domain SSO sign-in for a person whose
    // password account was never verified. validateDenUserInfo enforces the
    // same rule with that one exception.
    requireLocalEmailVerified: false,
  },
} satisfies NonNullable<BetterAuthOptions["account"]>

export const UNVERIFIED_ACCOUNT_LINK_MESSAGE = "An account with this email exists but its email isn't verified yet. Sign in with your email or reset your password, then try again."
export const SSO_EMAIL_OUTSIDE_DOMAIN_MESSAGE = "Your sign-in provider returned an email outside this organization's verified domain."

/** Whether an email domain is one of the comma-separated configured domains or a subdomain of one. */
export function emailDomainMatches(emailDomain: string, configured: string) {
  return configured.split(",").map((domain) => domain.trim().toLowerCase()).filter(Boolean)
    .some((domain) => emailDomain === domain || emailDomain.endsWith(`.${domain}`))
}

/** A domain-verified SSO provider vouches only for emails on its verified domain. */
async function ssoProviderOwnsEmail(ctx: AuthEndpointContext, providerId: string, email: string) {
  const emailDomain = email.split("@")[1]
  if (!emailDomain) return false
  const provider = await ctx.context.adapter.findOne<Record<string, unknown>>({
    model: "ssoProvider",
    where: [{ field: "providerId", value: providerId }],
  })
  return provider?.domainVerified === true
    && typeof provider.domain === "string"
    && emailDomainMatches(emailDomain, provider.domain)
}

/**
 * The account never proved its email, so whoever created it may not own the
 * address. The verified-domain SSO identity takes it over alone: every earlier
 * way in, the password included, is removed and its sessions end.
 */
async function removeUnprovenSignIns(ctx: AuthEndpointContext, userId: string) {
  for (const account of await ctx.context.internalAdapter.findAccounts(userId)) {
    await ctx.context.internalAdapter.deleteAccount(account.id)
  }
  await ctx.context.internalAdapter.deleteUserSessions(userId)
}

/**
 * Better Auth runs this right before it creates a user or links a provider
 * account to an existing user.
 *
 * - Signing in with Google, GitHub or SSO joins an existing account only when
 *   that account's email is verified, so registering someone else's email
 *   first never captures their identity. A domain-verified SSO provider for
 *   the email's domain proves the address itself: it may link, and the
 *   account's earlier sign-in methods and sessions are removed first.
 * - SSO creates or links only people whose email is on the provider's
 *   verified domain.
 */
export const validateDenUserInfo: ValidateUserInfo = async ({ user, source }, ctx) => {
  const email = typeof user.email === "string" ? user.email.trim().toLowerCase() : ""
  const ssoProviderId = source.method === "sso-oidc" || source.method === "sso-saml" ? source.sso?.providerId : undefined
  if (ssoProviderId && source.action !== "sign-in" && !await ssoProviderOwnsEmail(ctx, ssoProviderId, email)) {
    return { error: "email_outside_sso_domain", errorDescription: SSO_EMAIL_OUTSIDE_DOMAIN_MESSAGE }
  }
  if (source.action !== "link-account" || !email) return

  // Sign-in linking names the existing user it joins. An explicit link by a
  // signed-in user passes the provider's account id instead and is not gated.
  const existing = await ctx.context.internalAdapter.findUserByEmail(email)
  if (!existing || existing.user.id !== user.id || existing.user.emailVerified) return

  if (ssoProviderId) {
    await removeUnprovenSignIns(ctx, existing.user.id)
    return
  }
  return { error: "account_not_linked", errorDescription: UNVERIFIED_ACCOUNT_LINK_MESSAGE }
}

export const DEN_USER_CONFIG = {
  validateUserInfo: validateDenUserInfo,
} satisfies DenUserOptions
