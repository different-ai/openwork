import { and, asc, eq, gt, inArray, lte } from "@openwork-ee/den-db/drizzle"
import { RemoteSessionRequestTable } from "@openwork-ee/den-db/schema/remote-session-commands"
import { createDenTypeId, normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import {
  remoteSessionReadInputSchema,
  remoteSessionRequestResultSchema,
  remoteSessionSendInputSchema,
  remoteSessionStopInputSchema,
  type RemoteSessionRequestCompleteRequest,
  type RemoteSessionRequestInput,
  type RemoteSessionRequestResult,
} from "@openwork/types/automations"
import { db } from "../db.js"
import { updateChangedRows } from "../core/db/affected-rows.js"

/** Requests are interactive: an unanswered one is useless after a couple of minutes. */
export const REMOTE_SESSION_REQUEST_TTL_MS = 2 * 60_000

export type RemoteSessionRequestStatus = "pending" | "claimed" | "done" | "failed" | "expired"

export type RemoteSessionRequest = RemoteSessionRequestInput & {
  id: string
  organizationId: string
  ownerMemberId: string
  createdByUserId: string
  commandId: string
  targetRunnerId: string
  workspaceId: string
  sessionId: string
  engine: "v1" | "v2" | null
  status: RemoteSessionRequestStatus
  outcome: RemoteSessionRequestResult | null
  error: { code: string; message: string } | null
  expiresAt: number
  claimedAt: number | null
  completedAt: number | null
  createdAt: number
  updatedAt: number
}

type EnqueueInput = RemoteSessionRequestInput & {
  organizationId: string
  ownerMemberId: string
  createdByUserId: string
  commandId: string
  targetRunnerId: string
  workspaceId: string
  sessionId: string
  engine: "v1" | "v2" | null
  ttlMs: number
}

export interface RemoteSessionRequestStore {
  enqueue(input: EnqueueInput): Promise<RemoteSessionRequest>
  /** Only the target runner can claim, once, before the request expires. */
  claim(input: {
    requestId: string
    organizationId: string
    ownerMemberId: string
    runnerId: string
    now: number
  }): Promise<RemoteSessionRequest | null>
  /** Only the runner holding the claim can complete, once. */
  complete(input: RemoteSessionRequestCompleteRequest & {
    requestId: string
    organizationId: string
    ownerMemberId: string
    runnerId: string
    now: number
  }): Promise<RemoteSessionRequest | null>
  /** Reads a request for its creator, settling it as expired once its deadline passed unanswered. */
  get(input: { requestId: string; organizationId: string; createdByUserId: string }): Promise<RemoteSessionRequest | null>
  listPendingForRunner(input: {
    organizationId: string
    ownerMemberId: string
    runnerId: string
    now: number
    limit: number
  }): Promise<RemoteSessionRequest[]>
}

type RequestRow = typeof RemoteSessionRequestTable.$inferSelect

function requestIdOrNull(value: string): DenTypeId<"remoteSessionRequest"> | null {
  try {
    return normalizeDenTypeId("remoteSessionRequest", value)
  } catch {
    return null
  }
}

function mapInput(row: RequestRow): RemoteSessionRequestInput | null {
  if (row.action === "read") {
    const input = remoteSessionReadInputSchema.safeParse(row.input)
    return input.success ? { action: "read", input: input.data } : null
  }
  if (row.action === "send") {
    const input = remoteSessionSendInputSchema.safeParse(row.input)
    return input.success ? { action: "send", input: input.data } : null
  }
  const input = remoteSessionStopInputSchema.safeParse(row.input)
  return input.success ? { action: "stop", input: input.data } : null
}

function mapRequest(row: RequestRow): RemoteSessionRequest {
  const input = mapInput(row)
  if (!input) throw new Error("remote_session_request_input_invalid")
  const outcome = row.result === null ? null : remoteSessionRequestResultSchema.safeParse(row.result)
  return {
    ...input,
    id: row.id,
    organizationId: row.org_id,
    ownerMemberId: row.owner_member_id,
    createdByUserId: row.created_by_user_id,
    commandId: row.command_id,
    targetRunnerId: row.target_runner_id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    engine: row.session_engine,
    status: row.status,
    outcome: outcome?.success ? outcome.data : null,
    error: row.error_code && row.error_message ? { code: row.error_code, message: row.error_message } : null,
    expiresAt: row.expires_at.getTime(),
    claimedAt: row.claimed_at?.getTime() ?? null,
    completedAt: row.completed_at?.getTime() ?? null,
    createdAt: row.created_at.getTime(),
    updatedAt: row.updated_at.getTime(),
  }
}

async function requestById(requestId: DenTypeId<"remoteSessionRequest">): Promise<RemoteSessionRequest | null> {
  const rows = await db.select().from(RemoteSessionRequestTable)
    .where(eq(RemoteSessionRequestTable.id, requestId)).limit(1)
  return rows[0] ? mapRequest(rows[0]) : null
}

export const databaseRemoteSessionRequestStore: RemoteSessionRequestStore = {
  async enqueue(input) {
    const now = Date.now()
    const id = createDenTypeId("remoteSessionRequest")
    await db.insert(RemoteSessionRequestTable).values({
      id,
      org_id: normalizeDenTypeId("organization", input.organizationId),
      owner_member_id: normalizeDenTypeId("member", input.ownerMemberId),
      created_by_user_id: normalizeDenTypeId("user", input.createdByUserId),
      command_id: normalizeDenTypeId("remoteSessionCommand", input.commandId),
      target_runner_id: input.targetRunnerId,
      workspace_id: input.workspaceId,
      session_id: input.sessionId,
      session_engine: input.engine,
      action: input.action,
      input: input.input,
      status: "pending",
      expires_at: new Date(now + input.ttlMs),
      created_at: new Date(now),
      updated_at: new Date(now),
    })
    const request = await requestById(id)
    if (!request) throw new Error("remote_session_request_enqueue_failed")
    return request
  },

  async claim(input) {
    const requestId = requestIdOrNull(input.requestId)
    if (!requestId) return null
    const now = new Date(input.now)
    const result = await db.update(RemoteSessionRequestTable).set({
      status: "claimed",
      claimed_at: now,
      updated_at: now,
    }).where(and(
      eq(RemoteSessionRequestTable.id, requestId),
      eq(RemoteSessionRequestTable.org_id, normalizeDenTypeId("organization", input.organizationId)),
      eq(RemoteSessionRequestTable.owner_member_id, normalizeDenTypeId("member", input.ownerMemberId)),
      eq(RemoteSessionRequestTable.target_runner_id, input.runnerId),
      eq(RemoteSessionRequestTable.status, "pending"),
      gt(RemoteSessionRequestTable.expires_at, now),
    ))
    if (!updateChangedRows(result)) return null
    return requestById(requestId)
  },

  async complete(input) {
    const requestId = requestIdOrNull(input.requestId)
    if (!requestId) return null
    const existing = await requestById(requestId)
    // The outcome must answer the action that was asked.
    if (input.status === "done" && existing && input.outcome.action !== existing.action) return null
    const now = new Date(input.now)
    const result = await db.update(RemoteSessionRequestTable).set({
      status: input.status,
      result: input.status === "done" ? input.outcome : null,
      error_code: input.status === "failed" ? input.error.code : null,
      error_message: input.status === "failed" ? input.error.message : null,
      completed_at: now,
      updated_at: now,
    }).where(and(
      eq(RemoteSessionRequestTable.id, requestId),
      eq(RemoteSessionRequestTable.org_id, normalizeDenTypeId("organization", input.organizationId)),
      eq(RemoteSessionRequestTable.owner_member_id, normalizeDenTypeId("member", input.ownerMemberId)),
      eq(RemoteSessionRequestTable.target_runner_id, input.runnerId),
      eq(RemoteSessionRequestTable.status, "claimed"),
    ))
    if (!updateChangedRows(result)) return null
    return requestById(requestId)
  },

  async get(input) {
    const requestId = requestIdOrNull(input.requestId)
    if (!requestId) return null
    const scope = and(
      eq(RemoteSessionRequestTable.id, requestId),
      eq(RemoteSessionRequestTable.org_id, normalizeDenTypeId("organization", input.organizationId)),
      eq(RemoteSessionRequestTable.created_by_user_id, normalizeDenTypeId("user", input.createdByUserId)),
    )
    const rows = await db.select().from(RemoteSessionRequestTable).where(scope).limit(1)
    const request = rows[0] ? mapRequest(rows[0]) : null
    if (!request || !["pending", "claimed"].includes(request.status) || request.expiresAt > Date.now()) {
      return request
    }
    const now = new Date()
    await db.update(RemoteSessionRequestTable).set({ status: "expired", updated_at: now }).where(and(
      scope,
      inArray(RemoteSessionRequestTable.status, ["pending", "claimed"]),
      lte(RemoteSessionRequestTable.expires_at, now),
    ))
    return requestById(requestId)
  },

  async listPendingForRunner(input) {
    const rows = await db.select().from(RemoteSessionRequestTable).where(and(
      eq(RemoteSessionRequestTable.org_id, normalizeDenTypeId("organization", input.organizationId)),
      eq(RemoteSessionRequestTable.owner_member_id, normalizeDenTypeId("member", input.ownerMemberId)),
      eq(RemoteSessionRequestTable.target_runner_id, input.runnerId),
      eq(RemoteSessionRequestTable.status, "pending"),
      gt(RemoteSessionRequestTable.expires_at, new Date(input.now)),
    )).orderBy(asc(RemoteSessionRequestTable.created_at), asc(RemoteSessionRequestTable.id)).limit(input.limit)
    return rows.map(mapRequest)
  },
}
