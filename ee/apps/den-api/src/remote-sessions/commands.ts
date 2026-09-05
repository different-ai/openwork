import { and, asc, eq, gt, inArray, lte } from "@openwork-ee/den-db/drizzle"
import { RemoteSessionCommandTable } from "@openwork-ee/den-db/schema/remote-session-commands"
import { createDenTypeId, normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import type { RemoteSessionCommandCompleteRequest } from "@openwork/types/automations"
import { db } from "../db.js"
import { automationUpdateChangedRows } from "../automations/update-result.js"

export const DEFAULT_TTL_MS = 10 * 60_000

export type RemoteSessionCommandStatus = "pending" | "claimed" | "delivered" | "failed" | "expired"

export type RemoteSessionCommand = {
  id: string
  organizationId: string
  ownerMemberId: string
  createdByUserId: string
  status: RemoteSessionCommandStatus
  title: string
  prompt: string | null
  model: { providerId: string; modelId: string; variant: string | null } | null
  idempotencyKey: string | null
  expiresAt: number
  claimedByRunnerId: string | null
  claimedAt: number | null
  sessionId: string | null
  workspaceId: string | null
  resultSummary: string | null
  error: { code: string; message: string } | null
  createdAt: number
  updatedAt: number
}

type EnqueueInput = {
  organizationId: string
  ownerMemberId: string
  createdByUserId: string
  title: string
  prompt?: string
  model?: { providerId: string; modelId: string; variant?: string }
  ttlMs: number
  idempotencyKey?: string
}

type ClaimInput = {
  commandId: string
  organizationId: string
  ownerMemberId: string
  runnerId: string
  now: number
}

type CompleteInput = RemoteSessionCommandCompleteRequest & {
  commandId: string
  runnerId: string
}

export interface RemoteSessionCommandStore {
  enqueue(input: EnqueueInput): Promise<RemoteSessionCommand>
  claim(input: ClaimInput): Promise<RemoteSessionCommand | null>
  complete(input: CompleteInput): Promise<RemoteSessionCommand | null>
  get(input: { commandId: string; organizationId: string; createdByUserId: string }): Promise<RemoteSessionCommand | null>
  listPendingForRunner(input: {
    organizationId: string
    ownerMemberId: string
    now: number
    limit: number
  }): Promise<RemoteSessionCommand[]>
}

type CommandRow = typeof RemoteSessionCommandTable.$inferSelect

/**
 * Command ids arrive from route params and MCP arguments, so a malformed
 * value is an ordinary caller mistake: it means "no such command", never an
 * internal error.
 */
function commandIdOrNull(value: string): DenTypeId<"remoteSessionCommand"> | null {
  try {
    return normalizeDenTypeId("remoteSessionCommand", value)
  } catch {
    return null
  }
}

function mapCommand(row: CommandRow): RemoteSessionCommand {
  return {
    id: row.id,
    organizationId: row.org_id,
    ownerMemberId: row.owner_member_id,
    createdByUserId: row.created_by_user_id,
    status: row.status,
    title: row.title,
    prompt: row.prompt,
    model: row.model_provider_id && row.model_model_id
      ? { providerId: row.model_provider_id, modelId: row.model_model_id, variant: row.model_variant }
      : null,
    idempotencyKey: row.idempotency_key,
    expiresAt: row.expires_at.getTime(),
    claimedByRunnerId: row.claimed_by_runner_id,
    claimedAt: row.claimed_at?.getTime() ?? null,
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    resultSummary: row.result_summary,
    error: row.error_code && row.error_message ? { code: row.error_code, message: row.error_message } : null,
    createdAt: row.created_at.getTime(),
    updatedAt: row.updated_at.getTime(),
  }
}

async function commandById(commandId: string): Promise<RemoteSessionCommand | null> {
  const rows = await db.select().from(RemoteSessionCommandTable)
    .where(eq(RemoteSessionCommandTable.id, normalizeDenTypeId("remoteSessionCommand", commandId)))
    .limit(1)
  return rows[0] ? mapCommand(rows[0]) : null
}

export const databaseRemoteSessionCommandStore: RemoteSessionCommandStore = {
  async enqueue(input) {
    const now = Date.now()
    const id = createDenTypeId("remoteSessionCommand")
    await db.insert(RemoteSessionCommandTable).values({
      id,
      org_id: normalizeDenTypeId("organization", input.organizationId),
      owner_member_id: normalizeDenTypeId("member", input.ownerMemberId),
      created_by_user_id: normalizeDenTypeId("user", input.createdByUserId),
      status: "pending",
      title: input.title,
      prompt: input.prompt ?? null,
      model_provider_id: input.model?.providerId ?? null,
      model_model_id: input.model?.modelId ?? null,
      model_variant: input.model?.variant ?? null,
      idempotency_key: input.idempotencyKey ?? null,
      expires_at: new Date(now + input.ttlMs),
      created_at: new Date(now),
      updated_at: new Date(now),
    })
    const command = await commandById(id)
    if (!command) throw new Error("remote_session_command_enqueue_failed")
    return command
  },

  async claim(input) {
    const commandId = commandIdOrNull(input.commandId)
    if (!commandId) return null
    const now = new Date(input.now)
    const result = await db.update(RemoteSessionCommandTable).set({
      status: "claimed",
      claimed_by_runner_id: input.runnerId,
      claimed_at: now,
      updated_at: now,
    }).where(and(
      eq(RemoteSessionCommandTable.id, commandId),
      eq(RemoteSessionCommandTable.org_id, normalizeDenTypeId("organization", input.organizationId)),
      eq(RemoteSessionCommandTable.owner_member_id, normalizeDenTypeId("member", input.ownerMemberId)),
      eq(RemoteSessionCommandTable.status, "pending"),
      gt(RemoteSessionCommandTable.expires_at, now),
    ))
    if (!automationUpdateChangedRows(result)) return null
    return commandById(input.commandId)
  },

  async complete(input) {
    const commandId = commandIdOrNull(input.commandId)
    if (!commandId) return null
    const now = new Date()
    const result = await db.update(RemoteSessionCommandTable).set({
      status: input.status,
      session_id: input.sessionId ?? null,
      workspace_id: input.workspaceId ?? null,
      result_summary: input.resultSummary ?? null,
      error_code: input.error?.code ?? null,
      error_message: input.error?.message ?? null,
      updated_at: now,
    }).where(and(
      eq(RemoteSessionCommandTable.id, commandId),
      eq(RemoteSessionCommandTable.claimed_by_runner_id, input.runnerId),
      eq(RemoteSessionCommandTable.status, "claimed"),
    ))
    if (!automationUpdateChangedRows(result)) return null
    return commandById(input.commandId)
  },

  async get(input) {
    const commandId = commandIdOrNull(input.commandId)
    if (!commandId) return null
    const organizationId = normalizeDenTypeId("organization", input.organizationId)
    const createdByUserId = normalizeDenTypeId("user", input.createdByUserId)
    const rows = await db.select().from(RemoteSessionCommandTable).where(and(
      eq(RemoteSessionCommandTable.id, commandId),
      eq(RemoteSessionCommandTable.org_id, organizationId),
      eq(RemoteSessionCommandTable.created_by_user_id, createdByUserId),
    )).limit(1)
    const command = rows[0] ? mapCommand(rows[0]) : null
    if (!command || !["pending", "claimed"].includes(command.status) || command.expiresAt > Date.now()) {
      return command
    }
    await db.update(RemoteSessionCommandTable).set({ status: "expired", updated_at: new Date() }).where(and(
      eq(RemoteSessionCommandTable.id, commandId),
      eq(RemoteSessionCommandTable.org_id, organizationId),
      eq(RemoteSessionCommandTable.created_by_user_id, createdByUserId),
      inArray(RemoteSessionCommandTable.status, ["pending", "claimed"]),
      lte(RemoteSessionCommandTable.expires_at, new Date()),
    ))
    const updated = await db.select().from(RemoteSessionCommandTable).where(and(
      eq(RemoteSessionCommandTable.id, commandId),
      eq(RemoteSessionCommandTable.org_id, organizationId),
      eq(RemoteSessionCommandTable.created_by_user_id, createdByUserId),
    )).limit(1)
    return updated[0] ? mapCommand(updated[0]) : null
  },

  async listPendingForRunner(input) {
    const rows = await db.select().from(RemoteSessionCommandTable).where(and(
      eq(RemoteSessionCommandTable.org_id, normalizeDenTypeId("organization", input.organizationId)),
      eq(RemoteSessionCommandTable.owner_member_id, normalizeDenTypeId("member", input.ownerMemberId)),
      eq(RemoteSessionCommandTable.status, "pending"),
      gt(RemoteSessionCommandTable.expires_at, new Date(input.now)),
    )).orderBy(asc(RemoteSessionCommandTable.created_at), asc(RemoteSessionCommandTable.id)).limit(input.limit)
    return rows.map(mapCommand)
  },
}
