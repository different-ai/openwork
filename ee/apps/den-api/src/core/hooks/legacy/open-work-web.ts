import { eq, inArray } from "@openwork-ee/den-db/drizzle"
import {
  CloudRuntimeInstanceTable,
  DaytonaSandboxTable,
  WorkerBundleTable,
  WorkerInstanceTable,
  WorkerTable,
  WorkerTokenTable,
} from "@openwork-ee/den-db/schema"
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

coreHooks.registerTx({
  point: "org.deletion.purge",
  id: "legacy/openwork-web/purge-organization-workers",
  registrant: "legacy",
  alwaysRun: "cleanup",
  order: CORE_HOOK_ORDER.cleanup + 1,
  handler: async ({ tx, organizationId }) => {
    const workerIds = (await tx
      .select({ id: WorkerTable.id })
      .from(WorkerTable)
      .where(eq(WorkerTable.org_id, organizationId)))
      .map((row) => row.id)
    if (workerIds.length > 0) {
      await tx.delete(WorkerInstanceTable).where(inArray(WorkerInstanceTable.worker_id, workerIds))
      await tx.delete(CloudRuntimeInstanceTable).where(inArray(CloudRuntimeInstanceTable.worker_id, workerIds))
      await tx.delete(DaytonaSandboxTable).where(inArray(DaytonaSandboxTable.worker_id, workerIds))
      await tx.delete(WorkerTokenTable).where(inArray(WorkerTokenTable.worker_id, workerIds))
      await tx.delete(WorkerBundleTable).where(inArray(WorkerBundleTable.worker_id, workerIds))
    }
    await tx.delete(WorkerTable).where(eq(WorkerTable.org_id, organizationId))
  },
})
