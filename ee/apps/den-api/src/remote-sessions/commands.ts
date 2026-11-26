import { createHash } from "node:crypto"
import { and, asc, desc, eq, getTableColumns, gt, inArray, isNotNull, isNull, lt, lte, or, sql } from "@openwork-ee/den-db/drizzle"
import { RemoteSessionCommandTable } from "@openwork-ee/den-db/schema/remote-session-commands"
import { createDenTypeId, normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import {
  remoteSessionPendingSchema,
  type RemoteSessionCommandCompleteRequest,
  type RemoteSessionCommandSessionReport,
  type RemoteSessionPending,
} from "@openwork/types/automations"
import { db } from "../db.js"
import { automationUpdateChangedRows } from "../automations/update-result.js"
import { signalRemoteSessionCommandUpdated, signalRemoteSessionUserUpdate, signalRemoteSessionWork } from "./work-signal.js"
import { deleteRemoteSessionTailsForCommands, saveRemoteSessionTail } from "./tails.js"

export const DEFAULT_TTL_MS = 10 * 60_000
const SESSION_COMMAND_LIMIT = 20

export class RemoteSessionIdempotencyConflictError extends Error {
  constructor() {
    super("remote_session_idempotency_conflict")
    this.name = "RemoteSessionIdempotencyConflictError"
  }
}

export class RemoteSessionAttachClaimRefusedError extends Error {
  constructor() {
    super("remote_session_attach_claim_refused")
    this.name = "RemoteSessionAttachClaimRefusedError"
  }
}

export type RemoteSessionCommandStatus = "pending" | "claimed" | "delivered" | "failed" | "expired"

export type RemoteSessionCommandKind = "create" | "attach"

export const DETACHED_ERROR_CODE = "detached"
export const DETACHED_MESSAGE = "This session is no longer connected. Connect to it again."

export function remoteSessionCommandDetached(command: Pick<RemoteSessionCommand, "kind" | "status" | "error">): boolean {
  return command.kind === "attach" && command.status === "failed" && command.error?.code === DETACHED_ERROR_CODE
}

export function detachedCommandValues(now: Date) {
  return {
    status: "failed" as const,
    error_code: DETACHED_ERROR_CODE,
    error_message: DETACHED_MESSAGE,
    idempotency_key: null,
    session_status: null,
    session_waiting_for: null,
    session_final_text: null,
    session_error_code: null,
    session_error_message: null,
    session_latest_step: null,
    session_pending: null,
    session_observed_at: null,
    updated_at: now,
  }
}

export function detachableCommands() {
  return and(eq(RemoteSessionCommandTable.kind, "attach"), eq(RemoteSessionCommandTable.status, "delivered"))
}

export type RemoteSessionProgress = {
  status: "running" | "waiting" | "idle" | "error"
  waitingFor: "permission" | "question" | null
  engine: "v1" | "v2" | null
  model: { providerId: string; modelId: string; variant: string | null } | null
  finalText: string | null
  lastError: { code: string; message: string } | null
  messageCount: number | null
  latestStep: string | null
  pending: RemoteSessionPending | null
  observedAt: number
}

export type RemoteSessionCommand = {
  id: string
  organizationId: string
  ownerMemberId: string
  createdByUserId: string
  status: RemoteSessionCommandStatus
  kind: RemoteSessionCommandKind
  title: string
  prompt: string | null
  model: { providerId: string; modelId: string; variant: string | null } | null
  idempotencyKey: string | null
  targetComputerId: string | null
  targetWorkspaceId: string | null
  targetSessionId: string | null
  parentSessionId: string | null
  parentWorkspaceId: string | null
  expiresAt: number
  claimedByRunnerId: string | null
  claimedAt: number | null
  sessionId: string | null
  workspaceId: string | null
  resultSummary: string | null
  error: { code: string; message: string } | null
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
  parentSessionId?: string
  parentWorkspaceId?: string
}

type AttachEnqueueInput = {
  organizationId: string
  ownerMemberId: string
  createdByUserId: string
  title: string
  ttlMs: number
  targetComputerId: string
  targetWorkspaceId: string
  targetSessionId: string
  parentSessionId?: string
  parentWorkspaceId?: string
}

type RunnerComputerIds = readonly string[]

type ClaimInput = {
  commandId: string
  organizationId: string
  ownerMemberId: string
  runnerId: string
  computerIds: RunnerComputerIds
  now: number
  recoverClaimed?: boolean
  claimAttach?: boolean
}

type CompleteInput = RemoteSessionCommandCompleteRequest & {
  commandId: string
  organizationId: string
  ownerMemberId: string
  runnerId: string
  now: number
}

type ReportInput = RemoteSessionCommandSessionReport & {
  commandId: string
  organizationId: string
  ownerMemberId: string
  runnerId: string
}

export type RemoteSessionReportResult = "reported" | "not_found" | "conflict"

export type RemoteSessionDesktopSession = {
  commandId: string
  ownerMemberId: string
  runnerId: string
  kind: RemoteSessionCommandKind
  detached: boolean
  sessionId: string
  workspaceId: string
  title: string
  engine: "v1" | "v2" | null
  status: RemoteSessionProgress["status"] | null
  updatedAt: number
}

type RunnerKinds = { kinds?: readonly RemoteSessionCommandKind[] }

export interface RemoteSessionCommandStore {
  enqueue(input: EnqueueInput): Promise<RemoteSessionCommand>
  enqueueAttach(input: AttachEnqueueInput): Promise<RemoteSessionCommand>
  claim(input: ClaimInput): Promise<RemoteSessionCommand | null>
  complete(input: CompleteInput): Promise<RemoteSessionCommand | null>
  report(input: ReportInput): Promise<RemoteSessionReportResult>
  get(input: { commandId: string; organizationId: string; createdByUserId: string }): Promise<RemoteSessionCommand | null>
  getMany(input: { commandIds: readonly string[]; organizationId: string; createdByUserId: string }): Promise<RemoteSessionCommand[]>
  latestSettled(input: { organizationId: string; ownerMemberId: string; since: number }): Promise<RemoteSessionCommand | null>
  listPendingForRunner(input: RunnerKinds & {
    organizationId: string
    ownerMemberId: string
    computerIds: RunnerComputerIds
    now: number
    limit: number
  }): Promise<RemoteSessionCommand[]>
  listRecoverableForRunner(input: RunnerKinds & {
    organizationId: string
    ownerMemberId: string
    runnerId: string
    now: number
    limit: number
  }): Promise<RemoteSessionCommand[]>
  listForSession(input: {
    organizationId: string
    createdByUserId: string
    workspaceId: string
    sessionId: string
    now: number
  }): Promise<RemoteSessionCommand[]>
  listForCreator(input: {
    organizationId: string
    createdByUserId: string
    now: number
    limit: number
  }): Promise<RemoteSessionCommand[]>
  listBoundForCreator?(input: {
    organizationId: string
    createdByUserId: string
    parentSessionId?: string
    now: number
    limit: number
  }): Promise<RemoteSessionCommand[]>
  bindParentIfUnbound?(input: {
    organizationId: string
    createdByUserId: string
    commandId: string
    parentSessionId: string
    parentWorkspaceId?: string | null
  }): Promise<boolean>
  detach(input: {
    organizationId: string
    runner?: { ownerMemberId: string; runnerId: string }
    now: number
  }): Promise<void>
  findDesktopSession(input: {
    organizationId: string
    createdByUserId: string
    sessionId: string
    workspaceId?: string
  }): Promise<RemoteSessionDesktopSession | null>
  listDesktopSessions(input: {
    organizationId: string
    createdByUserId: string
    workspaceId?: string
    limit: number
  }): Promise<RemoteSessionDesktopSession[]>
  markTurnStarted(input: { commandId: string; organizationId: string; ownerMemberId: string; runnerId: string; now: number }): Promise<void>
}

type CommandRow = typeof RemoteSessionCommandTable.$inferSelect

function commandIdOrNull(value: string): DenTypeId<"remoteSessionCommand"> | null {
  try {
    return normalizeDenTypeId("remoteSessionCommand", value)
  } catch {
    return null
  }
}

function mapPending(row: CommandRow): RemoteSessionPending | null {
  if (row.session_status !== "waiting" || row.session_pending === null) return null
  const parsed = remoteSessionPendingSchema.safeParse(row.session_pending)
  return parsed.success ? parsed.data : null
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
    latestStep: row.session_latest_step,
    pending: mapPending(row),
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
    kind: row.kind,
    title: row.title,
    prompt: row.prompt,
    model: row.model_provider_id && row.model_model_id
      ? { providerId: row.model_provider_id, modelId: row.model_model_id, variant: row.model_variant }
      : null,
    idempotencyKey: row.idempotency_key,
    targetComputerId: row.target_computer_id,
    targetWorkspaceId: row.target_workspace_id,
    targetSessionId: row.target_session_id,
    parentSessionId: row.parent_session_id,
    parentWorkspaceId: row.parent_workspace_id,
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
    kind: row.kind,
    detached: row.status !== "delivered",
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    title: row.title,
    engine: row.session_engine,
    status: row.session_status,
    updatedAt: row.updated_at.getTime(),
  }
}

function desktopSessionScope(
  input: { organizationId: string; createdByUserId: string; workspaceId?: string },
  options: { detached?: boolean } = {},
) {
  let organizationId: DenTypeId<"organization">
  let createdByUserId: DenTypeId<"user">
  try {
    organizationId = normalizeDenTypeId("organization", input.organizationId)
    createdByUserId = normalizeDenTypeId("user", input.createdByUserId)
  } catch {
    return null
  }
  const delivered = eq(RemoteSessionCommandTable.status, "delivered")
  return and(
    eq(RemoteSessionCommandTable.org_id, organizationId),
    eq(RemoteSessionCommandTable.created_by_user_id, createdByUserId),
    options.detached
      ? or(delivered, and(
        eq(RemoteSessionCommandTable.kind, "attach"),
        eq(RemoteSessionCommandTable.status, "failed"),
        eq(RemoteSessionCommandTable.error_code, DETACHED_ERROR_CODE),
      ))
      : delivered,
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

function ofKinds(kinds: readonly RemoteSessionCommandKind[] = ["create"]) {
  return inArray(RemoteSessionCommandTable.kind, [...kinds])
}

const { prompt: _prompt, session_final_text: _sessionFinalText, ...listedCommandColumns } = getTableColumns(RemoteSessionCommandTable)

function mapListedCommand(row: Omit<CommandRow, "prompt" | "session_final_text">): RemoteSessionCommand {
  return mapCommand({ ...row, prompt: null, session_final_text: null })
}

function attachIdempotencyKey(input: AttachEnqueueInput): string {
  const scope = [
    normalizeDenTypeId("organization", input.organizationId), normalizeDenTypeId("user", input.createdByUserId),
    input.targetComputerId, input.targetWorkspaceId, input.targetSessionId,
  ].join("\0")
  return `attach_${createHash("sha256").update(scope).digest("hex")}`
}

function attachQueued(command: RemoteSessionCommand, now: number): boolean {
  return (command.status === "pending" || command.status === "claimed") && command.expiresAt > now
}

async function commandById(commandId: string): Promise<RemoteSessionCommand | null> {
  const rows = await db.$primary.select().from(RemoteSessionCommandTable)
    .where(eq(RemoteSessionCommandTable.id, normalizeDenTypeId("remoteSessionCommand", commandId)))
    .limit(1)
  return rows[0] ? mapCommand(rows[0]) : null
}

export function remoteSessionCommandRecoverable(command: RemoteSessionCommand, input: {
  organizationId: string; ownerMemberId: string; runnerId: string; now: number
}) {
  return command.organizationId === normalizeDenTypeId("organization", input.organizationId)
    && command.ownerMemberId === normalizeDenTypeId("member", input.ownerMemberId)
    && command.claimedByRunnerId === input.runnerId
    && command.status === "claimed"
    && command.expiresAt > input.now
}

export function remoteSessionCommandCompletionMatches(command: RemoteSessionCommand, input: CompleteInput) {
  return command.organizationId === normalizeDenTypeId("organization", input.organizationId)
    && command.ownerMemberId === normalizeDenTypeId("member", input.ownerMemberId)
    && command.claimedByRunnerId === input.runnerId
    && command.status === input.status
    && command.sessionId === (input.sessionId ?? null)
    && command.workspaceId === (input.workspaceId ?? null)
    && command.resultSummary === (input.resultSummary ?? null)
    && (command.error?.code ?? null) === (input.error?.code ?? null)
    && (command.error?.message ?? null) === (input.error?.message ?? null)
}

function duplicateEntry(error: unknown, depth = 0): boolean {
  if (depth > 5 || typeof error !== "object" || error === null) return false
  if (("code" in error && error.code === "ER_DUP_ENTRY") || ("errno" in error && error.errno === 1062)) return true
  return "cause" in error && duplicateEntry(error.cause, depth + 1)
}

async function commandByIdempotencyScope(
  input: Pick<EnqueueInput, "organizationId" | "createdByUserId" | "idempotencyKey">,
): Promise<RemoteSessionCommand | null> {
  if (!input.idempotencyKey) return null
  const rows = await db.$primary.select().from(RemoteSessionCommandTable).where(and(
    eq(RemoteSessionCommandTable.org_id, normalizeDenTypeId("organization", input.organizationId)),
    eq(RemoteSessionCommandTable.created_by_user_id, normalizeDenTypeId("user", input.createdByUserId)),
    eq(RemoteSessionCommandTable.idempotency_key, input.idempotencyKey),
  )).limit(1)
  return rows[0] ? mapCommand(rows[0]) : null
}

async function releaseIdempotencyKey(command: RemoteSessionCommand): Promise<void> {
  if (!command.idempotencyKey) return
  await db.update(RemoteSessionCommandTable).set({ idempotency_key: null }).where(and(
    eq(RemoteSessionCommandTable.id, normalizeDenTypeId("remoteSessionCommand", command.id)),
    eq(RemoteSessionCommandTable.idempotency_key, command.idempotencyKey),
  ))
}

export function remoteSessionCommandAdmissionMatches(command: RemoteSessionCommand, input: EnqueueInput) {
  return command.organizationId === normalizeDenTypeId("organization", input.organizationId)
    && command.createdByUserId === normalizeDenTypeId("user", input.createdByUserId)
    && command.idempotencyKey === (input.idempotencyKey ?? null)
    && command.title === input.title && command.prompt === (input.prompt ?? null)
    && (command.model?.providerId ?? null) === (input.model?.providerId ?? null)
    && (command.model?.modelId ?? null) === (input.model?.modelId ?? null)
    && (command.model?.variant ?? null) === (input.model?.variant ?? null)
    && command.targetComputerId === (input.targetComputerId ?? null)
    && command.targetWorkspaceId === (input.targetWorkspaceId ?? null)
}

function existingAdmission(command: RemoteSessionCommand, input: EnqueueInput) {
  if (!remoteSessionCommandAdmissionMatches(command, input)) throw new RemoteSessionIdempotencyConflictError()
  return command
}

export const databaseRemoteSessionCommandStore: RemoteSessionCommandStore = {
  async enqueue(input) {
    const now = Date.now()
    const existing = await commandByIdempotencyScope(input)
    if (existing && existing.expiresAt > now) return existingAdmission(existing, input)
    if (existing) await releaseIdempotencyKey(existing)
    const id = createDenTypeId("remoteSessionCommand")
    try {
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
        parent_session_id: input.parentSessionId ?? null,
        parent_workspace_id: input.parentWorkspaceId ?? null,
        expires_at: new Date(now + input.ttlMs),
        created_at: new Date(now),
        updated_at: new Date(now),
      })
    } catch (error) {
      if (!input.idempotencyKey || !duplicateEntry(error)) throw error
      const winner = await commandByIdempotencyScope(input)
      if (winner) return existingAdmission(winner, input)
      const collisions = await db.$primary.select({ id: RemoteSessionCommandTable.id }).from(RemoteSessionCommandTable)
        .where(eq(RemoteSessionCommandTable.idempotency_key, input.idempotencyKey)).limit(1)
      if (collisions.length > 0) throw new RemoteSessionIdempotencyConflictError()
      throw error
    }
    const command = await commandById(id)
    if (!command) throw new Error("remote_session_command_enqueue_failed")
    signalRemoteSessionWork(command.organizationId, command.ownerMemberId)
    signalRemoteSessionUserUpdate(command.organizationId, command.createdByUserId)
    return command
  },

  async enqueueAttach(input) {
    const now = Date.now()
    const key = attachIdempotencyKey(input)
    const holder = await commandByIdempotencyScope({ ...input, idempotencyKey: key })
    if (holder && attachQueued(holder, now)) return holder
    if (holder) await releaseIdempotencyKey(holder)
    const id = createDenTypeId("remoteSessionCommand")
    try {
      await db.insert(RemoteSessionCommandTable).values({
        id,
        org_id: normalizeDenTypeId("organization", input.organizationId),
        owner_member_id: normalizeDenTypeId("member", input.ownerMemberId),
        created_by_user_id: normalizeDenTypeId("user", input.createdByUserId),
        status: "pending",
        kind: "attach",
        title: input.title,
        prompt: null,
        idempotency_key: key,
        target_computer_id: input.targetComputerId,
        target_workspace_id: input.targetWorkspaceId,
        target_session_id: input.targetSessionId,
        parent_session_id: input.parentSessionId ?? null,
        parent_workspace_id: input.parentWorkspaceId ?? null,
        expires_at: new Date(now + input.ttlMs),
        created_at: new Date(now),
        updated_at: new Date(now),
      })
    } catch (error) {
      if (!duplicateEntry(error)) throw error
      const winner = await commandByIdempotencyScope({ ...input, idempotencyKey: key })
      if (!winner) throw error
      return winner
    }
    const command = await commandById(id)
    if (!command) throw new Error("remote_session_command_enqueue_failed")
    signalRemoteSessionWork(command.organizationId, command.ownerMemberId)
    signalRemoteSessionUserUpdate(command.organizationId, command.createdByUserId)
    return command
  },

  async claim(input) {
    const commandId = commandIdOrNull(input.commandId)
    if (!commandId) return null
    return db.transaction(async (tx) => {
      const scope = and(
        eq(RemoteSessionCommandTable.id, commandId),
        eq(RemoteSessionCommandTable.org_id, normalizeDenTypeId("organization", input.organizationId)),
        eq(RemoteSessionCommandTable.owner_member_id, normalizeDenTypeId("member", input.ownerMemberId)),
      )
      const rows = await tx.select().from(RemoteSessionCommandTable).where(scope).limit(1).for("update")
      const existing = rows[0] ? mapCommand(rows[0]) : null
      if (!existing || existing.expiresAt <= input.now) return null
      if (existing.kind === "attach" && !input.claimAttach) throw new RemoteSessionAttachClaimRefusedError()
      if (input.recoverClaimed && remoteSessionCommandRecoverable(existing, input)) return existing
      if (existing.status !== "pending") return null
      if (existing.targetComputerId && !input.computerIds.includes(existing.targetComputerId)) return null
      const now = new Date(input.now)
      await tx.update(RemoteSessionCommandTable).set({
        status: "claimed", claimed_by_runner_id: input.runnerId, claimed_at: now, updated_at: now,
      }).where(and(scope, eq(RemoteSessionCommandTable.status, "pending"), gt(RemoteSessionCommandTable.expires_at, now)))
      return { ...existing, status: "claimed", claimedByRunnerId: input.runnerId, claimedAt: input.now, updatedAt: input.now }
    })
  },

  async complete(input) {
    const commandId = commandIdOrNull(input.commandId)
    if (!commandId) return null
    const completed = await db.transaction(async (tx) => {
      const scope = and(
        eq(RemoteSessionCommandTable.id, commandId),
        eq(RemoteSessionCommandTable.org_id, normalizeDenTypeId("organization", input.organizationId)),
        eq(RemoteSessionCommandTable.owner_member_id, normalizeDenTypeId("member", input.ownerMemberId)),
        eq(RemoteSessionCommandTable.claimed_by_runner_id, input.runnerId),
      )
      const rows = await tx.select().from(RemoteSessionCommandTable).where(scope).limit(1).for("update")
      const existing = rows[0] ? mapCommand(rows[0]) : null
      if (!existing) return null
      if (existing.status === "delivered" || existing.status === "failed") {
        return remoteSessionCommandCompletionMatches(existing, input) ? existing : null
      }
      if (!["claimed", "expired"].includes(existing.status) || existing.claimedAt === null) return null
      if (existing.kind === "attach" && input.status === "delivered"
        && (input.sessionId !== existing.targetSessionId || input.workspaceId !== existing.targetWorkspaceId)) return null
      const now = new Date(input.now)
      await tx.update(RemoteSessionCommandTable).set({
        status: input.status,
        session_id: input.sessionId ?? null,
        workspace_id: input.workspaceId ?? null,
        result_summary: input.resultSummary ?? null,
        error_code: input.error?.code ?? null,
        error_message: input.error?.message ?? null,
        updated_at: now,
      }).where(and(scope, inArray(RemoteSessionCommandTable.status, ["claimed", "expired"])))
      return {
        ...existing, status: input.status, sessionId: input.sessionId ?? null, workspaceId: input.workspaceId ?? null,
        resultSummary: input.resultSummary ?? null, error: input.error ?? null, updatedAt: input.now,
      }
    })
    if (completed) {
      signalRemoteSessionCommandUpdated(completed.id)
      signalRemoteSessionUserUpdate(completed.organizationId, completed.createdByUserId)
    }
    return completed
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
      session_waiting_for: input.status === "waiting" ? input.waitingFor ?? null : null,
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
      session_latest_step: input.latestStep ?? null,
      session_pending: input.status === "waiting" && input.pending ? input.pending : null,
      session_observed_at: new Date(input.observedAt),
      updated_at: new Date(),
    }).where(and(
      scope,
      eq(RemoteSessionCommandTable.claimed_by_runner_id, input.runnerId),
      eq(RemoteSessionCommandTable.status, "delivered"),
      or(isNull(RemoteSessionCommandTable.session_observed_at), lt(RemoteSessionCommandTable.session_observed_at, new Date(input.observedAt))),
    ))
    if (automationUpdateChangedRows(result)) {
      signalRemoteSessionCommandUpdated(commandId)
      const [reportedRow] = await db.$primary.select({
        createdByUserId: RemoteSessionCommandTable.created_by_user_id,
        title: RemoteSessionCommandTable.title,
        prompt: RemoteSessionCommandTable.prompt,
      }).from(RemoteSessionCommandTable).where(scope).limit(1)
      if (reportedRow) {
        if (input.tail) {
          await saveRemoteSessionTail({
            organizationId: input.organizationId,
            createdByUserId: reportedRow.createdByUserId,
            threadKey: `command:${commandId}`,
            ownerMemberId: input.ownerMemberId,
            commandId,
            runnerId: input.runnerId,
            page: input.tail,
            now: input.observedAt,
          }).catch(() => undefined)
        }
        signalRemoteSessionUserUpdate(input.organizationId, reportedRow.createdByUserId)
      }
      return "reported"
    }
    const existing = await db.$primary.select().from(RemoteSessionCommandTable).where(scope).limit(1)
    const row = existing[0]
    if (!row) return "not_found"
    if (row.status === "delivered" && row.claimed_by_runner_id === input.runnerId
      && row.session_observed_at?.getTime() === input.observedAt) return "reported"
    return "conflict"
  },

  async latestSettled(input) {
    const rows = await db.select().from(RemoteSessionCommandTable).where(and(
      eq(RemoteSessionCommandTable.org_id, normalizeDenTypeId("organization", input.organizationId)),
      eq(RemoteSessionCommandTable.owner_member_id, normalizeDenTypeId("member", input.ownerMemberId)),
      inArray(RemoteSessionCommandTable.status, ["delivered", "failed"]),
      gt(RemoteSessionCommandTable.updated_at, new Date(input.since)),
    )).orderBy(desc(RemoteSessionCommandTable.updated_at), desc(RemoteSessionCommandTable.id)).limit(1)
    return rows[0] ? mapCommand(rows[0]) : null
  },

  async get(input) {
    const commandId = commandIdOrNull(input.commandId)
    if (!commandId) return null
    const organizationId = normalizeDenTypeId("organization", input.organizationId)
    const createdByUserId = normalizeDenTypeId("user", input.createdByUserId)
    const rows = await db.$primary.select().from(RemoteSessionCommandTable).where(and(
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
    const updated = await db.$primary.select().from(RemoteSessionCommandTable).where(and(
      eq(RemoteSessionCommandTable.id, commandId),
      eq(RemoteSessionCommandTable.org_id, organizationId),
      eq(RemoteSessionCommandTable.created_by_user_id, createdByUserId),
    )).limit(1)
    return updated[0] ? mapCommand(updated[0]) : null
  },

  async getMany(input) {
    const commandIds = [...new Set(input.commandIds.flatMap((id) => commandIdOrNull(id) ?? []))]
    if (commandIds.length === 0) return []
    const scope = {
      organizationId: normalizeDenTypeId("organization", input.organizationId),
      createdByUserId: normalizeDenTypeId("user", input.createdByUserId),
    }
    const rows = await db.$primary.select().from(RemoteSessionCommandTable).where(and(
      inArray(RemoteSessionCommandTable.id, commandIds),
      eq(RemoteSessionCommandTable.org_id, scope.organizationId),
      eq(RemoteSessionCommandTable.created_by_user_id, scope.createdByUserId),
    ))
    const now = Date.now()
    return Promise.all(rows.map(mapCommand).map(async (command) => (
      ["pending", "claimed"].includes(command.status) && command.expiresAt <= now
        ? await databaseRemoteSessionCommandStore.get({ commandId: command.id, ...scope }) ?? command
        : command
    )))
  },

  async listPendingForRunner(input) {
    const rows = await db.$primary.select().from(RemoteSessionCommandTable).where(and(
      eq(RemoteSessionCommandTable.org_id, normalizeDenTypeId("organization", input.organizationId)),
      eq(RemoteSessionCommandTable.owner_member_id, normalizeDenTypeId("member", input.ownerMemberId)),
      eq(RemoteSessionCommandTable.status, "pending"),
      gt(RemoteSessionCommandTable.expires_at, new Date(input.now)),
      targetableBy(input.computerIds),
      ofKinds(input.kinds),
    )).orderBy(asc(RemoteSessionCommandTable.created_at), asc(RemoteSessionCommandTable.id)).limit(input.limit)
    return rows.map(mapCommand)
  },

  async listRecoverableForRunner(input) {
    const rows = await db.$primary.select().from(RemoteSessionCommandTable).where(and(
      eq(RemoteSessionCommandTable.org_id, normalizeDenTypeId("organization", input.organizationId)),
      eq(RemoteSessionCommandTable.owner_member_id, normalizeDenTypeId("member", input.ownerMemberId)),
      eq(RemoteSessionCommandTable.claimed_by_runner_id, input.runnerId),
      eq(RemoteSessionCommandTable.status, "claimed"),
      gt(RemoteSessionCommandTable.expires_at, new Date(input.now)),
      ofKinds(input.kinds),
    )).orderBy(asc(RemoteSessionCommandTable.claimed_at), asc(RemoteSessionCommandTable.id)).limit(input.limit)
    return rows.map(mapCommand)
  },

  async listForSession(input) {
    const rows = await db.$primary.select(listedCommandColumns).from(RemoteSessionCommandTable).where(and(
      eq(RemoteSessionCommandTable.org_id, normalizeDenTypeId("organization", input.organizationId)),
      eq(RemoteSessionCommandTable.created_by_user_id, normalizeDenTypeId("user", input.createdByUserId)),
      or(
        and(
          eq(RemoteSessionCommandTable.status, "delivered"),
          eq(RemoteSessionCommandTable.session_id, input.sessionId),
          eq(RemoteSessionCommandTable.workspace_id, input.workspaceId),
        ),
        and(
          eq(RemoteSessionCommandTable.kind, "attach"),
          inArray(RemoteSessionCommandTable.status, ["pending", "claimed"]),
          gt(RemoteSessionCommandTable.expires_at, new Date(input.now)),
          eq(RemoteSessionCommandTable.target_session_id, input.sessionId),
          eq(RemoteSessionCommandTable.target_workspace_id, input.workspaceId),
        ),
      ),
    )).orderBy(desc(RemoteSessionCommandTable.updated_at), desc(RemoteSessionCommandTable.id)).limit(SESSION_COMMAND_LIMIT)
    return rows.map(mapListedCommand)
  },

  async listForCreator(input) {
    const rows = await db.$primary.select(listedCommandColumns).from(RemoteSessionCommandTable).where(and(
      eq(RemoteSessionCommandTable.org_id, normalizeDenTypeId("organization", input.organizationId)),
      eq(RemoteSessionCommandTable.created_by_user_id, normalizeDenTypeId("user", input.createdByUserId)),
      or(
        eq(RemoteSessionCommandTable.status, "delivered"),
        and(
          inArray(RemoteSessionCommandTable.status, ["pending", "claimed"]),
          gt(RemoteSessionCommandTable.expires_at, new Date(input.now)),
        ),
      ),
    )).orderBy(desc(RemoteSessionCommandTable.updated_at), desc(RemoteSessionCommandTable.id)).limit(input.limit)
    return rows.map(mapListedCommand)
  },

  async listBoundForCreator(input) {
    const rows = await db.$primary.select().from(RemoteSessionCommandTable).where(and(
      eq(RemoteSessionCommandTable.org_id, normalizeDenTypeId("organization", input.organizationId)),
      eq(RemoteSessionCommandTable.created_by_user_id, normalizeDenTypeId("user", input.createdByUserId)),
      ...(input.parentSessionId ? [eq(RemoteSessionCommandTable.parent_session_id, input.parentSessionId)] : []),
      or(
        eq(RemoteSessionCommandTable.status, "delivered"),
        and(
          inArray(RemoteSessionCommandTable.status, ["pending", "claimed"]),
          gt(RemoteSessionCommandTable.expires_at, new Date(input.now)),
        ),
      ),
    )).orderBy(desc(RemoteSessionCommandTable.updated_at), desc(RemoteSessionCommandTable.id)).limit(input.limit)
    return rows.map(mapCommand)
  },

  async bindParentIfUnbound(input) {
    const commandId = commandIdOrNull(input.commandId)
    if (!commandId) return false
    const orgId = normalizeDenTypeId("organization", input.organizationId)
    const userId = normalizeDenTypeId("user", input.createdByUserId)
    const result = await db.update(RemoteSessionCommandTable).set({
      parent_session_id: input.parentSessionId,
      parent_workspace_id: input.parentWorkspaceId ?? null,
      updated_at: new Date(),
    }).where(and(
      eq(RemoteSessionCommandTable.id, commandId),
      eq(RemoteSessionCommandTable.org_id, orgId),
      eq(RemoteSessionCommandTable.created_by_user_id, userId),
      isNull(RemoteSessionCommandTable.parent_session_id),
    ))
    if (!automationUpdateChangedRows(result)) return false
    signalRemoteSessionUserUpdate(orgId, userId)
    return true
  },

  async detach(input) {
    const condition = and(
      eq(RemoteSessionCommandTable.org_id, normalizeDenTypeId("organization", input.organizationId)),
      ...(input.runner
        ? [
          eq(RemoteSessionCommandTable.owner_member_id, normalizeDenTypeId("member", input.runner.ownerMemberId)),
          eq(RemoteSessionCommandTable.claimed_by_runner_id, input.runner.runnerId),
        ]
        : []),
      detachableCommands(),
    )
    const doomed = await db.$primary.select({
      id: RemoteSessionCommandTable.id,
      createdByUserId: RemoteSessionCommandTable.created_by_user_id,
    }).from(RemoteSessionCommandTable).where(condition)
    if (doomed.length === 0) return
    await db.update(RemoteSessionCommandTable).set(detachedCommandValues(new Date(input.now))).where(condition)
    await deleteRemoteSessionTailsForCommands({
      organizationId: input.organizationId,
      commandIds: doomed.map((row) => row.id),
    })
    for (const row of doomed) {
      signalRemoteSessionCommandUpdated(row.id)
      signalRemoteSessionUserUpdate(input.organizationId, row.createdByUserId)
    }
  },

  async findDesktopSession(input) {
    const scope = desktopSessionScope(input, { detached: true })
    if (!scope) return null
    const rows = await db.select().from(RemoteSessionCommandTable).where(and(
      scope,
      eq(RemoteSessionCommandTable.session_id, input.sessionId),
    )).orderBy(
      desc(sql`${RemoteSessionCommandTable.status} = 'delivered'`),
      desc(sql`${RemoteSessionCommandTable.kind} = 'create'`),
      desc(RemoteSessionCommandTable.updated_at),
      desc(RemoteSessionCommandTable.id),
    ).limit(1)
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
      session_pending: null,
      session_final_text: null,
      session_error_code: null,
      session_error_message: null,
      session_observed_at: null,
      updated_at: now,
    }).where(and(
      eq(RemoteSessionCommandTable.id, commandId),
      eq(RemoteSessionCommandTable.org_id, normalizeDenTypeId("organization", input.organizationId)),
      eq(RemoteSessionCommandTable.owner_member_id, normalizeDenTypeId("member", input.ownerMemberId)),
      eq(RemoteSessionCommandTable.claimed_by_runner_id, input.runnerId),
      eq(RemoteSessionCommandTable.status, "delivered"),
    ))
  },
}
