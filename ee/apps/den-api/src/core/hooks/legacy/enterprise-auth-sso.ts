import { and, eq } from "@openwork-ee/den-db/drizzle"
import { ExternalIdentityTable, SsoConnectionTable, SsoProviderTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { APIError } from "better-auth/api"
import { readStringProperty } from "../../../better-auth-values.js"
import { cache } from "../../../cache.js"
import { db } from "../../../db.js"
import {
  findEnterpriseAuthRequirementForEmail,
  findEnterpriseAuthRequirementForEmailDomain,
  findEnterpriseAuthRequirementForUserId,
} from "../../../enterprise-auth-requirement.js"
import {
  authorizeOrganizationSsoSignIn,
  completeOrganizationSsoTestIntent,
  failOrganizationSsoTestIntent,
  getSsoTestIntentIdFromCallbackUrl,
} from "../../../sso-test-lifecycle.js"
import { coreHooks } from "../default-registry.js"
import type { CoreAuthMiddlewareContext } from "../points.js"
import { CORE_HOOK_ORDER } from "../types.js"

// Future owner: enterpriseAuth (external identities are written by SSO and SCIM).

coreHooks.registerTx({
  point: "user.deleting",
  id: "legacy/enterprise-auth-sso/delete-user-external-identities",
  registrant: "legacy",
  alwaysRun: "cleanup",
  order: CORE_HOOK_ORDER.cleanup,
  handler: async ({ tx, userId }) => {
    await tx.delete(ExternalIdentityTable).where(eq(ExternalIdentityTable.userId, userId))
  },
})

coreHooks.registerTx({
  point: "org.deletion.purge",
  id: "legacy/enterprise-auth-sso/purge-organization-sso",
  registrant: "legacy",
  alwaysRun: "cleanup",
  order: CORE_HOOK_ORDER.cleanup + 10,
  handler: async ({ tx, organizationId }) => {
    await tx.delete(SsoProviderTable).where(eq(SsoProviderTable.organizationId, organizationId))
    await tx.delete(SsoConnectionTable).where(eq(SsoConnectionTable.organizationId, organizationId))
    await tx.delete(ExternalIdentityTable).where(eq(ExternalIdentityTable.organizationId, organizationId))
  },
})

// Always denied: turning the module off must not reopen raw SSO endpoints.
coreHooks.registerBootContributor({
  point: "auth.rawMutationDenials",
  id: "legacy/enterprise-auth-sso/raw-sso-mutations",
  registrant: "legacy",
  security: true,
  order: CORE_HOOK_ORDER.security,
  contribute: () => [
    { path: "/sso/register", message: "Use the Den SSO API to manage SSO providers." },
    { path: "/sso/update-provider", message: "Use the Den SSO API to manage SSO providers." },
    { path: "/sso/delete-provider", message: "Use the Den SSO API to manage SSO providers." },
    { path: "/sso/request-domain-verification", message: "Use the Den SSO API to verify SSO domains." },
    { path: "/sso/verify-domain", message: "Use the Den SSO API to verify SSO domains." },
  ],
})

coreHooks.registerBootContributor({
  point: "auth.modelIds",
  id: "legacy/enterprise-auth-sso/model-ids",
  registrant: "legacy",
  contribute: () => ({
    ssoProvider: () => createDenTypeId("ssoProvider"),
    ssoConnection: () => createDenTypeId("ssoConnection"),
    externalIdentity: () => createDenTypeId("externalIdentity"),
  }),
})

// SP-initiated SSO sign-in must target an organization whose SSO is enabled.
coreHooks.registerMiddleware({
  point: "auth.beforePath",
  id: "legacy/enterprise-auth-sso/authorize-sso-sign-in",
  registrant: "legacy",
  order: CORE_HOOK_ORDER.default,
  handler: async ({ ctx, isRequest }) => {
    if (!isRequest || ctx.path !== "/sign-in/sso") return
    const token = await ctx.getSignedCookie(ctx.context.authCookies.sessionToken.name, ctx.context.secret).catch(() => null)
    const session = typeof token === "string" ? await cache.auth.session(token) : null
    const authorization = await authorizeOrganizationSsoSignIn({
      providerId: readStringProperty(ctx.body, "providerId"),
      organizationSlug: readStringProperty(ctx.body, "organizationSlug"),
      domain: readStringProperty(ctx.body, "domain"),
      email: readStringProperty(ctx.body, "email"),
      callbackUrl: readStringProperty(ctx.body, "callbackURL"),
      userId: session?.user.id ?? null,
    })
    if (!authorization.ok) {
      throw new APIError("FORBIDDEN", { message: authorization.message })
    }
  },
})

function removeSsoTestSessionCookie(ctx: CoreAuthMiddlewareContext) {
  const headers = ctx.context.responseHeaders
  if (!headers) return
  const sessionCookiePrefix = `${ctx.context.authCookies.sessionToken.name}=`
  const cookies = headers.getSetCookie().filter((cookie) => !cookie.startsWith(sessionCookiePrefix))
  headers.delete("set-cookie")
  for (const cookie of cookies) {
    headers.append("set-cookie", cookie)
  }
}

// An SSO test sign-in records its result and never leaves a session behind.
coreHooks.registerMiddleware({
  point: "auth.afterPath",
  id: "legacy/enterprise-auth-sso/complete-sso-test-callback",
  registrant: "legacy",
  order: CORE_HOOK_ORDER.guard,
  handler: async ({ ctx }) => {
    if (ctx.path !== "/sso/callback/:providerId" && ctx.path !== "/sso/saml2/sp/acs/:providerId") return
    const callbackUrl = ctx.context.responseHeaders?.get("location") ?? null
    const intentId = getSsoTestIntentIdFromCallbackUrl(callbackUrl)
    const providerId = readStringProperty(ctx.params, "providerId")
    if (!intentId || !providerId) {
      return
    }

    const newSession = ctx.context.newSession
    if (!newSession) {
      await failOrganizationSsoTestIntent(intentId, "authentication")
      return
    }

    await completeOrganizationSsoTestIntent({
      intentId,
      providerId,
      authenticatedUserId: newSession.user.id,
    })
    await ctx.context.internalAdapter.deleteSession(newSession.session.token)
    await cache.auth.revokeSession(newSession.session.token)
    removeSsoTestSessionCookie(ctx)
  },
})

// D32: an account in an organization with an enabled, verified SSO connection
// must sign in through SSO.
coreHooks.registerGuard({
  point: "auth.signInEnforcement",
  id: "legacy/enterprise-auth-sso/require-sso-sign-in",
  registrant: "legacy",
  order: CORE_HOOK_ORDER.guard,
  handler: async (input) => {
    const requirement = input.stage === "credentialSignIn"
      ? await findEnterpriseAuthRequirementForEmail(input.email)
      : await findEnterpriseAuthRequirementForUserId(input.userId)
    if (!requirement) return null
    return {
      code: "sso_required",
      status: 403,
      message: "This account is managed by an organization. Use SSO to sign in.",
      details: { signInPath: requirement.signInPath },
    }
  },
})

async function findOrganizationSsoSignInPath(organizationId: string) {
  const rows = await db
    .select({ signInPath: SsoConnectionTable.signInPath })
    .from(SsoConnectionTable)
    .innerJoin(SsoProviderTable, and(
      eq(SsoConnectionTable.providerId, SsoProviderTable.providerId),
      eq(SsoConnectionTable.organizationId, SsoProviderTable.organizationId),
      eq(SsoProviderTable.domainVerified, true),
    ))
    .where(and(
      eq(SsoConnectionTable.organizationId, normalizeDenTypeId("organization", organizationId)),
      eq(SsoConnectionTable.status, "enabled"),
    ))
    .limit(1)
  return rows[0] ? { signInPath: rows[0].signInPath } : null
}

coreHooks.registerResolver({
  point: "auth.signInMethodResolver",
  id: "legacy/enterprise-auth-sso/resolve-sso-sign-in",
  registrant: "legacy",
  handler: async (input) => {
    if (input.lookup === "emailDomain") {
      return findEnterpriseAuthRequirementForEmailDomain(input.email)
    }
    const connection = await findOrganizationSsoSignInPath(input.organizationId)
    if (!connection) return null
    return {
      organizationId: input.organizationId,
      organizationSlug: input.organizationSlug,
      signInPath: connection.signInPath || `/sso/${encodeURIComponent(input.organizationSlug)}`,
      ssoProviderId: null,
      hasSso: true,
    }
  },
})
