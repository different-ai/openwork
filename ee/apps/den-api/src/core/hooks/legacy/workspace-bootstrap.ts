import { eq } from "@openwork-ee/den-db/drizzle"
import { MemberTable, WorkspaceBootstrapTable, WorkspaceClaimCodeTable, WorkspaceClaimTable } from "@openwork-ee/den-db/schema"
import { coreHooks } from "../default-registry.js"
import { CORE_HOOK_ORDER } from "../types.js"

// Future owner: workspaceBootstrap (infrastructure).

coreHooks.registerTx({
  point: "org.deletion.purge",
  id: "legacy/workspace-bootstrap/purge-organization-workspace-claims",
  registrant: "legacy",
  alwaysRun: "cleanup",
  order: CORE_HOOK_ORDER.cleanup + 9,
  handler: async ({ tx, organizationId }) => {
    // Previously orphaned (W0-05).
    await tx.delete(WorkspaceClaimCodeTable).where(eq(WorkspaceClaimCodeTable.organizationId, organizationId))
    await tx.delete(WorkspaceClaimTable).where(eq(WorkspaceClaimTable.organizationId, organizationId))
    await tx.delete(WorkspaceBootstrapTable).where(eq(WorkspaceBootstrapTable.organizationId, organizationId))
  },
})

// The sign-in-less setup agent holding a provisional workspace is not a person.
coreHooks.registerBootContributor({
  point: "member.visibilityFilter",
  id: "legacy/workspace-bootstrap/exclude-setup-agent",
  registrant: "legacy",
  contribute: () => eq(MemberTable.isSetupAgent, false),
})
