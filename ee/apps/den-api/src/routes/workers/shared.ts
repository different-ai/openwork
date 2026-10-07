import { randomBytes } from "node:crypto"
import { and, desc, eq, inArray } from "@openwork-ee/den-db/drizzle"
import {
  CloudRuntimeInstanceTable,
  DaytonaSandboxTable,
  MemberTable,
  WorkerBundleTable,
  WorkerInstanceTable,
  WorkerTable,
  WorkerTokenTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { z } from "zod"
import { db } from "../../db.js"
import { env } from "../../env.js"
import { keysetCursorQuerySchema } from "../../list-pagination.js"
import type { UserOrganizationsContext } from "../../middleware/index.js"
import { denTypeIdSchema } from "../../openapi.js"
import { appLogger } from "../../observability/logger.js"
import type { AuthContextVariables } from "../../session.js"
import { materializeCloudWorkerProviders } from "../../llm/cloud-provider-materialization.js"
import { deprovisionWorker, provisionWorker } from "../../workers/provisioner.js"
import { withProvisionDeadline } from "../../workers/provision-deadline.js"
import { touchProvisioningWorker, withProvisioningHeartbeat } from "../../workers/provisioning-heartbeat.js"
import {
  cloudStartupFailureUpdate,
  createCloudStartupFailure,
  type CloudStartupFailure,
} from "../../workers/cloud-failure.js"
import { endpointKindForProvider, isCloudRuntimeProviderId } from "../../workers/cloud-runtime.js"
import {
  getOpenWorkWebRuntimeAccess,
  requireOpenWorkWebRuntimeAccess,
  type OpenWorkWebRuntimeAccessResolver,
} from "../../openwork-web-runtime-access.js"

const logger = appLogger.child({ component: "worker_routes" })

export const listWorkersQuerySchema = z.object({
  cursor: keysetCursorQuerySchema.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})

export const activityHeartbeatSchema = z.object({
  sentAt: z.string().datetime().optional(),
  isActiveRecently: z.boolean(),
  lastActivityAt: z.string().datetime().optional().nullable(),
  openSessionCount: z.number().int().min(0).optional(),
})

export const workerIdParamSchema = z.object({
  id: denTypeIdSchema("worker"),
})

export type WorkerRouteVariables = AuthContextVariables & Partial<UserOrganizationsContext>

type WorkerRow = typeof WorkerTable.$inferSelect
type WorkerInstanceRow = typeof WorkerInstanceTable.$inferSelect
type WorkerStatus = WorkerRow["status"]
export type WorkerId = WorkerRow["id"]
type OrgId = typeof MemberTable.$inferSelect.organizationId
type ProvisionWorker = typeof provisionWorker
type ProvisionedWorker = Awaited<ReturnType<ProvisionWorker>>
type CloudProvisioningStore = {
  updateWorkerStatus: (input: {
    workerId: WorkerId
    status: WorkerStatus
    imageVersion?: string | null
    failure?: CloudStartupFailure | null
    onlyWhenStatus?: WorkerStatus
    onlyWhenStatusIn?: WorkerStatus[]
  }) => Promise<void>
  insertWorkerInstance: (input: { workerId: WorkerId; provisioned: ProvisionedWorker }) => Promise<void>
  touchProvisioningWorker: (workerId: WorkerId) => Promise<void>
}
type ContinueCloudProvisioningOptions = {
  getOpenWorkWebAccess?: OpenWorkWebRuntimeAccessResolver
  provisionWorker?: ProvisionWorker
  store?: CloudProvisioningStore
  materializeProviders?: typeof materializeCloudWorkerProviders
  deadlineMs?: number
  heartbeatIntervalMs?: number
}

export const token = () => randomBytes(32).toString("hex")
const provisioningSuccessWritableStatuses: WorkerStatus[] = ["provisioning", "failed"]
const cloudProvisioningInFlight = new Map<WorkerId, Promise<void>>()

const databaseCloudProvisioningStore: CloudProvisioningStore = {
  async updateWorkerStatus(input) {
    const statusPredicate = input.onlyWhenStatusIn
      ? inArray(WorkerTable.status, input.onlyWhenStatusIn)
      : input.onlyWhenStatus
        ? eq(WorkerTable.status, input.onlyWhenStatus)
        : undefined

    const update = {
      status: input.status,
      ...(input.imageVersion === undefined ? {} : { image_version: input.imageVersion }),
      ...(input.failure === undefined ? {} : cloudStartupFailureUpdate(input.failure)),
    }

    await db
      .update(WorkerTable)
      .set(update)
      .where(statusPredicate
        ? and(eq(WorkerTable.id, input.workerId), statusPredicate)
        : eq(WorkerTable.id, input.workerId))
  },
  async insertWorkerInstance(input) {
    await db.insert(WorkerInstanceTable).values({
      id: createDenTypeId("workerInstance"),
      worker_id: input.workerId,
      provider: input.provisioned.provider,
      region: input.provisioned.region,
      url: persistedWorkerInstanceUrl(input.provisioned),
      status: input.provisioned.status,
    })
  },
  touchProvisioningWorker,
}

export function persistedWorkerInstanceUrl(provisioned: Pick<ProvisionedWorker, "provider" | "url">) {
  const lifecycleBaseUrl = env.apiPublicUrl ?? env.betterAuthUrl
  // Contract providers hand out expiring endpoints, so the durable instance URL
  // is Den's lifecycle route rather than the endpoint itself.
  return isCloudRuntimeProviderId(provisioned.provider)
    ? `${lifecycleBaseUrl.replace(/\/+$/, "")}/v1/cloud/instance`
    : provisioned.url
}

export function parseWorkerIdParam(value: string): WorkerId {
  return normalizeDenTypeId("worker", value)
}

export function readBearerToken(value: string | undefined) {
  const trimmed = value?.trim() ?? ""
  if (!trimmed.toLowerCase().startsWith("bearer ")) {
    return null
  }
  const tokenValue = trimmed.slice(7).trim()
  return tokenValue ? tokenValue : null
}

export function parseHeartbeatTimestamp(value: string | null | undefined) {
  if (!value) {
    return null
  }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return null
  }
  return parsed
}

export function newerDate(current: Date | null | undefined, candidate: Date | null | undefined) {
  if (!candidate) {
    return current ?? null
  }
  if (!current) {
    return candidate
  }
  return candidate.getTime() > current.getTime() ? candidate : current
}

export async function getLatestWorkerInstance(workerId: WorkerId) {
  const rows = await db
    .select()
    .from(WorkerInstanceTable)
    .where(eq(WorkerInstanceTable.worker_id, workerId))
    .orderBy(desc(WorkerInstanceTable.created_at))
    .limit(1)

  return rows[0] ?? null
}

export function toInstanceResponse(instance: WorkerInstanceRow | null) {
  if (!instance) {
    return null
  }

  return {
    provider: instance.provider,
    region: instance.region,
    url: isCloudRuntimeProviderId(instance.provider) ? null : instance.url,
    // Clients decide URL durability from this, never from the provider name.
    endpointKind: endpointKindForProvider(instance.provider),
    status: instance.status,
    createdAt: instance.created_at,
    updatedAt: instance.updated_at,
  }
}

export function canControlWorker(worker: Pick<WorkerRow, "destination" | "created_by_user_id">, userId: string | undefined) {
  return worker.destination === "local" || Boolean(userId && worker.created_by_user_id === userId)
}

export function workerControlForbiddenPayload() {
  return { error: "forbidden", message: "Only the worker owner can access or control this cloud worker." }
}

export function toWorkerResponse(row: WorkerRow, userId: string) {
  return {
    id: row.id,
    orgId: row.org_id,
    createdByUserId: row.created_by_user_id,
    isMine: row.created_by_user_id === userId,
    name: row.name,
    description: row.description,
    destination: row.destination,
    status: row.status,
    imageVersion: row.image_version,
    workspacePath: row.workspace_path,
    sandboxBackend: row.sandbox_backend,
    lastHeartbeatAt: row.last_heartbeat_at,
    lastActiveAt: row.last_active_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

async function runCloudProvisioning(input: {
  workerId: WorkerId
  orgId?: OrgId
  name: string
  hostToken: string
  clientToken: string
  activityToken: string
}, options: ContinueCloudProvisioningOptions) {
  const provision = options.provisionWorker ?? provisionWorker
  const store = options.store ?? databaseCloudProvisioningStore
  const materializeProviders = options.materializeProviders ?? materializeCloudWorkerProviders
  const deadlineMs = options.deadlineMs ?? env.cloudProvisionDeadlineMs

  try {
    if (!input.orgId) throw new Error("cloud_worker_organization_required")
    // Entitlement can lapse between claim and provisioning; a lapse is recorded
    // as the dedicated web_access_required failure (cloud-failure.ts), which the
    // published desktop renders through its existing failed-instance state.
    await requireOpenWorkWebRuntimeAccess(
      input.orgId,
      options.getOpenWorkWebAccess ?? getOpenWorkWebRuntimeAccess,
    )
    await withProvisioningHeartbeat({
      workerId: input.workerId,
      touch: store.touchProvisioningWorker,
      intervalMs: options.heartbeatIntervalMs,
      run: async () => {
        const provisioned = await withProvisionDeadline({
          promise: provision({
            workerId: input.workerId,
            name: input.name,
            hostToken: input.hostToken,
            clientToken: input.clientToken,
            activityToken: input.activityToken,
          }),
          deadlineMs,
          label: `cloud provisioning for ${input.workerId}`,
        })

        if (provisioned.status === "healthy" && input.orgId) {
          try {
            await materializeProviders({
              organizationId: input.orgId,
              workerId: input.workerId,
              instanceUrl: provisioned.url,
              hostToken: input.hostToken,
              clientToken: input.clientToken,
              force: true,
            })
          } catch (error) {
            logger.warn("worker provisioning provider materialization warning", {
              worker_id: input.workerId,
              message: error instanceof Error ? error.message : "provider_materialization_failed",
            })
          }
        }

        await store.updateWorkerStatus({
          workerId: input.workerId,
          status: provisioned.status,
          imageVersion: provisioned.imageVersion,
          failure: null,
          onlyWhenStatusIn: provisioningSuccessWritableStatuses,
        })

        await store.insertWorkerInstance({ workerId: input.workerId, provisioned })
      },
    })
  } catch (error) {
    const failure = createCloudStartupFailure({ stage: "provisioning", error })
    await store.updateWorkerStatus({
      workerId: input.workerId,
      status: "failed",
      failure,
      onlyWhenStatus: "provisioning",
    })

    logger.error("worker provisioning failed", {
      worker_id: input.workerId,
      failure_code: failure.code,
      failure_stage: failure.stage,
      failure_reference: failure.reference,
      error,
    })
  }
}

export async function continueCloudProvisioning(input: {
  workerId: WorkerId
  orgId?: OrgId
  name: string
  hostToken: string
  clientToken: string
  activityToken: string
}, options: ContinueCloudProvisioningOptions = {}) {
  const existing = cloudProvisioningInFlight.get(input.workerId)
  if (existing) {
    return existing
  }

  // Conditional updates are the multi-replica safety; this in-process map is
  // single-replica efficiency shared by routes, reconcilers, and self-heals.
  const promise = runCloudProvisioning(input, options)
    .finally(() => {
      if (cloudProvisioningInFlight.get(input.workerId) === promise) {
        cloudProvisioningInFlight.delete(input.workerId)
      }
    })
  cloudProvisioningInFlight.set(input.workerId, promise)

  return promise
}

export async function deleteWorkerCascade(worker: WorkerRow) {
  const instance = await getLatestWorkerInstance(worker.id)

  if (worker.destination === "cloud") {
    try {
      await deprovisionWorker({
        workerId: worker.id,
        instanceUrl: instance?.url ?? null,
      })
    } catch (error) {
      logger.warn("worker deprovision warning", { worker_id: worker.id, error })
    }
  }

  await db.transaction(async (tx) => {
    await tx.delete(WorkerTokenTable).where(eq(WorkerTokenTable.worker_id, worker.id))
    await tx.delete(CloudRuntimeInstanceTable).where(eq(CloudRuntimeInstanceTable.worker_id, worker.id))
    await tx.delete(DaytonaSandboxTable).where(eq(DaytonaSandboxTable.worker_id, worker.id))
    await tx.delete(WorkerInstanceTable).where(eq(WorkerInstanceTable.worker_id, worker.id))
    await tx.delete(WorkerBundleTable).where(eq(WorkerBundleTable.worker_id, worker.id))
    // Audit references outlive the resource. Organization erasure owns purging;
    // deleting a worker must not remove either legacy or operation history.
    await tx.delete(WorkerTable).where(eq(WorkerTable.id, worker.id))
  })
}

export async function getWorkerByIdForOrg(workerId: WorkerId, orgId: OrgId) {
  const rows = await db
    .select()
    .from(WorkerTable)
    .where(and(eq(WorkerTable.id, workerId), eq(WorkerTable.org_id, orgId)))
    .limit(1)

  return rows[0] ?? null
}
