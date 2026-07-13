import { createHash, randomBytes } from "node:crypto"
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, or, sql } from "@openwork-ee/den-db/drizzle"
import { MemberTable, WorkerTable } from "@openwork-ee/den-db/schema"
import {
  TagChannelTable,
  TagConnectionTable,
  TagEventTable,
  TagOAuthStateTable,
  TagRunTable,
  TagThreadTable,
} from "@openwork-ee/den-db/schema/tag"
import { createDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../db.js"
import { isDuplicateDatabaseEntry } from "./database-errors.js"
import { loadWorkerAccess } from "./worker-session.js"

export { isDuplicateDatabaseEntry }

export type TagConnectionRow = typeof TagConnectionTable.$inferSelect
export type TagChannelRow = typeof TagChannelTable.$inferSelect
export type TagEventRow = typeof TagEventTable.$inferSelect
export type TagOAuthStateRow = typeof TagOAuthStateTable.$inferSelect
export type TagThreadRow = typeof TagThreadTable.$inferSelect
export type TagRunRow = typeof TagRunTable.$inferSelect
export type TagEventStatus = NonNullable<typeof TagEventTable.$inferInsert.status>
export type TagRunStatus = NonNullable<typeof TagRunTable.$inferInsert.status>

export type TagConfigSnapshot = {
  allowGuests: boolean
  allowSharedChannels: boolean
  channelId: string
  channelName: string | null
  instructions: string
  serviceName: string
  version: 1
  workerId: DenTypeId<"worker">
}

function jsonStringArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : []
  } catch {
    return []
  }
}

export function serializeTagConfigSnapshot(snapshot: TagConfigSnapshot): { hash: string; value: string } {
  const value = JSON.stringify(snapshot)
  return { hash: createHash("sha256").update(value).digest("hex"), value }
}

export function parseTagConfigSnapshot(value: string): TagConfigSnapshot | null {
  try {
    const parsed: unknown = JSON.parse(value)
    if (
      typeof parsed !== "object" || parsed === null
      || !("version" in parsed) || parsed.version !== 1
      || !("workerId" in parsed) || typeof parsed.workerId !== "string"
      || !("channelId" in parsed) || typeof parsed.channelId !== "string"
      || !("channelName" in parsed) || (typeof parsed.channelName !== "string" && parsed.channelName !== null)
      || !("instructions" in parsed) || typeof parsed.instructions !== "string"
      || !("serviceName" in parsed) || typeof parsed.serviceName !== "string"
      || !("allowGuests" in parsed) || typeof parsed.allowGuests !== "boolean"
      || !("allowSharedChannels" in parsed) || typeof parsed.allowSharedChannels !== "boolean"
    ) return null
    return {
      allowGuests: parsed.allowGuests,
      allowSharedChannels: parsed.allowSharedChannels,
      channelId: parsed.channelId,
      channelName: parsed.channelName,
      instructions: parsed.instructions,
      serviceName: parsed.serviceName,
      version: 1,
      workerId: parsed.workerId as DenTypeId<"worker">,
    }
  } catch {
    return null
  }
}

export async function getTagConnectionByOrganization(
  organizationId: DenTypeId<"organization">,
): Promise<TagConnectionRow | null> {
  const rows = await db.select().from(TagConnectionTable)
    .where(eq(TagConnectionTable.organizationId, organizationId)).limit(1)
  return rows[0] ?? null
}

export async function getTagConnectionById(
  connectionId: DenTypeId<"tagConnection">,
): Promise<TagConnectionRow | null> {
  const rows = await db.select().from(TagConnectionTable)
    .where(eq(TagConnectionTable.id, connectionId)).limit(1)
  return rows[0] ?? null
}

export async function getTagOAuthConnectionBySlackTeam(slackTeamId: string): Promise<TagConnectionRow | null> {
  const rows = await db.select().from(TagConnectionTable).where(and(
    eq(TagConnectionTable.slackTeamId, slackTeamId),
    eq(TagConnectionTable.installSource, "oauth"),
  )).limit(1)
  return rows[0] ?? null
}

export async function getTagChannel(
  connectionId: DenTypeId<"tagConnection">,
  slackChannelId: string,
): Promise<TagChannelRow | null> {
  const rows = await db.select().from(TagChannelTable).where(and(
    eq(TagChannelTable.connectionId, connectionId),
    eq(TagChannelTable.slackChannelId, slackChannelId),
  )).limit(1)
  return rows[0] ?? null
}

export async function tagConnectionView(connection: TagConnectionRow) {
  const [workers, channels, workerAccess] = await Promise.all([
    db.select({ id: WorkerTable.id, name: WorkerTable.name, status: WorkerTable.status })
      .from(WorkerTable)
      .where(and(eq(WorkerTable.id, connection.workerId), eq(WorkerTable.org_id, connection.organizationId)))
      .limit(1),
    db.select().from(TagChannelTable)
      .where(eq(TagChannelTable.connectionId, connection.id))
      .orderBy(asc(TagChannelTable.slackChannelName), asc(TagChannelTable.slackChannelId)),
    loadWorkerAccess({ organizationId: connection.organizationId, workerId: connection.workerId }),
  ])
  const worker = workers[0]
  return {
    id: connection.id,
    status: connection.status,
    connected: connection.status === "active" && Boolean(workerAccess),
    slack: {
      teamId: connection.slackTeamId,
      teamName: connection.slackTeamName,
      botUserId: connection.botUserId,
      botName: connection.botName,
    },
    installation: {
      source: connection.installSource,
      appId: connection.slackAppId,
      enterpriseId: connection.slackEnterpriseId,
      enterpriseInstall: connection.isEnterpriseInstall,
      scopes: jsonStringArray(connection.oauthScopes ?? "[]"),
      tokenExpiresAt: connection.tokenExpiresAt?.toISOString() ?? null,
      tokenRefreshedAt: connection.tokenRefreshedAt?.toISOString() ?? null,
      revokedAt: connection.revokedAt?.toISOString() ?? null,
    },
    worker: {
      id: connection.workerId,
      name: worker?.name ?? "Unavailable worker",
      status: worker?.status ?? "missing",
    },
    policy: {
      serviceName: connection.serviceName,
      defaultInstructions: connection.defaultInstructions,
      allowedUserIds: jsonStringArray(connection.allowedUserIds),
      allowGuests: connection.allowGuests,
      allowSharedChannels: connection.allowSharedChannels,
      channels: channels.map((channel) => ({
        id: channel.slackChannelId,
        name: channel.slackChannelName,
        instructions: channel.instructions,
      })),
    },
    webhook: {
      lastReceivedAt: connection.lastWebhookAt?.toISOString() ?? null,
      lastError: connection.lastError,
    },
    createdAt: connection.createdAt.toISOString(),
    updatedAt: connection.updatedAt.toISOString(),
  }
}

export async function replaceTagConnection(input: {
  allowGuests: boolean
  allowSharedChannels: boolean
  allowedUserIds: string[]
  bot: { botUserId: string; teamId: string; teamName: string; userName: string }
  botToken: string
  channels: Array<{ id: string; instructions?: string | null; name: string | null }>
  connectionId: DenTypeId<"tagConnection">
  createdByOrgMembershipId: DenTypeId<"member">
  defaultInstructions: string
  organizationId: DenTypeId<"organization">
  serviceName: string
  signingSecret: string
  installation?: {
    appId?: string | null
    enterpriseId?: string | null
    isEnterpriseInstall?: boolean
    refreshToken?: string | null
    scopes?: string[]
    source: "manual" | "oauth"
    tokenExpiresAt?: Date | null
  }
  workerId: DenTypeId<"worker">
}) {
  const existing = await getTagConnectionByOrganization(input.organizationId)
  const id = existing?.id ?? input.connectionId
  const values = {
    organizationId: input.organizationId,
    workerId: input.workerId,
    createdByOrgMembershipId: input.createdByOrgMembershipId,
    botToken: input.botToken,
    signingSecret: input.signingSecret,
    installSource: input.installation?.source ?? "manual",
    slackAppId: input.installation?.appId ?? null,
    slackEnterpriseId: input.installation?.enterpriseId ?? null,
    isEnterpriseInstall: input.installation?.isEnterpriseInstall ?? false,
    oauthScopes: input.installation?.scopes ? JSON.stringify([...new Set(input.installation.scopes)].sort()) : null,
    refreshToken: input.installation?.refreshToken ?? null,
    tokenExpiresAt: input.installation?.tokenExpiresAt ?? null,
    tokenRefreshedAt: input.installation?.source === "oauth" ? new Date() : null,
    tokenRefreshLease: null,
    tokenRefreshStartedAt: null,
    revokedAt: null,
    slackTeamId: input.bot.teamId,
    slackTeamName: input.bot.teamName,
    botUserId: input.bot.botUserId,
    botName: input.bot.userName,
    serviceName: input.serviceName,
    defaultInstructions: input.defaultInstructions,
    allowedUserIds: JSON.stringify([...new Set(input.allowedUserIds)].sort()),
    allowGuests: input.allowGuests,
    allowSharedChannels: input.allowSharedChannels,
    status: "active",
    dispatchToken: null,
    dispatchStartedAt: null,
    lastError: null,
  } satisfies Omit<typeof TagConnectionTable.$inferInsert, "id">

  await db.transaction(async (tx) => {
    if (existing) {
      await tx.update(TagConnectionTable).set(values).where(eq(TagConnectionTable.id, existing.id))
      await tx.delete(TagChannelTable).where(eq(TagChannelTable.connectionId, existing.id))
    } else {
      await tx.insert(TagConnectionTable).values({ id, ...values })
    }
    if (input.channels.length > 0) {
      await tx.insert(TagChannelTable).values(input.channels.map((channel) => ({
        id: createDenTypeId("tagChannel"),
        connectionId: id,
        slackChannelId: channel.id,
        slackChannelName: channel.name,
        instructions: channel.instructions?.trim() || null,
      })))
    }
  })
  const connection = await getTagConnectionById(id)
  if (!connection) throw new Error("OpenWork Tag connection was not persisted.")
  return connection
}

export async function updateTagConnectionPolicy(input: {
  allowGuests: boolean
  allowSharedChannels: boolean
  allowedUserIds: string[]
  channels: Array<{ id: string; instructions?: string | null; name: string | null }>
  connectionId: DenTypeId<"tagConnection">
  defaultInstructions: string
  serviceName: string
  workerId: DenTypeId<"worker">
}) {
  await db.transaction(async (tx) => {
    await tx.update(TagConnectionTable).set({
      workerId: input.workerId,
      serviceName: input.serviceName,
      defaultInstructions: input.defaultInstructions,
      allowedUserIds: JSON.stringify([...new Set(input.allowedUserIds)].sort()),
      allowGuests: input.allowGuests,
      allowSharedChannels: input.allowSharedChannels,
      lastError: null,
    }).where(eq(TagConnectionTable.id, input.connectionId))
    await tx.delete(TagChannelTable).where(eq(TagChannelTable.connectionId, input.connectionId))
    await tx.insert(TagChannelTable).values(input.channels.map((channel) => ({
      id: createDenTypeId("tagChannel"),
      connectionId: input.connectionId,
      slackChannelId: channel.id,
      slackChannelName: channel.name,
      instructions: channel.instructions?.trim() || null,
    })))
  })
  const connection = await getTagConnectionById(input.connectionId)
  if (!connection) throw new Error("OpenWork Tag connection was not persisted.")
  return connection
}

function oauthStateHash(state: string): string {
  return createHash("sha256").update(state).digest("hex")
}

export async function saveTagOAuthState(input: {
  organizationId: DenTypeId<"organization">
  orgMembershipId: DenTypeId<"member">
  payload: string
  state: string
  ttlSeconds?: number
}) {
  const now = new Date()
  await db.delete(TagOAuthStateTable).where(lt(TagOAuthStateTable.expiresAt, now))
  await db.insert(TagOAuthStateTable).values({
    id: createDenTypeId("tagOAuthState"),
    organizationId: input.organizationId,
    orgMembershipId: input.orgMembershipId,
    stateHash: oauthStateHash(input.state),
    payload: input.payload,
    expiresAt: new Date(now.getTime() + (input.ttlSeconds ?? 10 * 60) * 1_000),
  })
}

/** Atomically consumes OAuth setup state so a callback code can only be used once. */
export async function consumeTagOAuthState(input: {
  organizationId: DenTypeId<"organization">
  orgMembershipId: DenTypeId<"member">
  state: string
}): Promise<TagOAuthStateRow | null> {
  return db.transaction(async (tx) => {
    const now = new Date()
    const rows = await tx.select().from(TagOAuthStateTable).where(and(
      eq(TagOAuthStateTable.organizationId, input.organizationId),
      eq(TagOAuthStateTable.orgMembershipId, input.orgMembershipId),
      eq(TagOAuthStateTable.stateHash, oauthStateHash(input.state)),
      isNull(TagOAuthStateTable.consumedAt),
      gt(TagOAuthStateTable.expiresAt, now),
    )).limit(1).for("update")
    const row = rows[0]
    if (!row) return null
    await tx.update(TagOAuthStateTable).set({ consumedAt: now }).where(and(
      eq(TagOAuthStateTable.id, row.id),
      isNull(TagOAuthStateTable.consumedAt),
    ))
    return row
  })
}

export async function getActiveTagOAuthMember(input: {
  organizationId: DenTypeId<"organization">
  orgMembershipId: DenTypeId<"member">
}) {
  const rows = await db.select({
    role: MemberTable.role,
    userId: MemberTable.userId,
  }).from(MemberTable).where(and(
    eq(MemberTable.id, input.orgMembershipId),
    eq(MemberTable.organizationId, input.organizationId),
    isNull(MemberTable.removedAt),
  )).limit(1)
  return rows[0] ?? null
}

const TOKEN_REFRESH_LEASE_MS = 30_000

export async function claimTagTokenRefresh(connectionId: DenTypeId<"tagConnection">): Promise<{
  connection: TagConnectionRow
  lease: string
} | null> {
  const now = new Date()
  const lease = randomBytes(24).toString("hex")
  await db.update(TagConnectionTable).set({
    tokenRefreshLease: lease,
    tokenRefreshStartedAt: now,
  }).where(and(
    eq(TagConnectionTable.id, connectionId),
    eq(TagConnectionTable.status, "active"),
    eq(TagConnectionTable.installSource, "oauth"),
    or(
      isNull(TagConnectionTable.tokenRefreshLease),
      isNull(TagConnectionTable.tokenRefreshStartedAt),
      lt(TagConnectionTable.tokenRefreshStartedAt, new Date(now.getTime() - TOKEN_REFRESH_LEASE_MS)),
    ),
  ))
  const rows = await db.select().from(TagConnectionTable).where(and(
    eq(TagConnectionTable.id, connectionId),
    eq(TagConnectionTable.tokenRefreshLease, lease),
  )).limit(1)
  return rows[0] ? { connection: rows[0], lease } : null
}

export async function completeTagTokenRefresh(input: {
  accessToken: string
  connectionId: DenTypeId<"tagConnection">
  expiresAt: Date
  lease: string
  refreshToken: string
  scopes: string[]
}): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx.select({ id: TagConnectionTable.id }).from(TagConnectionTable).where(and(
      eq(TagConnectionTable.id, input.connectionId),
      eq(TagConnectionTable.tokenRefreshLease, input.lease),
    )).limit(1).for("update")
    if (!rows[0]) return false
    await tx.update(TagConnectionTable).set({
      botToken: input.accessToken,
      refreshToken: input.refreshToken,
      tokenExpiresAt: input.expiresAt,
      tokenRefreshedAt: new Date(),
      oauthScopes: JSON.stringify([...new Set(input.scopes)].sort()),
      tokenRefreshLease: null,
      tokenRefreshStartedAt: null,
      lastError: null,
    }).where(and(
      eq(TagConnectionTable.id, input.connectionId),
      eq(TagConnectionTable.tokenRefreshLease, input.lease),
    ))
    return true
  })
}

export async function failTagTokenRefresh(input: {
  connectionId: DenTypeId<"tagConnection">
  error: string
  expired: boolean
  lease: string
}) {
  await db.update(TagConnectionTable).set({
    status: input.expired ? "error" : "active",
    lastError: input.error.slice(0, 2_000),
    tokenRefreshLease: null,
    tokenRefreshStartedAt: null,
  }).where(and(
    eq(TagConnectionTable.id, input.connectionId),
    eq(TagConnectionTable.tokenRefreshLease, input.lease),
  ))
}

export async function markTagConnectionRevoked(input: {
  connectionId: DenTypeId<"tagConnection">
  reason: string
}) {
  return db.transaction(async (tx) => {
    const now = new Date()
    const threads = await tx.select({
      configSnapshot: TagThreadTable.configSnapshot,
      id: TagThreadTable.id,
      workerSessionId: TagThreadTable.workerSessionId,
      workerWorkspaceId: TagThreadTable.workerWorkspaceId,
    }).from(TagThreadTable).where(and(
      eq(TagThreadTable.connectionId, input.connectionId),
      eq(TagThreadTable.status, "active"),
    ))
    const threadIds = threads.map((thread) => thread.id)
    if (threadIds.length > 0) {
      await tx.update(TagThreadTable).set({ status: "cancelled", lastMessageAt: now })
        .where(inArray(TagThreadTable.id, threadIds))
      await tx.update(TagRunTable).set({ status: "cancelled", completedAt: now })
        .where(and(
          inArray(TagRunTable.threadId, threadIds),
          inArray(TagRunTable.status, ["accepted", "running"]),
        ))
    }
    await tx.update(TagConnectionTable).set({
      status: "error",
      botToken: "revoked",
      refreshToken: null,
      tokenExpiresAt: null,
      tokenRefreshLease: null,
      tokenRefreshStartedAt: null,
      revokedAt: now,
      lastError: input.reason.slice(0, 2_000),
      dispatchToken: null,
      dispatchStartedAt: null,
    }).where(eq(TagConnectionTable.id, input.connectionId))
    return threads
  })
}

export async function deleteTagConnection(connectionId: DenTypeId<"tagConnection">) {
  await db.transaction(async (tx) => {
    const connections = await tx.select({ organizationId: TagConnectionTable.organizationId })
      .from(TagConnectionTable).where(eq(TagConnectionTable.id, connectionId)).limit(1)
    const threads = await tx.select({ id: TagThreadTable.id }).from(TagThreadTable)
      .where(eq(TagThreadTable.connectionId, connectionId))
    const threadIds = threads.map((thread) => thread.id)
    if (threadIds.length > 0) await tx.delete(TagRunTable).where(inArray(TagRunTable.threadId, threadIds))
    await tx.delete(TagThreadTable).where(eq(TagThreadTable.connectionId, connectionId))
    await tx.delete(TagEventTable).where(eq(TagEventTable.connectionId, connectionId))
    await tx.delete(TagChannelTable).where(eq(TagChannelTable.connectionId, connectionId))
    if (connections[0]) {
      await tx.delete(TagOAuthStateTable).where(eq(TagOAuthStateTable.organizationId, connections[0].organizationId))
    }
    await tx.delete(TagConnectionTable).where(eq(TagConnectionTable.id, connectionId))
  })
}

export async function noteTagWebhookReceived(connectionId: DenTypeId<"tagConnection">) {
  await db.update(TagConnectionTable).set({ lastWebhookAt: new Date() })
    .where(eq(TagConnectionTable.id, connectionId))
}

export async function claimTagEvent(input: {
  connectionId: DenTypeId<"tagConnection">
  payload: string
  slackEventId: string
}): Promise<{ claimed: boolean; id: DenTypeId<"tagEvent"> }> {
  const retentionCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000)
  await db.delete(TagEventTable).where(and(
    eq(TagEventTable.connectionId, input.connectionId),
    inArray(TagEventTable.status, ["completed", "failed", "ignored"]),
    lt(TagEventTable.completedAt, retentionCutoff),
  ))
  const id = createDenTypeId("tagEvent")
  try {
    await db.insert(TagEventTable).values({
      id,
      connectionId: input.connectionId,
      slackEventId: input.slackEventId,
      payload: input.payload,
      status: "accepted",
    })
    return { claimed: true, id }
  } catch (error) {
    if (!isDuplicateDatabaseEntry(error)) throw error
    const rows = await db.select({ id: TagEventTable.id }).from(TagEventTable).where(and(
      eq(TagEventTable.connectionId, input.connectionId),
      eq(TagEventTable.slackEventId, input.slackEventId),
    )).limit(1)
    if (!rows[0]) throw error
    return { claimed: false, id: rows[0].id }
  }
}

/** Claims a control command without waiting behind a long-running thread lane. */
export async function claimTagControlEvent(input: {
  connectionId: DenTypeId<"tagConnection">
  id: DenTypeId<"tagEvent">
}): Promise<TagEventRow | null> {
  const processingToken = `control_${randomBytes(20).toString("hex")}`
  await db.update(TagEventTable).set({
    status: "processing",
    processingToken,
    processingStartedAt: new Date(),
    attempts: sql`${TagEventTable.attempts} + 1`,
  }).where(and(
    eq(TagEventTable.id, input.id),
    eq(TagEventTable.connectionId, input.connectionId),
    eq(TagEventTable.status, "accepted"),
    isNull(TagEventTable.processingToken),
  ))
  const rows = await db.select().from(TagEventTable).where(and(
    eq(TagEventTable.id, input.id),
    eq(TagEventTable.connectionId, input.connectionId),
    eq(TagEventTable.processingToken, processingToken),
  )).limit(1)
  return rows[0] ?? null
}

export async function tagEventIntakeAllowed(connectionId: DenTypeId<"tagConnection">): Promise<boolean> {
  const oneMinuteAgo = new Date(Date.now() - 60_000)
  const [recent, backlog] = await Promise.all([
    db.select({ count: sql<number>`count(*)` }).from(TagEventTable).where(and(
      eq(TagEventTable.connectionId, connectionId), gt(TagEventTable.receivedAt, oneMinuteAgo),
    )),
    db.select({ count: sql<number>`count(*)` }).from(TagEventTable).where(and(
      eq(TagEventTable.connectionId, connectionId), inArray(TagEventTable.status, ["accepted", "processing"]),
    )),
  ])
  return Number(recent[0]?.count ?? 0) < 60 && Number(backlog[0]?.count ?? 0) < 50
}

const MAX_ATTEMPTS = 3
const STALE_PROCESSING_MS = 5 * 60 * 1_000

function dispatchableTagEvent(now: Date) {
  const staleBefore = new Date(now.getTime() - STALE_PROCESSING_MS)
  return and(
    lt(TagEventTable.attempts, MAX_ATTEMPTS),
    or(
      and(eq(TagEventTable.status, "accepted"), or(
        isNull(TagEventTable.processingStartedAt), lte(TagEventTable.processingStartedAt, now),
      )),
      and(eq(TagEventTable.status, "processing"), or(
        isNull(TagEventTable.processingStartedAt), lt(TagEventTable.processingStartedAt, staleBefore),
      )),
    ),
  )
}

async function failExhaustedTagEvents(now: Date) {
  const staleBefore = new Date(now.getTime() - STALE_PROCESSING_MS)
  const exhausted = await db.select({
    connectionId: TagEventTable.connectionId,
    id: TagEventTable.id,
    processingToken: TagEventTable.processingToken,
  }).from(TagEventTable).where(and(
    eq(TagEventTable.status, "processing"),
    gte(TagEventTable.attempts, MAX_ATTEMPTS),
    or(isNull(TagEventTable.processingStartedAt), lt(TagEventTable.processingStartedAt, staleBefore)),
  )).limit(100)
  for (const event of exhausted) {
    await db.transaction(async (tx) => {
      if (event.processingToken) {
        await tx.update(TagConnectionTable).set({ dispatchToken: null, dispatchStartedAt: null }).where(and(
          eq(TagConnectionTable.id, event.connectionId),
          eq(TagConnectionTable.dispatchToken, event.processingToken),
        ))
      }
      await tx.update(TagEventTable).set({
        status: "failed",
        error: "Slack event exceeded the retry limit.",
        completedAt: now,
        processingToken: null,
        processingStartedAt: null,
      }).where(eq(TagEventTable.id, event.id))
    })
  }
}

/** Atomically leases one event and one per-connection lane across Den replicas. */
export async function claimNextTagEvent(): Promise<TagEventRow | null> {
  const now = new Date()
  await failExhaustedTagEvents(now)
  const candidates = await db.select({ id: TagEventTable.id, connectionId: TagEventTable.connectionId })
    .from(TagEventTable).where(dispatchableTagEvent(now)).orderBy(asc(TagEventTable.receivedAt)).limit(100)
  for (const candidate of candidates) {
    const processingToken = randomBytes(24).toString("hex")
    const staleLeaseBefore = new Date(now.getTime() - STALE_PROCESSING_MS)
    await db.update(TagConnectionTable).set({ dispatchToken: processingToken, dispatchStartedAt: now }).where(and(
      eq(TagConnectionTable.id, candidate.connectionId),
      eq(TagConnectionTable.status, "active"),
      or(
        isNull(TagConnectionTable.dispatchToken),
        isNull(TagConnectionTable.dispatchStartedAt),
        lt(TagConnectionTable.dispatchStartedAt, staleLeaseBefore),
      ),
    ))
    const leased = await db.select({ id: TagConnectionTable.id }).from(TagConnectionTable).where(and(
      eq(TagConnectionTable.id, candidate.connectionId),
      eq(TagConnectionTable.dispatchToken, processingToken),
    )).limit(1)
    if (!leased[0]) continue
    await db.update(TagEventTable).set({
      status: "processing",
      processingToken,
      processingStartedAt: now,
      attempts: sql`${TagEventTable.attempts} + 1`,
    }).where(and(eq(TagEventTable.id, candidate.id), dispatchableTagEvent(now)))
    const claimed = await db.select().from(TagEventTable).where(and(
      eq(TagEventTable.id, candidate.id), eq(TagEventTable.processingToken, processingToken),
    )).limit(1)
    if (claimed[0]) return claimed[0]
    await db.update(TagConnectionTable).set({ dispatchToken: null, dispatchStartedAt: null }).where(and(
      eq(TagConnectionTable.id, candidate.connectionId),
      eq(TagConnectionTable.dispatchToken, processingToken),
    ))
  }
  return null
}

export async function setTagEventStatus(input: {
  connectionId: DenTypeId<"tagConnection">
  error?: string | null
  id: DenTypeId<"tagEvent">
  processingToken: string
  status: TagEventStatus
}) {
  const completed = ["completed", "failed", "ignored"].includes(input.status)
  await db.transaction(async (tx) => {
    if (completed) {
      await tx.update(TagConnectionTable).set({ dispatchToken: null, dispatchStartedAt: null }).where(and(
        eq(TagConnectionTable.id, input.connectionId),
        eq(TagConnectionTable.dispatchToken, input.processingToken),
      ))
    }
    await tx.update(TagEventTable).set({
      status: input.status,
      error: input.error?.slice(0, 2_000) ?? null,
      completedAt: completed ? new Date() : null,
      ...(completed ? { processingToken: null, processingStartedAt: null } : {}),
    }).where(and(eq(TagEventTable.id, input.id), eq(TagEventTable.processingToken, input.processingToken)))
  })
}

export async function retryTagEvent(input: {
  connectionId: DenTypeId<"tagConnection">
  error: string
  id: DenTypeId<"tagEvent">
  processingToken: string
}) {
  await db.transaction(async (tx) => {
    const rows = await tx.select({ attempts: TagEventTable.attempts }).from(TagEventTable).where(and(
      eq(TagEventTable.id, input.id),
      eq(TagEventTable.processingToken, input.processingToken),
      eq(TagEventTable.status, "processing"),
    )).limit(1).for("update")
    const attempts = rows[0]?.attempts ?? MAX_ATTEMPTS
    const failed = attempts >= MAX_ATTEMPTS
    const now = new Date()
    const delayMs = Math.min(1_000 * (2 ** Math.max(0, attempts - 1)), 30_000)
    await tx.update(TagEventTable).set({
      status: failed ? "failed" : "accepted",
      error: input.error.slice(0, 2_000),
      completedAt: failed ? now : null,
      processingToken: null,
      processingStartedAt: failed ? null : new Date(now.getTime() + delayMs),
    }).where(and(eq(TagEventTable.id, input.id), eq(TagEventTable.processingToken, input.processingToken)))
    await tx.update(TagConnectionTable).set({ dispatchToken: null, dispatchStartedAt: null }).where(and(
      eq(TagConnectionTable.id, input.connectionId),
      eq(TagConnectionTable.dispatchToken, input.processingToken),
    ))
  })
}

export async function findTagThread(input: {
  channelId: string
  connectionId: DenTypeId<"tagConnection">
  threadTs: string
}): Promise<TagThreadRow | null> {
  const rows = await db.select().from(TagThreadTable).where(and(
    eq(TagThreadTable.connectionId, input.connectionId),
    eq(TagThreadTable.slackChannelId, input.channelId),
    eq(TagThreadTable.slackThreadTs, input.threadTs),
  )).limit(1)
  return rows[0] ?? null
}

export async function getTagThreadById(threadId: DenTypeId<"tagThread">): Promise<TagThreadRow | null> {
  const rows = await db.select().from(TagThreadTable).where(eq(TagThreadTable.id, threadId)).limit(1)
  return rows[0] ?? null
}

export async function getOrCreateTagThread(input: {
  connectionId: DenTypeId<"tagConnection">
  enterpriseId: string | null
  slackChannelId: string
  slackTeamId: string
  slackThreadTs: string
  snapshot: TagConfigSnapshot
  startedBySlackUserId: string
}): Promise<TagThreadRow> {
  const existing = await findTagThread({
    channelId: input.slackChannelId,
    connectionId: input.connectionId,
    threadTs: input.slackThreadTs,
  })
  if (existing) return existing
  const serialized = serializeTagConfigSnapshot(input.snapshot)
  const id = createDenTypeId("tagThread")
  try {
    await db.insert(TagThreadTable).values({
      id,
      connectionId: input.connectionId,
      enterpriseId: input.enterpriseId,
      slackTeamId: input.slackTeamId,
      slackChannelId: input.slackChannelId,
      slackThreadTs: input.slackThreadTs,
      startedBySlackUserId: input.startedBySlackUserId,
      configSnapshot: serialized.value,
      configSnapshotHash: serialized.hash,
      status: "active",
    })
  } catch (error) {
    if (!isDuplicateDatabaseEntry(error)) throw error
  }
  const created = await findTagThread({
    channelId: input.slackChannelId,
    connectionId: input.connectionId,
    threadTs: input.slackThreadTs,
  })
  if (!created) throw new Error("OpenWork Tag thread was not persisted.")
  return created
}

export async function saveTagWorkerSession(input: {
  connectionId: DenTypeId<"tagConnection">
  dispatchToken: string
  generation: string
  sessionId: string
  threadId: DenTypeId<"tagThread">
  workspaceId: string
}): Promise<boolean> {
  return db.transaction(async (tx) => {
    const connections = await tx.select({ signingSecret: TagConnectionTable.signingSecret })
      .from(TagConnectionTable).where(and(
        eq(TagConnectionTable.id, input.connectionId),
        eq(TagConnectionTable.status, "active"),
        eq(TagConnectionTable.dispatchToken, input.dispatchToken),
      )).limit(1).for("update")
    if (connections[0]?.signingSecret !== input.generation) return false
    await tx.update(TagThreadTable).set({
      workerSessionId: input.sessionId,
      workerWorkspaceId: input.workspaceId,
      lastMessageAt: new Date(),
    }).where(and(eq(TagThreadTable.id, input.threadId), eq(TagThreadTable.connectionId, input.connectionId)))
    return true
  })
}

export async function createTagRun(input: {
  eventId: DenTypeId<"tagEvent">
  prompt: string
  slackUserId: string
  threadId: DenTypeId<"tagThread">
}): Promise<TagRunRow> {
  const existing = await db.select().from(TagRunTable).where(eq(TagRunTable.eventId, input.eventId)).limit(1)
  if (existing[0]) return existing[0]
  const id = createDenTypeId("tagRun")
  try {
    await db.insert(TagRunTable).values({ id, ...input, status: "accepted" })
  } catch (error) {
    if (!isDuplicateDatabaseEntry(error)) throw error
  }
  const rows = await db.select().from(TagRunTable).where(eq(TagRunTable.eventId, input.eventId)).limit(1)
  if (!rows[0]) throw new Error("OpenWork Tag run was not persisted.")
  return rows[0]
}

export async function updateTagRun(input: {
  error?: string | null
  id: DenTypeId<"tagRun">
  response?: string | null
  slackStatusMessageTs?: string | null
  status: TagRunStatus
}) {
  const terminal = ["completed", "failed", "cancelled"].includes(input.status)
  await db.update(TagRunTable).set({
    status: input.status,
    error: input.error?.slice(0, 2_000) ?? null,
    response: input.response ?? undefined,
    slackStatusMessageTs: input.slackStatusMessageTs ?? undefined,
    startedAt: input.status === "running" ? new Date() : undefined,
    completedAt: terminal ? new Date() : null,
  }).where(eq(TagRunTable.id, input.id))
}

export async function latestTagRunForThread(threadId: DenTypeId<"tagThread">): Promise<TagRunRow | null> {
  const rows = await db.select().from(TagRunTable).where(eq(TagRunTable.threadId, threadId))
    .orderBy(desc(TagRunTable.createdAt)).limit(1)
  return rows[0] ?? null
}

export async function cancelTagThread(threadId: DenTypeId<"tagThread">) {
  await db.update(TagThreadTable).set({ status: "cancelled", lastMessageAt: new Date() })
    .where(eq(TagThreadTable.id, threadId))
}

export async function listTagRuns(organizationId: DenTypeId<"organization">) {
  const connection = await getTagConnectionByOrganization(organizationId)
  if (!connection) return []
  return db.select({
    id: TagRunTable.id,
    status: TagRunTable.status,
    slackUserId: TagRunTable.slackUserId,
    prompt: TagRunTable.prompt,
    response: TagRunTable.response,
    error: TagRunTable.error,
    createdAt: TagRunTable.createdAt,
    completedAt: TagRunTable.completedAt,
    channelId: TagThreadTable.slackChannelId,
    threadTs: TagThreadTable.slackThreadTs,
    sessionId: TagThreadTable.workerSessionId,
    workspaceId: TagThreadTable.workerWorkspaceId,
    snapshotHash: TagThreadTable.configSnapshotHash,
  }).from(TagRunTable).innerJoin(TagThreadTable, eq(TagRunTable.threadId, TagThreadTable.id))
    .where(eq(TagThreadTable.connectionId, connection.id))
    .orderBy(desc(TagRunTable.createdAt)).limit(25)
}
