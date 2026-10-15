import { and, eq } from "@openwork-ee/den-db/drizzle"
import { AuthAccountTable, AuthUserTable } from "@openwork-ee/den-db/schema"
import { db } from "./db.js"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { env } from "./env.js"
import { deploymentFeatureEnabled } from "./features.js"
import { findEnterpriseAuthRequirementForEmail, findEnterpriseAuthRequirementForEmailDomain } from "./enterprise-auth-requirement.js"
import { getSingletonOrganization, getSingletonSsoStatus, isEmailAllowedForOrganization } from "./orgs.js"
import { isScimDeprovisionedIdentity } from "./scim-deprovisioning.js"
import { resolveEnvironmentOidcIdentityAuthorization, type EnvironmentOidcIdentity } from "./environment-oidc-identity-policy.js"

export async function environmentOidcAvailable() {
  return Boolean(env.oidc) && await deploymentFeatureEnabled("environmentOidc")
}

/** A deployment provider is not an organization SSO provider and cannot satisfy
 * its policy. Never add this provider to a trusted-provider override. */
export async function authorizeEnvironmentOidcIdentity(identity: EnvironmentOidcIdentity) {
  return resolveEnvironmentOidcIdentityAuthorization(identity, {
    available: environmentOidcAvailable,
    enterpriseRequired: async (email) => Boolean(await findEnterpriseAuthRequirementForEmail(email) || await findEnterpriseAuthRequirementForEmailDomain(email)),
    localUser: async (email) => {
      const [user] = await db.select({ id: AuthUserTable.id, emailVerified: AuthUserTable.emailVerified })
        .from(AuthUserTable).where(eq(AuthUserTable.email, email)).limit(1)
      return user ?? null
    },
    linkedUser: async (sub) => {
      if (!env.oidc) return null
      const [linked] = await db.select({ userId: AuthAccountTable.userId, email: AuthUserTable.email })
        .from(AuthAccountTable).innerJoin(AuthUserTable, eq(AuthAccountTable.userId, AuthUserTable.id))
        .where(and(eq(AuthAccountTable.providerId, env.oidc.providerId), eq(AuthAccountTable.accountId, sub))).limit(1)
      return linked ?? null
    },
    installationAllows: async ({ email, userId }) => {
      if (env.orgMode !== "single_org") return true
      if ((await getSingletonSsoStatus()).configured) return false
      const organization = await getSingletonOrganization()
      if (!organization) return true
      if (!isEmailAllowedForOrganization(organization.allowedEmailDomains, email)) return false
      // A new subject has no local ID yet; email tombstones must still be checked.
      return !await isScimDeprovisionedIdentity({ organizationId: organization.id, userId: userId ? normalizeDenTypeId("user", userId) : null, email })
    },
  })
}
