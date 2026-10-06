import { eq } from "@openwork-ee/den-db/drizzle"
import { InferenceFreeUsageTable } from "@openwork-ee/den-db/schema"
import { coreHooks } from "../default-registry.js"
import { CORE_HOOK_ORDER } from "../types.js"

// Future owner: freeInference. Free-usage buckets are keyed by an identity
// hash, not an organization, so they are not purged here.

coreHooks.registerTx({
  point: "org.deletion.purge",
  id: "legacy/free-inference/purge-organization-free-usage",
  registrant: "legacy",
  alwaysRun: "cleanup",
  order: CORE_HOOK_ORDER.cleanup + 6,
  handler: async ({ tx, organizationId }) => {
    // Previously orphaned (W0-05).
    await tx.delete(InferenceFreeUsageTable).where(eq(InferenceFreeUsageTable.organization_id, organizationId))
  },
})
