import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, or } from "@openwork-ee/den-db/drizzle"
import { RemoteSessionCommandTable } from "@openwork-ee/den-db/schema/remote-session-commands"
import { createDenTypeId, normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import type {
  RemoteSessionCommandCompleteRequest,
  RemoteSessionCommandSessionReport,
} from "@openwork/types/automations"
import { db } from "../db.js"
import { automationUpdateChangedRows } from "../automations/update-result.js"

export const DEFAULT_TTL_MS = 10 * 60_000

export type RemoteSessionCommandStatus = "pending" | "claimed" | "delivered" | "failed" | "expired"

export type RemoteSessionProgress = {
  status: "running" | "waiting" | "idle" | "error"
  waitingFor: "permission" | "question" | null
  engine: "v1" | "v2" | null
  model: { providerId: string; modelId: string; variant: string | null } | null
  finalText: string | null
  lastError: { code: string; message: string } | null
  messageCount: number | null
  observedAt: number
}

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
  /** Computer (runner row id) the caller chose; only that runner may claim it. */
  targetComputerId: string | null
  /** Workspace on that computer the session must be created in. */
  targetWorkspaceId: string | null
  expiresAt: number
  claimedByRunnerId: string | null
  claimedAt: number | null
  sessionId: string | null
  workspaceId: string | null
  resultSummary: string | null
  error: { code: string; message: string } | null
  /** Latest progress the claiming runner reported after delivery; null until the first report. */
  session: RemoteSessionProgress | null
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
  targetComputerId?: string
  targetWorkspaceId?: string
}

/**
 * The claiming desktop's computer ids: its runner row id, plus the install id
 * that named rows registered before rows were scoped. A command pinned to a
 * computer is visible only to the runner whose ids include its target.
 */
type RunnerComputerIds = readonly string[]

type ClaimInput = {
  commandId: string
  organizationId: string
  ownerMemberId: string
  runnerId: string
  computerIds: RunnerComputerIds
  now: number
}

type CompleteInput = RemoteSessionCommandCompleteRequest & {
  commandId: string
  runnerId: string
}

type ReportInput = RemoteSessionCommandSessionReport & {
  commandId: string
  organizationId: string
  ownerMemberId: string
  runnerId: string
}

export type RemoteSessionReportResult = "reported" | "not_found" | "conflict"

/** A delivered desktop session and the runner that owns it. */
export type RemoteSessionDesktopSession = {
  commandId: string
  ownerMemberId: string
  runnerId: string
  sessionId: string
  workspaceId: string
  title: string
  engine: "v1" | "v2" | null
  status: RemoteSessionProgress["status"] | null
  updatedAt: number
}

export interface RemoteSessionCommandStore {
  enqueue(input: EnqueueInput): Promise<RemoteSessionCommand>
  claim(input: ClaimInput): Promise<RemoteSessionCommand | null>
  complete(input: CompleteInput): Promise<RemoteSessionCommand | null>
  /**
   * Records session progress. Only the runner that claimed the command may
   * report, and only while the command is delivered.
   */
  report(input: ReportInput): Promise<RemoteSessionReportResult>
  get(input: { commandId: string; organizationId: string; createdByUserId: string }): Promise<RemoteSessionCommand | null>
  listPendingForRunner(input: {
    organizationId: string
    ownerMemberId: string
    computerIds: RunnerComputerIds
    now: number
    limit: number
  }): Promise<RemoteSessionCommand[]>
  /**
   * Finds the delivered command that created this session for the caller, so
   * read, send, and stop can be routed to the desktop that owns it. Null keeps
   * the Cloud path.
   */
  findDesktopSession(input: {
    organizationId: string
    createdByUserId: string
    sessionId: string
    workspaceId?: string
  }): Promise<RemoteSessionDesktopSession | null>
  /** Desktop sessions the caller created through remote-session commands, newest first. */
  listDesktopSessions(input: {
    organizationId: string
    createdByUserId: string
    workspaceId?: string
    limit: number
  }): Promise<RemoteSessionDesktopSession[]>
  /**
   * A follow-up was accepted: show the session as running again so callers
   * polling the command do not read the previous turn's answer as final.
   */
  markTurnStarted(input: { commandId: string; runnerId: string; now: number }): Promise<void>
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

function mapSession(row: CommandRow): RemoteSessionProgress | null {
  if (!row.session_status || !row.session_observed_at) return null
  return {
    status: row.session_status,
    waitingFor: row.session_waiting_for,
    engine: row.session_engine,
    model: row.session_model_provider_id && row.session_model_model_id
      ? {
          providerId: row.session_model_provider_id,
          modelId: row.session_model_model_id,
          variant: row.session_model_variant,
        }
      : null,
    finalText: row.session_final_text,
    lastError: row.session_error_code && row.session_error_message
      ? { code: row.session_error_code, message: row.session_error_message }
      : null,
    messageCount: row.session_message_count,
    observedAt: row.session_observed_at.getTime(),
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
    targetComputerId: row.target_computer_id,
    targetWorkspaceId: row.target_workspace_id,
    expiresAt: row.expires_at.getTime(),
    claimedByRunnerId: row.claimed_by_runner_id,
    claimedAt: row.claimed_at?.getTime() ?? null,
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    resultSummary: row.result_summary,
    error: row.error_code && row.error_message ? { code: row.error_code, message: row.error_message } : null,
    session: mapSession(row),
    createdAt: row.created_at.getTime(),
    updatedAt: row.updated_at.getTime(),
  }
}

function mapDesktopSession(row: CommandRow): RemoteSessionDesktopSession | null {
  if (!row.claimed_by_runner_id || !row.session_id || !row.workspace_id) return null
  return {
    commandId: row.id,
    ownerMemberId: row.owner_member_id,
    runnerId: row.claimed_by_runner_id,
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    title: row.title,
    engine: row.session_engine,
    status: row.session_status,
    updatedAt: row.updated_at.getTime(),
  }
}

function desktopSessionScope(input: { organizationId: string; createdByUserId: string; workspaceId?: string }) {
  // Scope ids come from the MCP principal; one that is not a Den id owns no
  // desktop session rather than failing the call.
  let organizationId: DenTypeId<"organization">
  let createdByUserId: DenTypeId<"user">
  try {
    organizationId = normalizeDenTypeId("organization", input.organizationId)
    createdByUserId = normalizeDenTypeId("user", input.createdByUserId)
  } catch {
    return null
  }
  return and(
    eq(RemoteSessionCommandTable.org_id, organizationId),
    eq(RemoteSessionCommandTable.created_by_user_id, createdByUserId),
    eq(RemoteSessionCommandTable.status, "delivered"),
    isNotNull(RemoteSessionCommandTable.claimed_by_runner_id),
    isNotNull(RemoteSessionCommandTable.session_id),
    ...(input.workspaceId ? [eq(RemoteSessionCommandTable.workspace_id, input.workspaceId)] : []),
  )
}

function targetableBy(computerIds: RunnerComputerIds) {
  return computerIds.length > 0
    ? or(isNull(RemoteSessionCommandTable.target_computer_id), inArray(RemoteSessionCommandTable.target_computer_id, [...computerIds]))
    : isNull(RemoteSessionCommandTable.target_computer_id)
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
      target_computer_id: input.targetComputerId ?? null,
      target_workspace_id: input.targetWorkspaceId ?? null,
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
      targetableBy(input.computerIds),
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

  async report(input) {
    const commandId = commandIdOrNull(input.commandId)
    if (!commandId) return "not_found"
    const scope = and(
      eq(RemoteSessionCommandTable.id, commandId),
      eq(RemoteSessionCommandTable.org_id, normalizeDenTypeId("organization", input.organizationId)),
      eq(RemoteSessionCommandTable.owner_member_id, normalizeDenTypeId("member", input.ownerMemberId)),
    )
    const result = await db.update(RemoteSessionCommandTable).set({
      session_status: input.status,
      // Waiting only means something while the session is waiting.
      session_waiting_for: input.status === "waiting" ? input.waitingFor ?? null : null,
      // Engine and model are learned once; a report without them keeps the last value.
      ...(input.engine ? { session_engine: input.engine } : {}),
      ...(input.model
        ? {
            session_model_provider_id: input.model.providerId,
            session_model_model_id: input.model.modelId,
            session_model_variant: input.model.variant ?? null,
          }
        : {}),
      session_final_text: input.finalText ?? null,
      session_error_code: input.error?.code ?? null,
      session_error_message: input.error?.message ?? null,
      ...(input.messageCount === undefined ? {} : { session_message_count: input.messageCount }),
      session_observed_at: new Date(input.observedAt),
      updated_at: new Date(),
    }).where(and(
      scope,
      eq(RemoteSessionCommandTable.claimed_by_runner_id, input.runnerId),
      eq(RemoteSessionCommandTable.status, "delivered"),
    ))
    if (automationUpdateChangedRows(result)) return "reported"
    const existing = await db.select({ id: RemoteSessionCommandTable.id })
      .from(RemoteSessionCommandTable).where(scope).limit(1)
    return existing[0] ? "conflict" : "not_found"
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
      targetableBy(input.computerIds),
    )).orderBy(asc(RemoteSessionCommandTable.created_at), asc(RemoteSessionCommandTable.id)).limit(input.limit)
    return rows.map(mapCommand)
  },

  async findDesktopSession(input) {
    const scope = desktopSessionScope(input)
    if (!scope) return null
    const rows = await db.select().from(RemoteSessionCommandTable).where(and(
      scope,
      eq(RemoteSessionCommandTable.session_id, input.sessionId),
    )).orderBy(desc(RemoteSessionCommandTable.updated_at), desc(RemoteSessionCommandTable.id)).limit(1)
    return rows[0] ? mapDesktopSession(rows[0]) : null
  },

  async listDesktopSessions(input) {
    const scope = desktopSessionScope(input)
    if (!scope) return []
    const rows = await db.select().from(RemoteSessionCommandTable)
      .where(scope)
      .orderBy(desc(RemoteSessionCommandTable.updated_at), desc(RemoteSessionCommandTable.id))
      .limit(input.limit)
    return rows.flatMap((row) => {
      const session = mapDesktopSession(row)
      return session ? [session] : []
    })
  },

  async markTurnStarted(input) {
    const commandId = commandIdOrNull(input.commandId)
    if (!commandId) return
    const now = new Date(input.now)
    await db.update(RemoteSessionCommandTable).set({
      session_status: "running",
      session_waiting_for: null,
      session_final_text: null,
      session_error_code: null,
      session_error_message: null,
      session_observed_at: now,
      updated_at: now,
    }).where(and(
      eq(RemoteSessionCommandTable.id, commandId),
      eq(RemoteSessionCommandTable.claimed_by_runner_id, input.runnerId),
      eq(RemoteSessionCommandTable.status, "delivered"),
    ))
  },
}
