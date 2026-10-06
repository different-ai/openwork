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
import { cloudHostingAvailable } from "../../../capability-sources/cloud-hosting.js"
import { env } from "../../../env.js"
import { isOpenWorkWebAvailableForOrganization } from "../../../openwork-web-availability.js"
import { getOpenWorkWebAccess } from "../../../stripe-billing.js"

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

// Effective offer: the deployment switch enables Web generally, while the
// platform-admin complimentary grant enables only this organization.
coreHooks.registerContributor({
  point: "org.context",
  id: "legacy/openwork-web/org-context-capability",
  registrant: "legacy",
  // Today a failure here is a 500; keep it.
  errorPolicy: "propagate",
  order: CORE_HOOK_ORDER.default + 9,
  contribute: async ({ metadata }) => ({ capabilities: { openworkWeb: isOpenWorkWebAvailableForOrganization(metadata) } }),
})

// Cloud is entitled by OpenWork Web access (paid subscription or the
// platform-admin complimentary grant) on hosted deployments.
coreHooks.registerContributor({
  point: "org.context",
  id: "legacy/openwork-web/org-context-cloud",
  registrant: "legacy",
  errorPolicy: "propagate",
  order: CORE_HOOK_ORDER.default + 11,
  contribute: async ({ organizationId }) => {
    const cloudEnabled = cloudHostingAvailable({ orgMode: env.orgMode })
      && (await getOpenWorkWebAccess(organizationId)).hasAccess
    return cloudEnabled ? { capabilities: { cloud: true } } : {}
  },
})

// `capabilities.cloud` is a server-side grant, never shown to members.
coreHooks.registerDecorator({
  point: "org.memberFacingMetadata",
  id: "legacy/openwork-web/hide-cloud-capability",
  registrant: "legacy",
  errorPolicy: "propagate",
  handler: async (metadata) => {
    const capabilities = metadata.capabilities
    if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities) || !("cloud" in capabilities)) {
      return metadata
    }
    const nextCapabilities = Object.fromEntries(Object.entries(capabilities).filter(([key]) => key !== "cloud"))
    const nextMetadata = Object.fromEntries(Object.entries(metadata).filter(([key]) => key !== "capabilities"))
    return Object.keys(nextCapabilities).length > 0
      ? Object.fromEntries(Object.entries(metadata).map(([key, value]) => [key, key === "capabilities" ? nextCapabilities : value]))
      : nextMetadata
  },
})
