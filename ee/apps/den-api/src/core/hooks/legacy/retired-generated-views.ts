import { eq } from "@openwork-ee/den-db/drizzle"
import { ArtifactViewRevisionTable, ArtifactViewTable, DashboardAppTable, RemoteMcpAppTable } from "@openwork-ee/den-db/schema"
import { coreHooks } from "../default-registry.js"
import { CORE_HOOK_ORDER } from "../types.js"

// Retired features (D36: generated views, remote MCP apps). Delete this file
// when W0-P13 drops the tables.

coreHooks.registerTx({
  point: "org.deletion.purge",
  id: "legacy/retired-generated-views/purge-organization-generated-views",
  registrant: "legacy",
  alwaysRun: "cleanup",
  order: CORE_HOOK_ORDER.cleanup + 25,
  handler: async ({ tx, organizationId }) => {
    // Previously orphaned (W0-05).
    await tx.delete(ArtifactViewRevisionTable).where(eq(ArtifactViewRevisionTable.organization_id, organizationId))
    await tx.delete(DashboardAppTable).where(eq(DashboardAppTable.organization_id, organizationId))
    await tx.delete(ArtifactViewTable).where(eq(ArtifactViewTable.organization_id, organizationId))
    await tx.delete(RemoteMcpAppTable).where(eq(RemoteMcpAppTable.organizationId, organizationId))
  },
})
