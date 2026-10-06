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

// Workflows/Code Mode are on for every organization; the field remains for
// published clients that still read it.
coreHooks.registerContributor({
  point: "org.context",
  id: "legacy/workflows/org-context-capability",
  registrant: "legacy",
  // Today a failure here is a 500; keep it.
  errorPolicy: "propagate",
  order: CORE_HOOK_ORDER.default + 7,
  contribute: async () => ({ capabilities: { workflows: true } }),
})
