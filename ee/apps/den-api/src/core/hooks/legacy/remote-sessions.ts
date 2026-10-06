import { eq } from "@openwork-ee/den-db/drizzle"
import { RemoteSessionCommandTable, RemoteSessionRequestTable } from "@openwork-ee/den-db/schema"
import { coreHooks } from "../default-registry.js"
import { CORE_HOOK_ORDER } from "../types.js"

// Future owner: automations.remoteSessions.

coreHooks.registerTx({
  point: "org.deletion.purge",
  id: "legacy/remote-sessions/purge-organization-remote-sessions",
  registrant: "legacy",
  alwaysRun: "cleanup",
  order: CORE_HOOK_ORDER.cleanup + 23,
  handler: async ({ tx, organizationId }) => {
    // Previously orphaned (W0-05).
    await tx.delete(RemoteSessionRequestTable).where(eq(RemoteSessionRequestTable.org_id, organizationId))
    await tx.delete(RemoteSessionCommandTable).where(eq(RemoteSessionCommandTable.org_id, organizationId))
  },
})
