import { randomBytes } from "node:crypto"
import { and, asc, eq, gt, gte, inArray, isNull, lt, lte, or, sql } from "@openwork-ee/den-db/drizzle"
import { WorkerTable } from "@openwork-ee/den-db/schema"
import {
  TelegramChatBindingTable,
  TelegramConnectionTable,
  TelegramPairingTable,
  TelegramUpdateTable,
} from "@openwork-ee/den-db/schema/telegram"
import { createDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../db.js"
import { loadTelegramWorkerAccess } from "./telegram-worker.js"

export type TelegramConnectionRow = typeof TelegramConnectionTable.$inferSelect
export type TelegramChatBindingRow = typeof TelegramChatBindingTable.$inferSelect
export type TelegramUpdateRow = typeof TelegramUpdateTable.$inferSelect
export type TelegramUpdateStatus = NonNullable<typeof TelegramUpdateTable.$inferInsert.status>

export function isDuplicateDatabaseEntry(error: unknown): boolean {
  const visited = new Set<object>()
  let current = error
  while (typeof current === "object" && current !== null && !visited.has(current)) {
    visited.add(current)
    if ("code" in current && current.code === "ER_DUP_ENTRY") return true
    if ("errno" in current && current.errno === 1062) return true
    if (
      "message" in current
      && typeof current.message === "string"
      && /duplicate entry|unique constraint/i.test(current.message)
    ) return true
    current = "cause" in current ? current.cause : null
  }
  return false
}

export async function getTelegramConnectionByOrganization(
  organizationId: DenTypeId<"organization">,
): Promise<TelegramConnectionRow | null> {
  const rows = await db
    .select()
    .from(TelegramConnectionTable)
    .where(eq(TelegramConnectionTable.organizationId, organizationId))
    .limit(1)
  return rows[0] ?? null
}

export async function getTelegramConnectionById(
  connectionId: DenTypeId<"telegramConnection">,
): Promise<TelegramConnectionRow | null> {
  const rows = await db
    .select()
    .from(TelegramConnectionTable)
    .where(eq(TelegramConnectionTable.id, connectionId))
    .limit(1)
  return rows[0] ?? null
}

export async function getTelegramChatBinding(
  connectionId: DenTypeId<"telegramConnection">,
): Promise<TelegramChatBindingRow | null> {
  const rows = await db
    .select()
    .from(TelegramChatBindingTable)
    .where(eq(TelegramChatBindingTable.connectionId, connectionId))
    .limit(1)
  return rows[0] ?? null
}

export async function telegramConnectionView(connection: TelegramConnectionRow) {
  const [workers, binding, workerAccess] = await Promise.all([
    db
      .select({ id: WorkerTable.id, name: WorkerTable.name, status: WorkerTable.status })
      .from(WorkerTable)
      .where(and(
        eq(WorkerTable.id, connection.workerId),
        eq(WorkerTable.org_id, connection.organizationId),
      ))
      .limit(1),
    getTelegramChatBinding(connection.id),
    loadTelegramWorkerAccess({
      organizationId: connection.organizationId,
      workerId: connection.workerId,
    }),
  ])
  const worker = workers[0]

  return {
    id: connection.id,
    status: connection.status,
    connected: connection.status === "active" && connection.webhookRegistered && Boolean(workerAccess),
    bot: {
      id: connection.botId,
      username: connection.botUsername,
      displayName: connection.botDisplayName,
    },
    worker: {
      id: connection.workerId,
      name: worker?.name ?? "Unavailable worker",
      status: worker?.status ?? "missing",
    },
    webhook: {
      registered: connection.webhookRegistered,
      lastReceivedAt: connection.lastWebhookAt?.toISOString() ?? null,
      lastError: connection.lastError,
    },
    pairing: {
      paired: Boolean(binding),
      chat: binding
        ? {
            username: binding.telegramUsername,
            firstName: binding.telegramFirstName,
            pairedAt: binding.pairedAt.toISOString(),
          }
        : null,
    },
    createdAt: connection.createdAt.toISOString(),
    updatedAt: connection.updatedAt.toISOString(),
  }
}

async function deleteConnectionRows(
  connectionId: DenTypeId<"telegramConnection">,
) {
  await db.transaction(async (tx) => {
    await tx.delete(TelegramUpdateTable).where(eq(TelegramUpdateTable.connectionId, connectionId))
    await tx.delete(TelegramPairingTable).where(eq(TelegramPairingTable.connectionId, connectionId))
    await tx.delete(TelegramChatBindingTable).where(eq(TelegramChatBindingTable.connectionId, connectionId))
    await tx.delete(TelegramConnectionTable).where(eq(TelegramConnectionTable.id, connectionId))
  })
}

export async function deleteTelegramConnection(connectionId: DenTypeId<"telegramConnection">) {
  await deleteConnectionRows(connectionId)
}

export async function replaceTelegramConnection(input: {
  activateWebhook: (connection: TelegramConnectionRow) => Promise<void>
  bot: { displayName: string; id: string; username: string }
  botToken: string
  connectionId: DenTypeId<"telegramConnection">
  createdByOrgMembershipId: DenTypeId<"member">
  organizationId: DenTypeId<"organization">
  webhookSecret: string
  workerId: DenTypeId<"worker">
}) {
  const existing = await getTelegramConnectionByOrganization(input.organizationId)
  const id = input.connectionId
  const nextValues = {
    organizationId: input.organizationId,
    workerId: input.workerId,
    createdByOrgMembershipId: input.createdByOrgMembershipId,
    botToken: input.botToken,
    webhookSecret: input.webhookSecret,
    botId: input.bot.id,
    botUsername: input.bot.username,
    botDisplayName: input.bot.displayName,
    status: "active",
    webhookRegistered: false,
    dispatchToken: null,
    dispatchStartedAt: null,
    lastWebhookAt: null,
    lastError: null,
  } satisfies Omit<typeof TelegramConnectionTable.$inferInsert, "id">

  await db.transaction(async (tx) => {
    if (existing) {
      await tx
        .update(TelegramConnectionTable)
        .set(nextValues)
        .where(eq(TelegramConnectionTable.id, existing.id))
    } else {
      await tx.insert(TelegramConnectionTable).values({ id, ...nextValues })
    }

    const staged: TelegramConnectionRow = {
      id,
      ...nextValues,
      createdAt: existing?.createdAt ?? new Date(),
      updatedAt: new Date(),
    }
    await input.activateWebhook(staged)

    if (existing) {
      await tx.delete(TelegramUpdateTable).where(eq(TelegramUpdateTable.connectionId, existing.id))
      await tx.delete(TelegramPairingTable).where(eq(TelegramPairingTable.connectionId, existing.id))
      await tx.delete(TelegramChatBindingTable).where(eq(TelegramChatBindingTable.connectionId, existing.id))
    }
    await tx
      .update(TelegramConnectionTable)
      .set({ status: "active", webhookRegistered: true, lastError: null })
      .where(eq(TelegramConnectionTable.id, id))
  })

  const connection = await getTelegramConnectionById(id)
  if (!connection) throw new Error("Telegram connection was not persisted.")
  return { connection, replaced: existing }
}

export async function markTelegramWebhookRegistered(
  connectionId: DenTypeId<"telegramConnection">,
) {
  await db
    .update(TelegramConnectionTable)
    .set({ status: "active", webhookRegistered: true, lastError: null })
    .where(eq(TelegramConnectionTable.id, connectionId))
}

export async function markTelegramConnectionError(
  connectionId: DenTypeId<"telegramConnection">,
  message: string,
) {
  await db
    .update(TelegramConnectionTable)
    .set({ status: "error", webhookRegistered: false, lastError: message.slice(0, 2_000) })
    .where(eq(TelegramConnectionTable.id, connectionId))
}

export async function noteTelegramWebhookReceived(
  connectionId: DenTypeId<"telegramConnection">,
) {
  await db
    .update(TelegramConnectionTable)
    .set({ lastWebhookAt: new Date() })
    .where(eq(TelegramConnectionTable.id, connectionId))
}

export async function createTelegramPairing(input: {
  connectionId: DenTypeId<"telegramConnection">
  expiresAt: Date
  tokenHash: string
}) {
  await db.transaction(async (tx) => {
    const connections = await tx
      .select({ id: TelegramConnectionTable.id })
      .from(TelegramConnectionTable)
      .where(eq(TelegramConnectionTable.id, input.connectionId))
      .limit(1)
      .for("update")
    if (!connections[0]) throw new Error("Telegram connection not found.")

    await tx.delete(TelegramPairingTable).where(eq(TelegramPairingTable.connectionId, input.connectionId))
    await tx.delete(TelegramChatBindingTable).where(eq(TelegramChatBindingTable.connectionId, input.connectionId))
    await tx.insert(TelegramPairingTable).values({
      id: createDenTypeId("telegramPairing"),
      connectionId: input.connectionId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
    })
  })
}

export async function consumeTelegramPairing(input: {
  chatId: string
  connectionId: DenTypeId<"telegramConnection">
  dispatchToken: string
  firstName: string
  tokenHash: string
  userId: string
  username: string | null
}): Promise<{ paired: boolean }> {
  const bindingId = createDenTypeId("telegramChatBinding")
  try {
    const current = await db.transaction(async (tx) => {
      const connectionRows = await tx
        .select({ id: TelegramConnectionTable.id })
        .from(TelegramConnectionTable)
        .where(and(
          eq(TelegramConnectionTable.id, input.connectionId),
          eq(TelegramConnectionTable.status, "active"),
          eq(TelegramConnectionTable.webhookRegistered, true),
          eq(TelegramConnectionTable.dispatchToken, input.dispatchToken),
        ))
        .limit(1)
        .for("update")
      if (!connectionRows[0]) return false

      const now = new Date()
      const pairingRows = await tx
        .select({ id: TelegramPairingTable.id })
        .from(TelegramPairingTable)
        .where(and(
          eq(TelegramPairingTable.connectionId, input.connectionId),
          eq(TelegramPairingTable.tokenHash, input.tokenHash),
          isNull(TelegramPairingTable.usedAt),
          gt(TelegramPairingTable.expiresAt, now),
        ))
        .limit(1)
        .for("update")
      const pairing = pairingRows[0]
      if (!pairing) {
        const bindings = await tx
          .select({ chatId: TelegramChatBindingTable.telegramChatId, userId: TelegramChatBindingTable.telegramUserId })
          .from(TelegramChatBindingTable)
          .where(eq(TelegramChatBindingTable.connectionId, input.connectionId))
          .limit(1)
        return bindings[0]?.chatId === input.chatId && bindings[0]?.userId === input.userId
      }

      await tx
        .update(TelegramPairingTable)
        .set({ usedAt: now })
        .where(and(
          eq(TelegramPairingTable.id, pairing.id),
          eq(TelegramPairingTable.connectionId, input.connectionId),
          eq(TelegramPairingTable.tokenHash, input.tokenHash),
          isNull(TelegramPairingTable.usedAt),
          gt(TelegramPairingTable.expiresAt, now),
        ))

      const consumedRows = await tx
        .select({ usedAt: TelegramPairingTable.usedAt })
        .from(TelegramPairingTable)
        .where(eq(TelegramPairingTable.id, pairing.id))
        .limit(1)
      if (consumedRows[0]?.usedAt?.getTime() !== now.getTime()) return false

      await tx.insert(TelegramChatBindingTable).values({
        id: bindingId,
        connectionId: input.connectionId,
        telegramChatId: input.chatId,
        telegramUserId: input.userId,
        telegramUsername: input.username,
        telegramFirstName: input.firstName,
      })
      return true
    })
    return current
      ? { paired: true }
      : { paired: false }
  } catch (error) {
    if (!isDuplicateDatabaseEntry(error)) throw error
    const binding = await getTelegramChatBinding(input.connectionId)
    return {
      paired: binding?.telegramChatId === input.chatId,
    }
  }
}

export async function claimTelegramUpdate(input: {
  connectionId: DenTypeId<"telegramConnection">
  payload: string
  updateId: string
}): Promise<{ claimed: boolean; id: DenTypeId<"telegramUpdate"> }> {
  const retentionCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000)
  await db
    .delete(TelegramUpdateTable)
    .where(and(
      eq(TelegramUpdateTable.connectionId, input.connectionId),
      inArray(TelegramUpdateTable.status, ["completed", "failed", "ignored"]),
      lt(TelegramUpdateTable.completedAt, retentionCutoff),
    ))

  const id = createDenTypeId("telegramUpdate")
  try {
    await db.insert(TelegramUpdateTable).values({
      id,
      connectionId: input.connectionId,
      updateId: input.updateId,
      payload: input.payload,
      status: "accepted",
    })
    return { claimed: true, id }
  } catch (error) {
    if (!isDuplicateDatabaseEntry(error)) throw error
    const rows = await db
      .select({ id: TelegramUpdateTable.id })
      .from(TelegramUpdateTable)
      .where(and(
        eq(TelegramUpdateTable.connectionId, input.connectionId),
        eq(TelegramUpdateTable.updateId, input.updateId),
      ))
      .limit(1)
    const existing = rows[0]
    if (!existing) throw error
    return { claimed: false, id: existing.id }
  }
}

const TELEGRAM_UPDATES_PER_MINUTE = 30
const TELEGRAM_MAX_BACKLOG = 20

export async function telegramUpdateIntakeAllowed(
  connectionId: DenTypeId<"telegramConnection">,
): Promise<boolean> {
  const oneMinuteAgo = new Date(Date.now() - 60_000)
  const [recentRows, backlogRows] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)` })
      .from(TelegramUpdateTable)
      .where(and(
        eq(TelegramUpdateTable.connectionId, connectionId),
        gt(TelegramUpdateTable.receivedAt, oneMinuteAgo),
      )),
    db
      .select({ count: sql<number>`count(*)` })
      .from(TelegramUpdateTable)
      .where(and(
        eq(TelegramUpdateTable.connectionId, connectionId),
        inArray(TelegramUpdateTable.status, ["accepted", "processing"]),
      )),
  ])
  return Number(recentRows[0]?.count ?? 0) < TELEGRAM_UPDATES_PER_MINUTE
    && Number(backlogRows[0]?.count ?? 0) < TELEGRAM_MAX_BACKLOG
}

const MAX_TELEGRAM_UPDATE_ATTEMPTS = 3
const STALE_TELEGRAM_PROCESSING_MS = 5 * 60 * 1_000
const TELEGRAM_RETRY_BASE_DELAY_MS = 1_000
const TELEGRAM_RETRY_MAX_DELAY_MS = 30_000

function dispatchableTelegramUpdate(now: Date) {
  const staleBefore = new Date(now.getTime() - STALE_TELEGRAM_PROCESSING_MS)
  return and(
    lt(TelegramUpdateTable.attempts, MAX_TELEGRAM_UPDATE_ATTEMPTS),
    or(
      and(
        eq(TelegramUpdateTable.status, "accepted"),
        or(
          isNull(TelegramUpdateTable.processingStartedAt),
          lte(TelegramUpdateTable.processingStartedAt, now),
        ),
      ),
      and(
        eq(TelegramUpdateTable.status, "processing"),
        or(
          isNull(TelegramUpdateTable.processingStartedAt),
          lt(TelegramUpdateTable.processingStartedAt, staleBefore),
        ),
      ),
    ),
  )
}

function staleTelegramProcessing(now: Date) {
  const staleBefore = new Date(now.getTime() - STALE_TELEGRAM_PROCESSING_MS)
  return or(
    isNull(TelegramUpdateTable.processingStartedAt),
    lt(TelegramUpdateTable.processingStartedAt, staleBefore),
  )
}

async function failExhaustedTelegramUpdates(now: Date) {
  const exhausted = await db
    .select({
      connectionId: TelegramUpdateTable.connectionId,
      id: TelegramUpdateTable.id,
      processingToken: TelegramUpdateTable.processingToken,
    })
    .from(TelegramUpdateTable)
    .where(and(
      eq(TelegramUpdateTable.status, "processing"),
      gte(TelegramUpdateTable.attempts, MAX_TELEGRAM_UPDATE_ATTEMPTS),
      staleTelegramProcessing(now),
    ))
    .limit(100)

  for (const update of exhausted) {
    const tokenCondition = update.processingToken
      ? eq(TelegramUpdateTable.processingToken, update.processingToken)
      : isNull(TelegramUpdateTable.processingToken)
    await db.transaction(async (tx) => {
      if (update.processingToken) {
        await tx
          .update(TelegramConnectionTable)
          .set({ dispatchToken: null, dispatchStartedAt: null })
          .where(and(
            eq(TelegramConnectionTable.id, update.connectionId),
            eq(TelegramConnectionTable.dispatchToken, update.processingToken),
          ))
      }
      await tx
        .update(TelegramUpdateTable)
        .set({
          status: "failed",
          error: "Telegram update exceeded the retry limit.",
          completedAt: now,
          processingToken: null,
          processingStartedAt: null,
        })
        .where(and(eq(TelegramUpdateTable.id, update.id), tokenCondition))
    })
  }
}

/** Atomically claims one accepted or stale-processing update across replicas. */
export async function claimNextTelegramUpdate(): Promise<TelegramUpdateRow | null> {
  const now = new Date()
  await failExhaustedTelegramUpdates(now)
  const candidates = await db
    .select({ id: TelegramUpdateTable.id, connectionId: TelegramUpdateTable.connectionId })
    .from(TelegramUpdateTable)
    .where(dispatchableTelegramUpdate(now))
    .orderBy(asc(TelegramUpdateTable.receivedAt))
    .limit(100)

  for (const candidate of candidates) {
    const processingToken = randomBytes(24).toString("hex")
    const staleLeaseBefore = new Date(now.getTime() - STALE_TELEGRAM_PROCESSING_MS)
    await db
      .update(TelegramConnectionTable)
      .set({ dispatchToken: processingToken, dispatchStartedAt: now })
      .where(and(
        eq(TelegramConnectionTable.id, candidate.connectionId),
        eq(TelegramConnectionTable.status, "active"),
        eq(TelegramConnectionTable.webhookRegistered, true),
        or(
          isNull(TelegramConnectionTable.dispatchToken),
          isNull(TelegramConnectionTable.dispatchStartedAt),
          lt(TelegramConnectionTable.dispatchStartedAt, staleLeaseBefore),
        ),
      ))

    const leased = await db
      .select({ id: TelegramConnectionTable.id })
      .from(TelegramConnectionTable)
      .where(and(
        eq(TelegramConnectionTable.id, candidate.connectionId),
        eq(TelegramConnectionTable.dispatchToken, processingToken),
      ))
      .limit(1)
    if (!leased[0]) continue

    await db
      .update(TelegramUpdateTable)
      .set({
        status: "processing",
        processingToken,
        processingStartedAt: now,
        attempts: sql`${TelegramUpdateTable.attempts} + 1`,
      })
      .where(and(
        eq(TelegramUpdateTable.id, candidate.id),
        dispatchableTelegramUpdate(now),
      ))

    const claimed = await db
      .select()
      .from(TelegramUpdateTable)
      .where(and(
        eq(TelegramUpdateTable.id, candidate.id),
        eq(TelegramUpdateTable.processingToken, processingToken),
      ))
      .limit(1)
    if (claimed[0]) return claimed[0]

    await db
      .update(TelegramConnectionTable)
      .set({ dispatchToken: null, dispatchStartedAt: null })
      .where(and(
        eq(TelegramConnectionTable.id, candidate.connectionId),
        eq(TelegramConnectionTable.dispatchToken, processingToken),
      ))
  }
  return null
}

export async function setTelegramUpdateStatus(input: {
  connectionId: DenTypeId<"telegramConnection">
  error?: string | null
  id: DenTypeId<"telegramUpdate">
  processingToken: string
  status: TelegramUpdateStatus
}) {
  const completed = input.status === "completed" || input.status === "failed" || input.status === "ignored"
  if (completed) {
    await db.transaction(async (tx) => {
      await tx
        .update(TelegramConnectionTable)
        .set({ dispatchToken: null, dispatchStartedAt: null })
        .where(and(
          eq(TelegramConnectionTable.id, input.connectionId),
          eq(TelegramConnectionTable.dispatchToken, input.processingToken),
        ))
      await tx
        .update(TelegramUpdateTable)
        .set({
          status: input.status,
          error: input.error?.slice(0, 2_000) ?? null,
          completedAt: new Date(),
          processingToken: null,
          processingStartedAt: null,
        })
        .where(and(
          eq(TelegramUpdateTable.id, input.id),
          eq(TelegramUpdateTable.processingToken, input.processingToken),
        ))
    })
    return
  }
  await db
    .update(TelegramUpdateTable)
    .set({
      status: input.status,
      error: input.error?.slice(0, 2_000) ?? null,
      completedAt: null,
    })
    .where(and(
      eq(TelegramUpdateTable.id, input.id),
      eq(TelegramUpdateTable.processingToken, input.processingToken),
    ))
}

export async function retryTelegramUpdate(input: {
  connectionId: DenTypeId<"telegramConnection">
  error: string
  id: DenTypeId<"telegramUpdate">
  processingToken: string
}): Promise<"failed" | "requeued" | "stale"> {
  return db.transaction(async (tx) => {
    const connections = await tx
      .select({ id: TelegramConnectionTable.id })
      .from(TelegramConnectionTable)
      .where(and(
        eq(TelegramConnectionTable.id, input.connectionId),
        eq(TelegramConnectionTable.dispatchToken, input.processingToken),
      ))
      .limit(1)
      .for("update")
    if (!connections[0]) return "stale"

    const updates = await tx
      .select({ attempts: TelegramUpdateTable.attempts })
      .from(TelegramUpdateTable)
      .where(and(
        eq(TelegramUpdateTable.id, input.id),
        eq(TelegramUpdateTable.connectionId, input.connectionId),
        eq(TelegramUpdateTable.status, "processing"),
        eq(TelegramUpdateTable.processingToken, input.processingToken),
      ))
      .limit(1)
      .for("update")
    const update = updates[0]
    if (!update) {
      await tx
        .update(TelegramConnectionTable)
        .set({ dispatchToken: null, dispatchStartedAt: null })
        .where(and(
          eq(TelegramConnectionTable.id, input.connectionId),
          eq(TelegramConnectionTable.dispatchToken, input.processingToken),
        ))
      return "stale"
    }

    const now = new Date()
    const exhausted = update.attempts >= MAX_TELEGRAM_UPDATE_ATTEMPTS
    const delay = Math.min(
      TELEGRAM_RETRY_BASE_DELAY_MS * (2 ** Math.max(0, update.attempts - 1)),
      TELEGRAM_RETRY_MAX_DELAY_MS,
    )
    await tx
      .update(TelegramUpdateTable)
      .set({
        status: exhausted ? "failed" : "accepted",
        error: input.error.slice(0, 2_000),
        completedAt: exhausted ? now : null,
        processingToken: null,
        processingStartedAt: exhausted ? null : new Date(now.getTime() + delay),
      })
      .where(and(
        eq(TelegramUpdateTable.id, input.id),
        eq(TelegramUpdateTable.processingToken, input.processingToken),
      ))
    await tx
      .update(TelegramConnectionTable)
      .set({ dispatchToken: null, dispatchStartedAt: null })
      .where(and(
        eq(TelegramConnectionTable.id, input.connectionId),
        eq(TelegramConnectionTable.dispatchToken, input.processingToken),
      ))
    return exhausted ? "failed" : "requeued"
  })
}

export async function saveTelegramWorkerSession(input: {
  bindingId: DenTypeId<"telegramChatBinding">
  connectionId: DenTypeId<"telegramConnection">
  dispatchToken: string
  generation: string
  sessionId: string
  workspaceId: string
}): Promise<boolean> {
  return db.transaction(async (tx) => {
    const connectionRows = await tx
      .select({ id: TelegramConnectionTable.id, webhookSecret: TelegramConnectionTable.webhookSecret })
      .from(TelegramConnectionTable)
      .where(and(
        eq(TelegramConnectionTable.id, input.connectionId),
        eq(TelegramConnectionTable.status, "active"),
        eq(TelegramConnectionTable.webhookRegistered, true),
        eq(TelegramConnectionTable.dispatchToken, input.dispatchToken),
      ))
      .limit(1)
      .for("update")
    if (connectionRows[0]?.webhookSecret !== input.generation) return false

    await tx
      .update(TelegramChatBindingTable)
      .set({ workerSessionId: input.sessionId, workerWorkspaceId: input.workspaceId })
      .where(and(
        eq(TelegramChatBindingTable.id, input.bindingId),
        eq(TelegramChatBindingTable.connectionId, input.connectionId),
      ))
    return true
  })
}
