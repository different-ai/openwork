import { eq } from "@openwork-ee/den-db/drizzle"
import { ExternalIdentityTable } from "@openwork-ee/den-db/schema"
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
