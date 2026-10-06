import { eq } from "@openwork-ee/den-db/drizzle"
import { WorkerTable } from "@openwork-ee/den-db/schema"
import { coreHooks } from "../default-registry.js"
import { CORE_HOOK_ORDER } from "../types.js"

// Future owner: openworkWeb.

coreHooks.registerTx({
  point: "user.deleting",
  id: "legacy/openwork-web/detach-deleted-user-workers",
  registrant: "legacy",
  alwaysRun: "cleanup",
  order: CORE_HOOK_ORDER.cleanup + 2,
  handler: async ({ tx, userId }) => {
    await tx.update(WorkerTable).set({ created_by_user_id: null }).where(eq(WorkerTable.created_by_user_id, userId))
  },
})
