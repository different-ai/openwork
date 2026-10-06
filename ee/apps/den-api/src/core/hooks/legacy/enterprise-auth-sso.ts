import { eq } from "@openwork-ee/den-db/drizzle"
import { ExternalIdentityTable, SsoConnectionTable, SsoProviderTable } from "@openwork-ee/den-db/schema"
import { coreHooks } from "../default-registry.js"
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
