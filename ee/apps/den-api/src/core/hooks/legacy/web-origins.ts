import { eq } from "@openwork-ee/den-db/drizzle"
import { OrganizationWebOriginTable } from "@openwork-ee/den-db/schema"
import { invalidateWebOriginApprovalCache } from "../../../organization-web-origins.js"
import { coreHooks } from "../default-registry.js"
import { CORE_HOOK_ORDER } from "../types.js"

// Future owner: webOrigins.

coreHooks.registerTx({
  point: "org.deletion.purge",
  id: "legacy/web-origins/purge-organization-web-origins",
  registrant: "legacy",
  alwaysRun: "cleanup",
  order: CORE_HOOK_ORDER.cleanup + 15,
  handler: async ({ tx, organizationId }) => {
    await tx.delete(OrganizationWebOriginTable).where(eq(OrganizationWebOriginTable.organizationId, organizationId))
  },
})

coreHooks.registerPostCommit({
  point: "org.deletion.post",
  id: "legacy/web-origins/invalidate-approval-cache",
  registrant: "legacy",
  alwaysRun: "cleanup",
  order: CORE_HOOK_ORDER.default,
  errorPolicy: "propagate",
  handler: async () => {
    invalidateWebOriginApprovalCache()
  },
})
