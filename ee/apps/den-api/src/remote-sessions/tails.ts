import { and, eq, gt, inArray, lte } from "@openwork-ee/den-db/drizzle"
import { RemoteSessionTailTable } from "@openwork-ee/den-db/schema/remote-session-commands"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import {
  remoteSessionReadResultSchema,
  type RemoteSessionReadResult,
  type RemoteSessionTranscriptMessage,
} from "@openwork/types/automations"
import Redis from "ioredis"
import { db } from "../db.js"
import { env } from "../env.js"
import { appLogger } from "../observability/logger.js"
import { signalRemoteSessionUserUpdate } from "./work-signal.js"

export const REMOTE_SESSION_TAIL_TTL_MS = 24 * 60 * 60_000
export const REMOTE_SESSION_TAIL_MAX_MESSAGES = 20
export const REMOTE_SESSION_TAIL_MAX_BYTES = 32 * 1024
export const REMOTE_SESSION_TAIL_SWEEP_INTERVAL_MS = 15 * 60_000
export const REMOTE_SESSION_TAIL_SWEEP_BATCH = 500
const REMOTE_SESSION_TAIL_REDIS_TTL_SECONDS = 300
const REMOTE_SESSION_TAIL_REDIS_PREFIX = "cache:remote-session:tail:"

export type StoredRemoteSessionTail = {
  threadKey: string
  payload: RemoteSessionReadResult
  byteSize: number
  updatedAt: number
  expiresAt: number
}

const encoder = new TextEncoder()

let tailRedisClient: Redis | null | undefined

function getTailRedis(): Redis | null {
  if (tailRedisClient !== undefined) return tailRedisClient
  if (!env.databaseRedisUrl) {
    tailRedisClient = null
    return null
  }
  const client = new Redis(env.databaseRedisUrl, { maxRetriesPerRequest: 2, enableOfflineQueue: false })
  client.on("error", (error) => {
    appLogger.warn("remote_session_tail_redis_error", { component: "remote_session_tail", error: error.message })
  })
  tailRedisClient = client
  return client
}

function redisCacheKey(organizationId: string, userId: string, threadKey: string): string {
  return `${REMOTE_SESSION_TAIL_REDIS_PREFIX}${organizationId}:${userId}:${threadKey}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function truncateText(value: string, maxChars: number | null): string {
  if (maxChars === null || value.length <= maxChars) return value
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`
}

function compactMessage(
  message: RemoteSessionTranscriptMessage,
  maxText: number | null,
  maxToolField: number,
  maxParts: number,
): RemoteSessionTranscriptMessage {
  const parts = message.parts?.slice(-maxParts).map((part) => {
    if (part.type === "text") return { ...part, text: truncateText(part.text, maxText) }
    if (part.type === "reasoning") return { ...part, text: truncateText(part.text, maxText === null ? 1600 : Math.min(400, maxText)) }
    return {
      ...part,
      input: part.input === null ? null : truncateText(part.input, maxToolField),
      output: part.output === null ? null : truncateText(part.output, maxToolField),
      error: part.error === null ? null : truncateText(part.error, maxToolField),
    }
  })
  const toolCalls = message.toolCalls.slice(-maxParts).map((call) => ({
    ...call,
    input: call.input === null ? null : truncateText(call.input, maxToolField),
    output: call.output === null ? null : truncateText(call.output, maxToolField),
    error: call.error === null ? null : truncateText(call.error, maxToolField),
  }))
  return {
    ...message,
    text: truncateText(message.text, maxText),
    toolCalls,
    ...(parts ? { parts } : {}),
  }
}

export function boundRemoteSessionTailPayload(
  page: RemoteSessionReadResult,
  options: { maxMessages?: number; maxBytes?: number } = {},
): { serialized: string; byteSize: number; payload: RemoteSessionReadResult } {
  const maxMessages = options.maxMessages ?? REMOTE_SESSION_TAIL_MAX_MESSAGES
  const maxBytes = options.maxBytes ?? REMOTE_SESSION_TAIL_MAX_BYTES
  const rawMessages = page.messages.slice(-maxMessages)
  const tiers: Array<[number | null, number, number]> = [
    [null, 1200, 40],
    [8000, 400, 24],
    [3200, 300, 16],
    [1600, 200, 12],
    [800, 120, 12],
    [400, 80, 12],
    [200, 80, 12],
  ]
  for (const [maxText, maxTool, maxParts] of tiers) {
    const compacted = rawMessages.map((message) => compactMessage(message, maxText, maxTool, maxParts))
    for (let keep = compacted.length; keep >= 1; keep -= 1) {
      const candidate: RemoteSessionReadResult = {
        ...page,
        messages: compacted.slice(-keep),
      }
      const serialized = JSON.stringify(candidate)
      const byteSize = encoder.encode(serialized).byteLength
      if (byteSize <= maxBytes) {
        return { serialized, byteSize, payload: candidate }
      }
    }
  }
  const minimal: RemoteSessionReadResult = {
    ...page,
    messages: [],
    pending: page.pending ?? null,
    pendingItems: page.pendingItems?.slice(0, 1),
  }
  const serialized = JSON.stringify(minimal)
  return { serialized, byteSize: encoder.encode(serialized).byteLength, payload: minimal }
}

function parseTailPayload(raw: string): RemoteSessionReadResult | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    const validated = remoteSessionReadResultSchema.safeParse(parsed)
    return validated.success ? validated.data : null
  } catch {
    return null
  }
}

export async function saveRemoteSessionTail(input: {
  organizationId: string
  createdByUserId: string
  threadKey: string
  ownerMemberId?: string | null
  commandId?: string | null
  runnerId?: string | null
  page: RemoteSessionReadResult
  now?: number
}): Promise<StoredRemoteSessionTail> {
  const now = input.now ?? Date.now()
  const orgId = normalizeDenTypeId("organization", input.organizationId)
  const userId = normalizeDenTypeId("user", input.createdByUserId)
  const ownerMemberId = input.ownerMemberId ? normalizeDenTypeId("member", input.ownerMemberId) : null
  const commandId = input.commandId ? normalizeDenTypeId("remoteSessionCommand", input.commandId) : null
  const expiresAt = now + REMOTE_SESSION_TAIL_TTL_MS
  const bounded = boundRemoteSessionTailPayload(input.page)
  const nowDate = new Date(now)
  const expiresDate = new Date(expiresAt)

  await db.insert(RemoteSessionTailTable).values({
    org_id: orgId,
    created_by_user_id: userId,
    thread_key: input.threadKey,
    owner_member_id: ownerMemberId,
    command_id: commandId,
    runner_id: input.runnerId ?? null,
    payload: bounded.serialized,
    byte_size: bounded.byteSize,
    expires_at: expiresDate,
    created_at: nowDate,
    updated_at: nowDate,
  }).onDuplicateKeyUpdate({
    set: {
      owner_member_id: ownerMemberId,
      command_id: commandId,
      runner_id: input.runnerId ?? null,
      payload: bounded.serialized,
      byte_size: bounded.byteSize,
      expires_at: expiresDate,
      updated_at: nowDate,
    },
  })

  const redis = getTailRedis()
  if (redis) {
    const cached = JSON.stringify({
      payload: bounded.payload,
      byteSize: bounded.byteSize,
      updatedAt: now,
      expiresAt,
    })
    void redis.set(
      redisCacheKey(orgId, userId, input.threadKey),
      cached,
      "EX",
      REMOTE_SESSION_TAIL_REDIS_TTL_SECONDS,
    ).catch((error: unknown) => {
      appLogger.warn("remote_session_tail_redis_write_error", {
        component: "remote_session_tail",
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }

  signalRemoteSessionUserUpdate(orgId, userId)
  return {
    threadKey: input.threadKey,
    payload: bounded.payload,
    byteSize: bounded.byteSize,
    updatedAt: now,
    expiresAt,
  }
}

export async function readRemoteSessionTail(input: {
  organizationId: string
  createdByUserId: string
  threadKey: string
  now?: number
}): Promise<StoredRemoteSessionTail | null> {
  const now = input.now ?? Date.now()
  const orgId = normalizeDenTypeId("organization", input.organizationId)
  const userId = normalizeDenTypeId("user", input.createdByUserId)
  const redis = getTailRedis()
  if (redis) {
    try {
      const raw = await redis.get(redisCacheKey(orgId, userId, input.threadKey))
      if (raw) {
        const parsed: unknown = JSON.parse(raw)
        if (isRecord(parsed)) {
          const validated = remoteSessionReadResultSchema.safeParse(parsed.payload)
          if (
            validated.success
            && typeof parsed.byteSize === "number"
            && typeof parsed.updatedAt === "number"
            && typeof parsed.expiresAt === "number"
            && parsed.expiresAt > now
          ) {
            return {
              threadKey: input.threadKey,
              payload: validated.data,
              byteSize: parsed.byteSize,
              updatedAt: parsed.updatedAt,
              expiresAt: parsed.expiresAt,
            }
          }
        }
      }
    } catch (error) {
      appLogger.warn("remote_session_tail_redis_read_error", {
        component: "remote_session_tail",
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const rows = await db.$primary.select().from(RemoteSessionTailTable).where(and(
    eq(RemoteSessionTailTable.org_id, orgId),
    eq(RemoteSessionTailTable.created_by_user_id, userId),
    eq(RemoteSessionTailTable.thread_key, input.threadKey),
    gt(RemoteSessionTailTable.expires_at, new Date(now)),
  )).limit(1)
  const row = rows[0]
  if (!row) return null
  const payload = parseTailPayload(row.payload)
  if (!payload) return null
  const entry: StoredRemoteSessionTail = {
    threadKey: row.thread_key,
    payload,
    byteSize: row.byte_size,
    updatedAt: row.updated_at.getTime(),
    expiresAt: row.expires_at.getTime(),
  }
  if (redis) {
    void redis.set(
      redisCacheKey(orgId, userId, input.threadKey),
      JSON.stringify({
        payload: entry.payload,
        byteSize: entry.byteSize,
        updatedAt: entry.updatedAt,
        expiresAt: entry.expiresAt,
      }),
      "EX",
      REMOTE_SESSION_TAIL_REDIS_TTL_SECONDS,
    ).catch(() => undefined)
  }
  return entry
}

export async function listRemoteSessionTailUpdatedAt(input: {
  organizationId: string
  createdByUserId: string
  threadKeys: readonly string[]
  now?: number
}): Promise<Map<string, number>> {
  const result = new Map<string, number>()
  if (input.threadKeys.length === 0) return result
  const now = input.now ?? Date.now()
  const rows = await db.$primary.select({
    thread_key: RemoteSessionTailTable.thread_key,
    updated_at: RemoteSessionTailTable.updated_at,
  }).from(RemoteSessionTailTable).where(and(
    eq(RemoteSessionTailTable.org_id, normalizeDenTypeId("organization", input.organizationId)),
    eq(RemoteSessionTailTable.created_by_user_id, normalizeDenTypeId("user", input.createdByUserId)),
    inArray(RemoteSessionTailTable.thread_key, [...input.threadKeys]),
    gt(RemoteSessionTailTable.expires_at, new Date(now)),
  ))
  for (const row of rows) result.set(row.thread_key, row.updated_at.getTime())
  return result
}

async function invalidateRedisKeys(rows: Array<{ org_id: string; created_by_user_id: string; thread_key: string }>) {
  const redis = getTailRedis()
  if (!redis || rows.length === 0) return
  const keys = rows.map((row) => redisCacheKey(row.org_id, row.created_by_user_id, row.thread_key))
  await redis.del(...keys).catch((error: unknown) => {
    appLogger.warn("remote_session_tail_redis_del_error", {
      component: "remote_session_tail",
      error: error instanceof Error ? error.message : String(error),
    })
  })
}

export async function deleteRemoteSessionTailsForRunner(input: {
  organizationId: string
  ownerMemberId: string
  runnerId: string
}): Promise<number> {
  const orgId = normalizeDenTypeId("organization", input.organizationId)
  const ownerMemberId = normalizeDenTypeId("member", input.ownerMemberId)
  const condition = and(
    eq(RemoteSessionTailTable.org_id, orgId),
    eq(RemoteSessionTailTable.owner_member_id, ownerMemberId),
    eq(RemoteSessionTailTable.runner_id, input.runnerId),
  )
  const rows = await db.$primary.select({
    org_id: RemoteSessionTailTable.org_id,
    created_by_user_id: RemoteSessionTailTable.created_by_user_id,
    thread_key: RemoteSessionTailTable.thread_key,
  }).from(RemoteSessionTailTable).where(condition)
  if (rows.length === 0) return 0
  await db.delete(RemoteSessionTailTable).where(condition)
  await invalidateRedisKeys(rows)
  return rows.length
}

export async function deleteRemoteSessionTailsForCommands(input: {
  organizationId: string
  commandIds: readonly string[]
}): Promise<number> {
  if (input.commandIds.length === 0) return 0
  const orgId = normalizeDenTypeId("organization", input.organizationId)
  const commandIds = input.commandIds.map((id) => normalizeDenTypeId("remoteSessionCommand", id))
  const condition = and(
    eq(RemoteSessionTailTable.org_id, orgId),
    inArray(RemoteSessionTailTable.command_id, commandIds),
  )
  const rows = await db.$primary.select({
    org_id: RemoteSessionTailTable.org_id,
    created_by_user_id: RemoteSessionTailTable.created_by_user_id,
    thread_key: RemoteSessionTailTable.thread_key,
  }).from(RemoteSessionTailTable).where(condition)
  if (rows.length === 0) return 0
  await db.delete(RemoteSessionTailTable).where(condition)
  await invalidateRedisKeys(rows)
  return rows.length
}

export async function deleteRemoteSessionTailsForMember(input: {
  organizationId: string
  ownerMemberId: string
}): Promise<number> {
  const orgId = normalizeDenTypeId("organization", input.organizationId)
  const ownerMemberId = normalizeDenTypeId("member", input.ownerMemberId)
  const condition = and(
    eq(RemoteSessionTailTable.org_id, orgId),
    eq(RemoteSessionTailTable.owner_member_id, ownerMemberId),
  )
  const rows = await db.$primary.select({
    org_id: RemoteSessionTailTable.org_id,
    created_by_user_id: RemoteSessionTailTable.created_by_user_id,
    thread_key: RemoteSessionTailTable.thread_key,
  }).from(RemoteSessionTailTable).where(condition)
  if (rows.length === 0) return 0
  await db.delete(RemoteSessionTailTable).where(condition)
  await invalidateRedisKeys(rows)
  return rows.length
}

export async function deleteRemoteSessionTailsForOrganization(organizationId: string): Promise<number> {
  const orgId = normalizeDenTypeId("organization", organizationId)
  const condition = eq(RemoteSessionTailTable.org_id, orgId)
  const rows = await db.$primary.select({
    org_id: RemoteSessionTailTable.org_id,
    created_by_user_id: RemoteSessionTailTable.created_by_user_id,
    thread_key: RemoteSessionTailTable.thread_key,
  }).from(RemoteSessionTailTable).where(condition)
  if (rows.length === 0) return 0
  await db.delete(RemoteSessionTailTable).where(condition)
  await invalidateRedisKeys(rows)
  return rows.length
}

export async function sweepExpiredRemoteSessionTails(now = Date.now()): Promise<number> {
  const expired = await db.$primary.select({
    org_id: RemoteSessionTailTable.org_id,
    created_by_user_id: RemoteSessionTailTable.created_by_user_id,
    thread_key: RemoteSessionTailTable.thread_key,
  }).from(RemoteSessionTailTable)
    .where(lte(RemoteSessionTailTable.expires_at, new Date(now)))
    .limit(REMOTE_SESSION_TAIL_SWEEP_BATCH)
  if (expired.length === 0) return 0
  for (const row of expired) {
    await db.delete(RemoteSessionTailTable).where(and(
      eq(RemoteSessionTailTable.org_id, row.org_id),
      eq(RemoteSessionTailTable.created_by_user_id, row.created_by_user_id),
      eq(RemoteSessionTailTable.thread_key, row.thread_key),
      lte(RemoteSessionTailTable.expires_at, new Date(now)),
    ))
  }
  await invalidateRedisKeys(expired)
  return expired.length
}

export function startRemoteSessionTailSweepLoop() {
  let running = false
  const run = async () => {
    if (running) return
    running = true
    try {
      await sweepExpiredRemoteSessionTails()
    } catch (error) {
      appLogger.warn("remote_session_tail_sweep_failed", {
        component: "remote_session_tail",
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      running = false
    }
  }
  const timer = setInterval(() => void run(), REMOTE_SESSION_TAIL_SWEEP_INTERVAL_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}
