import { eq } from "@openwork-ee/den-db/drizzle"
import { WorkflowRunTable } from "@openwork-ee/den-db/schema"
import { coreHooks } from "../default-registry.js"
import { CORE_HOOK_ORDER } from "../types.js"

// Future owner: workflows.

coreHooks.registerTx({
  point: "org.deletion.purge",
  id: "legacy/workflows/purge-organization-workflow-runs",
  registrant: "legacy",
  alwaysRun: "cleanup",
  order: CORE_HOOK_ORDER.cleanup + 22,
  handler: async ({ tx, organizationId }) => {
    // Previously orphaned (W0-05).
    await tx.delete(WorkflowRunTable).where(eq(WorkflowRunTable.organization_id, organizationId))
  },
})
