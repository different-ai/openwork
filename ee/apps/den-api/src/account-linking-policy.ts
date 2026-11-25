import type { BetterAuthOptions } from "better-auth"

type DenUserOptions = NonNullable<BetterAuthOptions["user"]>
type ValidateUserInfo = NonNullable<DenUserOptions["validateUserInfo"]>
type AuthEndpointContext = Parameters<ValidateUserInfo>[1]

export const DEN_ACCOUNT_CONFIG = {
  accountLinking: {
    enabled: true,
    requireLocalEmailVerified: false,
  },
} satisfies NonNullable<BetterAuthOptions["account"]>

export const UNVERIFIED_ACCOUNT_LINK_MESSAGE = "An account with this email exists but its email isn't verified yet. Sign in with your email or reset your password, then try again."
export const SSO_EMAIL_OUTSIDE_DOMAIN_MESSAGE = "Your sign-in provider returned an email outside this organization's verified domain."

export function emailDomainMatches(emailDomain: string, configured: string) {
  return configured.split(",").map((domain) => domain.trim().toLowerCase()).filter(Boolean)
    .some((domain) => emailDomain === domain || emailDomain.endsWith(`.${domain}`))
}

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

async function removeUnprovenSignIns(ctx: AuthEndpointContext, userId: string) {
  for (const account of await ctx.context.internalAdapter.findAccounts(userId)) {
    await ctx.context.internalAdapter.deleteAccount(account.id)
  }
  await ctx.context.internalAdapter.deleteUserSessions(userId)
}

const EMAIL_FOLLOWED_OAUTH_PROVIDERS = new Set(["google"])


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
      if (holder.user.id !== input.userId) {
        ctx.context.logger.warn("sign-in email not followed: another account already has the provider's email", {
          userId: input.userId,
          otherUserId: holder.user.id,
          providerId: input.ssoProviderId ?? input.oauthProviderId,
        })
      }
      return
    }

    const emailVerified = input.ssoProviderId ? input.emailVerified || stored.emailVerified : input.emailVerified
    await ctx.context.internalAdapter.updateUser(input.userId, { email: input.email, emailVerified })
  } catch (error) {
    ctx.context.logger.error("sign-in email not followed: the update failed", error)
  }
}

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

    const existing = await ctx.context.internalAdapter.findUserByEmail(email)
    if (!existing || existing.user.id !== user.id || existing.user.emailVerified) return

    if (ssoProviderId) {
      await removeUnprovenSignIns(ctx, existing.user.id)
      return
    }
    return { error: "account_not_linked", errorDescription: UNVERIFIED_ACCOUNT_LINK_MESSAGE }
  }
}

export function denUserConfig() {
  return { validateUserInfo: createValidateDenUserInfo() } satisfies DenUserOptions
}
