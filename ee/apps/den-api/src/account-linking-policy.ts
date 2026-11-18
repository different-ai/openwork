import type { BetterAuthOptions } from "better-auth"

type DenUserOptions = NonNullable<BetterAuthOptions["user"]>
type ValidateUserInfo = NonNullable<DenUserOptions["validateUserInfo"]>
type AuthEndpointContext = Parameters<ValidateUserInfo>[1]

export const DEN_ACCOUNT_CONFIG = {
  accountLinking: {
    enabled: true,
    // Better Auth checks this before any hook and allows no exception, so it
    // would also refuse a verified-domain SSO sign-in for a person whose
    // password account was never verified. denUserConfig's validateUserInfo
    // enforces the same rule with that one exception.
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

/** Sign-in methods whose verified email is the person's directory identity. GitHub's primary email is a preference people switch between addresses, so it never moves the account. */
const EMAIL_FOLLOWED_OAUTH_PROVIDERS = new Set(["google"])


/**
 * A returning Google or SSO sign-in is found by the provider's own id, so it
 * keeps opening the same account after the person's email changes at the
 * provider (a rename in the company directory). The stored email used to stay
 * behind, and the next sign-in that is found by email (SSO whose subject is
 * the email, an invitation) then created a second account for the same person.
 * The account's email follows the provider instead.
 *
 * Only when the provider proves the new address (Google verified it, or it is
 * on the SSO provider's verified domain) and no other account has it. Never
 * fails the sign-in: Better Auth rejects a sign-in whose hook throws.
 */
async function followProviderEmail(
  ctx: AuthEndpointContext,
  input: { userId: string; email: string; emailVerified: boolean; oauthProviderId?: string; ssoProviderId?: string },
) {
  try {
    if (!input.ssoProviderId && !(input.emailVerified && input.oauthProviderId !== undefined && EMAIL_FOLLOWED_OAUTH_PROVIDERS.has(input.oauthProviderId))) return

    const stored = await ctx.context.internalAdapter.findUserById(input.userId)
    if (!stored || stored.email.trim().toLowerCase() === input.email) return
    if (input.ssoProviderId && !await ssoProviderOwnsEmail(ctx, input.ssoProviderId, input.email)) return

    const holder = await ctx.context.internalAdapter.findUserByEmail(input.email)
    if (holder) {
      // Two accounts for what the provider says is one address. Joining them
      // moves memberships and data, so it is a person's decision, not a sign-in's.
      if (holder.user.id !== input.userId) {
        ctx.context.logger.warn("sign-in email not followed: another account already has the provider's email", {
          userId: input.userId,
          otherUserId: holder.user.id,
          providerId: input.ssoProviderId ?? input.oauthProviderId,
        })
      }
      return
    }

    // The old address's verification says nothing about the new one, so the
    // provider has to vouch for it: Google by verifying it, SSO by owning its
    // domain. SSO never makes an unverified account verified.
    const emailVerified = input.ssoProviderId ? input.emailVerified || stored.emailVerified : input.emailVerified
    await ctx.context.internalAdapter.updateUser(input.userId, { email: input.email, emailVerified })
  } catch (error) {
    ctx.context.logger.error("sign-in email not followed: the update failed", error)
  }
}

/**
 * Better Auth runs this right before it creates a user, links a provider
 * account to an existing user, or signs a returning Google, GitHub or SSO
 * user in.
 *
 * - Signing in with Google, GitHub or SSO joins an existing account only when
 *   that account's email is verified, so registering someone else's email
 *   first never captures their identity. A domain-verified SSO provider for
 *   the email's domain proves the address itself: it may link, and the
 *   account's earlier sign-in methods and sessions are removed first.
 * - SSO creates or links only people whose email is on the provider's
 *   verified domain.
 * - A returning Google or SSO sign-in whose provider reports a new email moves
 *   the account to it (followProviderEmail).
 */
function createValidateDenUserInfo(): ValidateUserInfo {
  return async ({ user, source }, ctx) => {
    const email = typeof user.email === "string" ? user.email.trim().toLowerCase() : ""
    const ssoProviderId = source.method === "sso-oidc" || source.method === "sso-saml" ? source.sso?.providerId : undefined
    if (ssoProviderId && source.action !== "sign-in" && !await ssoProviderOwnsEmail(ctx, ssoProviderId, email)) {
      return { error: "email_outside_sso_domain", errorDescription: SSO_EMAIL_OUTSIDE_DOMAIN_MESSAGE }
    }
    if (source.action === "sign-in" && email && typeof user.id === "string") {
      await followProviderEmail(ctx, {
        userId: user.id,
        email,
        emailVerified: user.emailVerified === true,
        oauthProviderId: source.method === "oauth" ? source.oauth?.providerId : undefined,
        ssoProviderId,
      })
      return
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
}

/** Den's Better Auth `user` options. */
export function denUserConfig() {
  return { validateUserInfo: createValidateDenUserInfo() } satisfies DenUserOptions
}
