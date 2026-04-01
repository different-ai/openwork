import { randomBytes } from "node:crypto"
import { and, asc, desc, eq, isNull } from "@openwork-ee/den-db/drizzle"
import {
  AuditEventTable,
  AuthUserTable,
  DaytonaSandboxTable,
  MemberTable,
  WorkerBundleTable,
  WorkerInstanceTable,
  WorkerTable,
  WorkerTokenTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { z } from "zod"
import { getCloudWorkerBillingStatus, requireCloudWorkerAccess, setCloudWorkerSubscriptionCancellation } from "../../billing/polar.js"
import { db } from "../../db.js"
import { env } from "../../env.js"
import type { UserOrganizationsContext } from "../../middleware/index.js"
import type { AuthContextVariables } from "../../session.js"
import { deprovisionWorker, provisionWorker } from "../../workers/provisioner.js"
import { customDomainForWorker } from "../../workers/vanity-domain.js"

export const createWorkerSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  destination: z.enum(["local", "cloud"]),
  workspacePath: z.string().optional(),
  sandboxBackend: z.string().optional(),
  imageVersion: z.string().optional(),
})

export const updateWorkerSchema = z.object({
  name: z.string().trim().min(1).max(255),
})

export const listWorkersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
})

export const billingQuerySchema = z.object({
  includeCheckout: z.string().optional(),
  excludePortal: z.string().optional(),
  excludeInvoices: z.string().optional(),
})

export const billingSubscriptionSchema = z.object({
  cancelAtPeriodEnd: z.boolean().default(true),
})

export const activityHeartbeatSchema = z.object({
  sentAt: z.string().datetime().optional(),
  isActiveRecently: z.boolean(),
  lastActivityAt: z.string().datetime().optional().nullable(),
  openSessionCount: z.number().int().min(0).optional(),
})

export const workerIdParamSchema = z.object({
  id: z.string().trim().min(1).max(255),
})

export type WorkerRouteVariables = AuthContextVariables & Partial<UserOrganizationsContext>

type WorkerRow = typeof WorkerTable.$inferSelect
type WorkerInstanceRow = typeof WorkerInstanceTable.$inferSelect
export type WorkerId = WorkerRow["id"]
type OrgId = typeof MemberTable.$inferSelect.organizationId
type UserId = typeof AuthUserTable.$inferSelect.id

export const token = () => randomBytes(32).toString("hex")

export function parseWorkerIdParam(value: string): WorkerId {
  return normalizeDenTypeId("worker", value)
}

export function parseUserId(value: string): UserId {
  return normalizeDenTypeId("user", value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/, "")
}

function parseWorkspaceSelection(payload: unknown): { workspaceId: string; openworkUrl: string } | null {
  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    return null
  }

  const activeId = typeof payload.activeId === "string" ? payload.activeId : null
  let workspaceId = activeId

  if (!workspaceId) {
    for (const item of payload.items) {
      if (isRecord(item) && typeof item.id === "string" && item.id.trim()) {
        workspaceId = item.id
        break
      }
    }
  }

  const baseUrl = typeof payload.baseUrl === "string" ? normalizeUrl(payload.baseUrl) : ""
  if (!workspaceId || !baseUrl) {
    return null
  }

  return {
    workspaceId,
    openworkUrl: `${baseUrl}/w/${encodeURIComponent(workspaceId)}`,
  }
}

async function resolveConnectUrlFromWorker(instanceUrl: string, clientToken: string) {
  const baseUrl = normalizeUrl(instanceUrl)
  if (!baseUrl || !clientToken.trim()) {
    return null
  }

  try {
    const response = await fetch(`${baseUrl}/workspaces`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${clientToken.trim()}`,
      },
    })

    if (!response.ok) {
      return null
    }

    const payload = (await response.json()) as unknown
    const selected = parseWorkspaceSelection({
      ...(isRecord(payload) ? payload : {}),
      baseUrl,
    })
    return selected
  } catch {
    return null
  }
}

function getConnectUrlCandidates(workerId: WorkerId, instanceUrl: string | null) {
  const candidates: string[] = []
  const vanityHostname = customDomainForWorker(workerId, env.render.workerPublicDomainSuffix)
  if (vanityHostname) {
    candidates.push(`https://${vanityHostname}`)
  }

  if (instanceUrl) {
    const normalized = normalizeUrl(instanceUrl)
    if (normalized && !candidates.includes(normalized)) {
      candidates.push(normalized)
    }
  }

  return candidates
}

export function queryIncludesFlag(value: string | undefined): boolean {
  if (typeof value !== "string") {
    return false
  }

  const normalized = value.trim().toLowerCase()
  return normalized === "1" || normalized === "true" || normalized === "yes"
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

async function resolveConnectUrlFromCandidates(workerId: WorkerId, instanceUrl: string | null, clientToken: string) {
  const candidates = getConnectUrlCandidates(workerId, instanceUrl)
  for (const candidate of candidates) {
    const resolved = await resolveConnectUrlFromWorker(candidate, clientToken)
    if (resolved) {
      return resolved
    }
  }
  return null
}

async function getWorkerRuntimeAccess(workerId: WorkerId) {
  const instance = await getLatestWorkerInstance(workerId)
  const tokenRows = await db
    .select()
    .from(WorkerTokenTable)
    .where(and(eq(WorkerTokenTable.worker_id, workerId), isNull(WorkerTokenTable.revoked_at)))
    .orderBy(asc(WorkerTokenTable.created_at))

  const hostToken = tokenRows.find((entry) => entry.scope === "host")?.token ?? null
  if (!instance?.url || !hostToken) {
    return null
  }

  return {
    instance,
    hostToken,
    candidates: getConnectUrlCandidates(workerId, instance.url),
  }
}

export async function fetchWorkerRuntimeJson(input: {
  workerId: WorkerId
  path: string
  method?: "GET" | "POST"
  body?: unknown
}) {
  const access = await getWorkerRuntimeAccess(input.workerId)
  if (!access) {
    return {
      ok: false as const,
      status: 409,
      payload: {
        error: "worker_runtime_unavailable",
        message: "Worker runtime access is not ready yet. Wait for provisioning to finish and try again.",
      },
    }
  }

  let lastPayload: unknown = null
  let lastStatus = 502

  for (const candidate of access.candidates) {
    try {
      const response = await fetch(`${normalizeUrl(candidate)}${input.path}`, {
        method: input.method ?? "GET",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-OpenWork-Host-Token": access.hostToken,
        },
        body: input.body === undefined ? undefined : JSON.stringify(input.body),
      })

      const text = await response.text()
      lastStatus = response.status
      try {
        lastPayload = text ? JSON.parse(text) : null
      } catch {
        lastPayload = text ? { message: text } : null
      }

      if (response.ok) {
        return { ok: true as const, status: response.status, payload: lastPayload }
      }
    } catch (error) {
      lastPayload = { message: error instanceof Error ? error.message : "worker_request_failed" }
    }
  }

  return { ok: false as const, status: lastStatus, payload: lastPayload }
}

export async function countUserCloudWorkers(userId: UserId) {
  const rows = await db
    .select({ id: WorkerTable.id })
    .from(WorkerTable)
    .where(and(eq(WorkerTable.created_by_user_id, userId), eq(WorkerTable.destination, "cloud")))
    .limit(2)

  return rows.length
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
    url: instance.url,
    status: instance.status,
    createdAt: instance.created_at,
    updatedAt: instance.updated_at,
  }
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

export async function continueCloudProvisioning(input: {
  workerId: WorkerId
  name: string
  hostToken: string
  clientToken: string
  activityToken: string
}) {
  try {
    const provisioned = await provisionWorker({
      workerId: input.workerId,
      name: input.name,
      hostToken: input.hostToken,
      clientToken: input.clientToken,
      activityToken: input.activityToken,
    })

    await db
      .update(WorkerTable)
      .set({ status: provisioned.status })
      .where(eq(WorkerTable.id, input.workerId))

    await db.insert(WorkerInstanceTable).values({
      id: createDenTypeId("workerInstance"),
      worker_id: input.workerId,
      provider: provisioned.provider,
      region: provisioned.region,
      url: provisioned.url,
      status: provisioned.status,
    })
  } catch (error) {
    await db
      .update(WorkerTable)
      .set({ status: "failed" })
      .where(eq(WorkerTable.id, input.workerId))

    const message = error instanceof Error ? error.message : "provisioning_failed"
    console.error(`[workers] provisioning failed for ${input.workerId}: ${message}`)
  }
}

export async function requireCloudAccessOrPayment(input: {
  userId: UserId
  email: string
  name: string
}) {
  return requireCloudWorkerAccess(input)
}

export async function getWorkerBilling(input: {
  userId: UserId
  email: string
  name: string
  includeCheckoutUrl: boolean
  includePortalUrl: boolean
  includeInvoices: boolean
}) {
  return getCloudWorkerBillingStatus(
    {
      userId: input.userId,
      email: input.email,
      name: input.name,
    },
    {
      includeCheckoutUrl: input.includeCheckoutUrl,
      includePortalUrl: input.includePortalUrl,
      includeInvoices: input.includeInvoices,
    },
  )
}

export async function setWorkerBillingSubscription(input: {
  userId: UserId
  email: string
  name: string
  cancelAtPeriodEnd: boolean
}) {
  return setCloudWorkerSubscriptionCancellation(
    {
      userId: input.userId,
      email: input.email,
      name: input.name,
    },
    input.cancelAtPeriodEnd,
  )
}

export async function getWorkerTokensAndConnect(worker: WorkerRow) {
  const tokenRows = await db
    .select()
    .from(WorkerTokenTable)
    .where(and(eq(WorkerTokenTable.worker_id, worker.id), isNull(WorkerTokenTable.revoked_at)))
    .orderBy(asc(WorkerTokenTable.created_at))

  const hostToken = tokenRows.find((entry) => entry.scope === "host")?.token ?? null
  const clientToken = tokenRows.find((entry) => entry.scope === "client")?.token ?? null

  if (!hostToken || !clientToken) {
    return {
      error: {
        status: 409,
        body: {
          error: "worker_tokens_unavailable",
          message: "Worker tokens are missing for this worker. Launch a new worker and try again.",
        },
      },
    }
  }

  const instance = await getLatestWorkerInstance(worker.id)
  const connect = await resolveConnectUrlFromCandidates(worker.id, instance?.url ?? null, clientToken)

  return {
    tokens: {
      owner: hostToken,
      host: hostToken,
      client: clientToken,
    },
    connect: connect ?? (instance?.url ? { openworkUrl: instance.url, workspaceId: null } : null),
  }
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
      const message = error instanceof Error ? error.message : "deprovision_failed"
      console.warn(`[workers] deprovision warning for ${worker.id}: ${message}`)
    }
  }

  await db.transaction(async (tx) => {
    await tx.delete(WorkerTokenTable).where(eq(WorkerTokenTable.worker_id, worker.id))
    await tx.delete(DaytonaSandboxTable).where(eq(DaytonaSandboxTable.worker_id, worker.id))
    await tx.delete(WorkerInstanceTable).where(eq(WorkerInstanceTable.worker_id, worker.id))
    await tx.delete(WorkerBundleTable).where(eq(WorkerBundleTable.worker_id, worker.id))
    await tx.delete(AuditEventTable).where(eq(AuditEventTable.worker_id, worker.id))
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
