import * as crypto from "node:crypto"
import { and, desc, eq, isNotNull, isNull, lt, or, type SQL } from "@openwork-ee/den-db/drizzle"
import { HeadlessSessionIndexTable, MemberTable } from "@openwork-ee/den-db/schema"
import { isDenTypeId, normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { z } from "zod"
import { writePlatformAuditEvent } from "../audit/request-capture.js"
import { db } from "../db.js"
import { env } from "../env.js"
import { readOrganizationForAuthorization } from "../features.js"
import { appLogger } from "../observability/logger.js"
import { captureException } from "../observability/runtime.js"

/**
 * The Den session index: a content-free row per headless runner conversation
 * (Workbot, Slack, Automations) with its sizes, activity and state, for admin views, retention, size reporting and
 * stuck-turn detection. The only module that reads or writes `headless_session_index`.
 *
 * Writes come from the runner, never from a person:
 * 1. When Den mints a turn's credentials, it also mints an **index capability**: a signed string
 *    bound to the organization, member (or none), session, kind and the one operation `index-update`, valid 30 days
 *    and minted again with every turn. Den keeps nothing for it.
 * 2. The runner keeps the capability next to the session and sends its outbox to `POST /v1/internal/headless/index`
 *    (routes.ts) with its callback token. The organization, member and kind come only from the verified capability;
 *    the update's session must be the capability's. Idempotent on (sessionId, version).
 *
 * Capability format: `hic1.<payload>.<mac>`, both base64url. The payload is the JSON claims below; the MAC is
 * HMAC-SHA256 over `hic1.<payload>` with a key derived from BETTER_AUTH_SECRET under its own label (no new setting),
 * compared in constant time. Rotating that secret invalidates every capability: the runner then drops the rejected
 * updates and reports again with the capability its next turn brings. Never log a capability.
 */

export const HEADLESS_INDEX_KINDS = ["workbot", "slack", "automation"] as const
export type HeadlessIndexKind = (typeof HEADLESS_INDEX_KINDS)[number]
export const HEADLESS_INDEX_CAPABILITY_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const HEADLESS_INDEX_MAX_UPDATES = 50
const CAPABILITY_VERSION = "hic1"
const CAPABILITY_KEY_LABEL = "openwork:headless-index-capability:v1"
const MAX_CAPABILITY_LENGTH = 2048
/** The runner's own session id rule (`hs_…`). */
const SESSION_ID = /^hs_[A-Za-z0-9_-]{8,96}$/
/** MySQL TIMESTAMP's upper bound, in epoch ms. */
const MAX_TIMESTAMP_MS = 2_147_483_647_000

const logger = appLogger.child({ component: "headless_session_index" })

export type HeadlessIndexClaims = {
  organizationId: DenTypeId<"organization">
  memberId: DenTypeId<"member"> | null
  sessionId: string
  kind: HeadlessIndexKind
  expiresAt: number
}

const claimsSchema = z.strictObject({
  v: z.literal(1),
  op: z.literal("index-update"),
  org: z.string().min(1).max(64),
  mem: z.string().min(1).max(64).nullable(),
  sid: z.string().regex(SESSION_ID),
  kind: z.enum(HEADLESS_INDEX_KINDS),
  exp: z.number().int().positive(),
})

let derivedKey: Uint8Array | null = null
function capabilityKey() {
  derivedKey ??= new Uint8Array(crypto.createHmac("sha256", env.betterAuthSecret).update(CAPABILITY_KEY_LABEL).digest())
  return derivedKey
}

function mac(signed: string) {
  return crypto.createHmac("sha256", capabilityKey()).update(signed).digest()
}

/** Mints a capability. Only trusted server code that already authorized this turn may call it. */
export function mintHeadlessIndexCapability(input: { organizationId: string; memberId: string | null; sessionId: string; kind: HeadlessIndexKind; now?: number }) {
  const claims: z.infer<typeof claimsSchema> = {
    v: 1,
    op: "index-update",
    org: normalizeDenTypeId("organization", input.organizationId),
    mem: input.memberId ? normalizeDenTypeId("member", input.memberId) : null,
    sid: input.sessionId,
    kind: input.kind,
    exp: (input.now ?? Date.now()) + HEADLESS_INDEX_CAPABILITY_TTL_MS,
  }
  const signed = `${CAPABILITY_VERSION}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`
  return `${signed}.${mac(signed).toString("base64url")}`
}

export type HeadlessIndexCapabilityCheck =
  | { ok: true; claims: HeadlessIndexClaims }
  | { ok: false; error: "capability_invalid" | "capability_expired" }

/** Verifies the MAC (constant time), then the claims, then the expiry. */
export function verifyHeadlessIndexCapability(capability: string, now = Date.now()): HeadlessIndexCapabilityCheck {
  if (capability.length > MAX_CAPABILITY_LENGTH) return { ok: false, error: "capability_invalid" }
  const parts = capability.split(".")
  if (parts.length !== 3 || parts[0] !== CAPABILITY_VERSION) return { ok: false, error: "capability_invalid" }
  const [version, payload, presented] = parts
  if (!payload || !presented || !/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]+$/.test(presented)) return { ok: false, error: "capability_invalid" }
  const expected = new Uint8Array(mac(`${version}.${payload}`))
  const given = new Uint8Array(Buffer.from(presented, "base64url"))
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return { ok: false, error: "capability_invalid" }
  let raw: unknown
  try {
    raw = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
  } catch {
    return { ok: false, error: "capability_invalid" }
  }
  const claims = claimsSchema.safeParse(raw)
  if (!claims.success) return { ok: false, error: "capability_invalid" }
  const { org, mem } = claims.data
  if (!isDenTypeId("organization", org) || (mem !== null && !isDenTypeId("member", mem))) return { ok: false, error: "capability_invalid" }
  if (claims.data.exp <= now) return { ok: false, error: "capability_expired" }
  return {
    ok: true,
    claims: {
      organizationId: normalizeDenTypeId("organization", org),
      memberId: mem === null ? null : normalizeDenTypeId("member", mem),
      sessionId: claims.data.sid,
      kind: claims.data.kind,
      expiresAt: claims.data.exp,
    },
  }
}

async function activeMemberId(organizationId: string, userId: string) {
  const [member] = await db
    .select({ id: MemberTable.id })
    .from(MemberTable)
    .where(and(eq(MemberTable.organizationId, normalizeDenTypeId("organization", organizationId)), eq(MemberTable.userId, normalizeDenTypeId("user", userId)), isNull(MemberTable.removedAt)))
    .limit(1)
  return member?.id ?? null
}

/**
 * The index capability to send with one turn, or undefined: when the caller named no kind or session, or when
 * minting fails (the turn runs exactly as without it).
 */
export async function indexCapabilityForTurn(input: {
  organizationId: string
  userId: string
  /** Known to Workbot; looked up from the user otherwise. */
  memberId?: string
  sessionId?: string
  indexKind?: HeadlessIndexKind
}): Promise<string | undefined> {
  const { sessionId, indexKind } = input
  if (!indexKind || !sessionId || !SESSION_ID.test(sessionId)) return undefined
  try {
    const memberId = input.memberId ?? (await activeMemberId(input.organizationId, input.userId))
    return mintHeadlessIndexCapability({ organizationId: input.organizationId, memberId, sessionId, kind: indexKind })
  } catch (error) {
    // The turn still runs; only its index updates are lost until the next turn. Never log the capability.
    logger.warn("headless index capability not minted", { error_name: error instanceof Error ? error.name : typeof error })
    reportIndexError("index_capability_mint_failed")
    return undefined
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Ingest

export const headlessIndexFieldsSchema = z.strictObject({
  title: z.string().max(200),
  createdAt: z.number().int().min(0).max(MAX_TIMESTAMP_MS),
  updatedAt: z.number().int().min(0).max(MAX_TIMESTAMP_MS),
  hotBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  segmentCount: z.number().int().min(0).max(2_147_483_647),
  totalBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  activeTurnSince: z.number().int().min(0).max(MAX_TIMESTAMP_MS).nullable(),
  deleted: z.boolean(),
})
export type HeadlessIndexFields = z.infer<typeof headlessIndexFieldsSchema>

export const headlessIndexUpdateSchema = z.strictObject({
  capability: z.string().min(1).max(MAX_CAPABILITY_LENGTH),
  sessionId: z.string().regex(SESSION_ID),
  version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  fields: headlessIndexFieldsSchema,
})

export const headlessIndexRequestSchema = z.strictObject({
  updates: z.array(z.unknown()).min(1).max(HEADLESS_INDEX_MAX_UPDATES),
})

export type HeadlessIndexRejection =
  | "invalid_update"
  | "capability_invalid"
  | "capability_expired"
  | "capability_mismatch"
  /** No longer sent (the index is always on); kept so the wire enum and older runners' retry list stay valid. */
  | "index_disabled"
  | "rate_limited"
  | "session_conflict"

export type HeadlessIndexResult =
  | { sessionId: string; version: number; status: "ok" | "stale" }
  | { sessionId: string; version: number; status: "rejected"; error: HeadlessIndexRejection }

/**
 * Token buckets per session and per organization. In memory, per den-api instance: bounded in size, no database work
 * per update, and steady reporting never trips them; the effective limit is this times the instances serving the
 * internal endpoint. A rejected `rate_limited` update is kept by the runner and sent again later.
 */
class TokenBuckets {
  private readonly buckets = new Map<string, { tokens: number; at: number }>()
  constructor(private readonly capacity: number, private readonly perSecond: number, private readonly maxKeys: number) {}

  take(key: string, now: number) {
    const bucket = this.buckets.get(key)
    const tokens = bucket ? Math.min(this.capacity, bucket.tokens + ((now - bucket.at) / 1000) * this.perSecond) : this.capacity
    if (bucket) this.buckets.delete(key)
    else if (this.buckets.size >= this.maxKeys) {
      // The least recently used key goes first (a Map keeps insertion order; used keys are re-inserted).
      const oldest = this.buckets.keys().next()
      if (!oldest.done) this.buckets.delete(oldest.value)
    }
    const allowed = tokens >= 1
    this.buckets.set(key, { tokens: allowed ? tokens - 1 : tokens, at: now })
    return allowed
  }

  forget(key: string) {
    this.buckets.delete(key)
  }

  clear() {
    this.buckets.clear()
  }
}

/** A runner sends one snapshot per session per flush; 30 back to back, then one every 2 seconds. */
export const HEADLESS_INDEX_SESSION_BURST = 30
const SESSION_REFILL_PER_SECOND = 0.5
/** Every runner cell of one organization together. */
export const HEADLESS_INDEX_ORG_BURST = 5_000
const ORG_REFILL_PER_SECOND = 50
const sessionBuckets = new TokenBuckets(HEADLESS_INDEX_SESSION_BURST, SESSION_REFILL_PER_SECOND, 100_000)
const orgBuckets = new TokenBuckets(HEADLESS_INDEX_ORG_BURST, ORG_REFILL_PER_SECOND, 20_000)

/** Tests only: start every bucket full. */
export function resetHeadlessIndexRateLimits() {
  sessionBuckets.clear()
  orgBuckets.clear()
}

/** At most one Sentry event per code per minute per instance, so a flood of rejections is one alert, not thousands. */
const REPORT_INTERVAL_MS = 60_000
const lastReported = new Map<string, number>()
class HeadlessIndexError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = "HeadlessIndexError"
  }
}
function reportIndexError(code: string, now = Date.now()) {
  const last = lastReported.get(code)
  if (last !== undefined && now - last < REPORT_INTERVAL_MS) return
  lastReported.set(code, now)
  captureException(new HeadlessIndexError(code), { component: "headless_session_index", error_code: code })
}

export const HEADLESS_INDEX_ROUTE = "/v1/internal/headless/index"

/** Each rejection is platform audit evidence (organization only when a verified capability named it) and a Sentry code. */
async function auditRejection(requestId: string | null, error: HeadlessIndexRejection, organizationId: string | null) {
  reportIndexError(`index_${error}`)
  await writePlatformAuditEvent(requestId, {
    method: "POST",
    route: HEADLESS_INDEX_ROUTE,
    action: "headless.session_index.update.attempted",
    outcome: "denied",
    status: 200,
    reasonCode: error,
    actor: { type: "service", id: "headless-runner" },
    origin: "api",
    target: organizationId ? { type: "organization", id: organizationId } : { type: "headless_session_index", id: null },
  })
}

function rowValues(fields: HeadlessIndexFields, now: Date) {
  return {
    title: fields.title,
    createdAt: new Date(fields.createdAt),
    updatedAt: new Date(fields.updatedAt),
    hotBytes: fields.hotBytes,
    segmentCount: fields.segmentCount,
    totalBytes: fields.totalBytes,
    activeTurnSince: fields.activeTurnSince === null ? null : new Date(fields.activeTurnSince),
    deletedAt: fields.deleted ? now : null,
    lastReportedAt: now,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isDuplicateKey(error: unknown): boolean {
  if (!isRecord(error)) return false
  if (error.code === "ER_DUP_ENTRY" || error.errno === 1062) return true
  if (typeof error.message === "string" && error.message.includes("Duplicate entry")) return true
  return isDuplicateKey(error.cause)
}

function changedRows(result: unknown): number {
  if (Array.isArray(result)) {
    for (const value of result) {
      const rows = changedRows(value)
      if (rows >= 0) return rows
    }
    return -1
  }
  if (!isRecord(result)) return -1
  if (typeof result.rowsAffected === "number") return result.rowsAffected
  if (typeof result.affectedRows === "number") return result.affectedRows
  return -1
}

function sameOwner(claims: HeadlessIndexClaims): SQL | undefined {
  return and(
    eq(HeadlessSessionIndexTable.organizationId, claims.organizationId),
    claims.memberId === null ? isNull(HeadlessSessionIndexTable.memberId) : eq(HeadlessSessionIndexTable.memberId, claims.memberId),
    eq(HeadlessSessionIndexTable.kind, claims.kind),
  )
}

/** Applies one verified update: a newer version replaces the row; an older or equal one changes nothing. */
async function applyUpdate(claims: HeadlessIndexClaims, version: number, fields: HeadlessIndexFields, now: Date): Promise<"ok" | "stale" | "session_conflict"> {
  const values = rowValues(fields, now)
  const update = async () =>
    changedRows(
      await db
        .update(HeadlessSessionIndexTable)
        .set({ ...values, version })
        .where(and(eq(HeadlessSessionIndexTable.sessionId, claims.sessionId), lt(HeadlessSessionIndexTable.version, version), sameOwner(claims))),
    )
  if ((await update()) > 0) return "ok"
  try {
    await db.insert(HeadlessSessionIndexTable).values({
      sessionId: claims.sessionId,
      organizationId: claims.organizationId,
      memberId: claims.memberId,
      kind: claims.kind,
      version,
      ...values,
    })
    return "ok"
  } catch (error) {
    if (!isDuplicateKey(error)) throw error
  }
  // Another update for this session landed first: apply ours if it is still the newer one.
  if ((await update()) > 0) return "ok"
  const [existing] = await db
    .select({ sessionId: HeadlessSessionIndexTable.sessionId })
    .from(HeadlessSessionIndexTable)
    .where(and(eq(HeadlessSessionIndexTable.sessionId, claims.sessionId), sameOwner(claims)))
    .limit(1)
  // The row belongs to another organization, member or kind: never overwritten, never revealed.
  return existing ? "stale" : "session_conflict"
}

/**
 * Applies one request's updates in order. Never throws for a single bad update: each gets its own result. A database
 * failure throws (the route answers 500 and the runner retries the whole batch; versions make that safe).
 */
export async function ingestHeadlessIndexUpdates(updates: readonly unknown[], options: { requestId?: string | null; now?: number } = {}): Promise<HeadlessIndexResult[]> {
  const nowMs = options.now ?? Date.now()
  const now = new Date(nowMs)
  const requestId = options.requestId ?? null
  const organizations = new Map<string, "active" | "deleted">()
  const results: HeadlessIndexResult[] = []
  for (const raw of updates) {
    const parsed = headlessIndexUpdateSchema.safeParse(raw)
    if (!parsed.success) {
      const sessionId = isRecord(raw) && typeof raw.sessionId === "string" && raw.sessionId.length <= 128 ? raw.sessionId : ""
      const version = isRecord(raw) && typeof raw.version === "number" && Number.isSafeInteger(raw.version) ? raw.version : 0
      results.push({ sessionId, version, status: "rejected", error: "invalid_update" })
      await auditRejection(requestId, "invalid_update", null)
      continue
    }
    const { capability, sessionId, version, fields } = parsed.data
    const reject = async (error: HeadlessIndexRejection, organizationId: string | null) => {
      results.push({ sessionId, version, status: "rejected", error })
      await auditRejection(requestId, error, organizationId)
    }
    const checked = verifyHeadlessIndexCapability(capability, nowMs)
    if (!checked.ok) {
      await reject(checked.error, null)
      continue
    }
    const { claims } = checked
    if (claims.sessionId !== sessionId) {
      await reject("capability_mismatch", claims.organizationId)
      continue
    }
    let state = organizations.get(claims.organizationId)
    if (state === undefined) {
      // A deleted organization's capabilities stay signed until they expire: its rows must never come back.
      state = (await readOrganizationForAuthorization(claims.organizationId)) ? "active" : "deleted"
      organizations.set(claims.organizationId, state)
    }
    if (state === "deleted") {
      await reject("capability_invalid", null)
      continue
    }
    if (!sessionBuckets.take(sessionId, nowMs) || !orgBuckets.take(claims.organizationId, nowMs)) {
      await reject("rate_limited", claims.organizationId)
      continue
    }
    const applied = await applyUpdate(claims, version, fields, now)
    if (applied === "session_conflict") {
      await reject("session_conflict", claims.organizationId)
      continue
    }
    if (applied === "ok" && fields.deleted) sessionBuckets.forget(sessionId)
    results.push({ sessionId, version, status: applied })
  }
  return results
}

// ---------------------------------------------------------------------------------------------------------------
// Deletion

type Database = typeof db | Parameters<Parameters<typeof db["transaction"]>[0]>[0]

/** MySQL "table doesn't exist" (1146) for this table, through Drizzle's (`cause`) or PlanetScale's (`body`) wrapper. */
function isMissingIndexTableError(error: unknown): boolean {
  if (!isRecord(error)) return false
  const message = typeof error.message === "string" ? error.message : ""
  if ((error.errno === 1146 || error.code === "ER_NO_SUCH_TABLE" || message.includes("doesn't exist")) && /\bheadless_session_index\b/.test(message)) return true
  return isMissingIndexTableError(error.cause) || isMissingIndexTableError(error.body)
}

/**
 * Deletes an organization's index rows inside the transaction that deletes the organization, like its usage and
 * audit rows. Member removal and user deletion keep the rows, as they keep usage and audit rows: a row names only the
 * member id (Den keeps removed members' rows; user deletion unlinks the user from them), never a user, so the session
 * stays attributable for retention and legal hold. Before this table's migration has run there is nothing to delete,
 * and the organization deletion must not fail.
 */
export async function deleteHeadlessSessionIndexForOrganization(database: Database, organizationId: DenTypeId<"organization">) {
  try {
    await database.delete(HeadlessSessionIndexTable).where(eq(HeadlessSessionIndexTable.organizationId, organizationId))
  } catch (error) {
    if (!isMissingIndexTableError(error)) throw error
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Reads (org admins)

export const headlessSessionIndexQuerySchema = z.object({
  memberId: z.string().min(1).max(64).optional(),
  kind: z.enum(HEADLESS_INDEX_KINDS).optional(),
  /** `true`: only conversations with a turn running now; `false`: only those without. */
  active: z.enum(["true", "false"]).optional(),
  /** Deleted conversations are left out unless asked for (`include`) or asked for alone (`only`). */
  deleted: z.enum(["exclude", "include", "only"]).default("exclude"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).max(512).optional(),
})
export type HeadlessSessionIndexQuery = z.infer<typeof headlessSessionIndexQuerySchema>

/** One conversation as an admin sees it: sizes, activity and state; never its title or anything it contains. */
export const headlessSessionIndexEntrySchema = z.object({
  sessionId: z.string(),
  memberId: z.string().nullable(),
  kind: z.enum(HEADLESS_INDEX_KINDS),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  hotBytes: z.number().int(),
  segmentCount: z.number().int(),
  totalBytes: z.number().int(),
  activeTurnSince: z.iso.datetime().nullable(),
  deletedAt: z.iso.datetime().nullable(),
  retentionClass: z.string().nullable(),
  legalHold: z.boolean(),
  lastReportedAt: z.iso.datetime(),
}).meta({ ref: "HeadlessSessionIndexEntry" })

export const headlessSessionIndexPageSchema = z.object({
  sessions: z.array(headlessSessionIndexEntrySchema),
  /** Pass as `cursor` for the next page; null on the last one. */
  nextCursor: z.string().nullable(),
}).meta({ ref: "HeadlessSessionIndexPage" })

const cursorSchema = z.strictObject({ u: z.number().int(), s: z.string().regex(SESSION_ID) })

function encodeCursor(updatedAt: Date, sessionId: string) {
  return Buffer.from(JSON.stringify({ u: updatedAt.getTime(), s: sessionId })).toString("base64url")
}

function decodeCursor(value: string) {
  try {
    const parsed = cursorSchema.safeParse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export class HeadlessSessionIndexQueryError extends Error {
  constructor(readonly code: "invalid_cursor" | "invalid_member") {
    super(code)
    this.name = "HeadlessSessionIndexQueryError"
  }
}

/** One organization's index rows, most recently updated first, paged by an opaque cursor. */
export async function listHeadlessSessionIndex(organizationId: string, query: HeadlessSessionIndexQuery): Promise<z.infer<typeof headlessSessionIndexPageSchema>> {
  const table = HeadlessSessionIndexTable
  const conditions: Array<SQL | undefined> = [eq(table.organizationId, normalizeDenTypeId("organization", organizationId))]
  if (query.memberId) {
    let memberId: DenTypeId<"member">
    try {
      memberId = normalizeDenTypeId("member", query.memberId)
    } catch {
      throw new HeadlessSessionIndexQueryError("invalid_member")
    }
    conditions.push(eq(table.memberId, memberId))
  }
  if (query.kind) conditions.push(eq(table.kind, query.kind))
  if (query.active === "true") conditions.push(isNotNull(table.activeTurnSince))
  if (query.active === "false") conditions.push(isNull(table.activeTurnSince))
  if (query.deleted === "exclude") conditions.push(isNull(table.deletedAt))
  if (query.deleted === "only") conditions.push(isNotNull(table.deletedAt))
  if (query.cursor) {
    const cursor = decodeCursor(query.cursor)
    if (!cursor) throw new HeadlessSessionIndexQueryError("invalid_cursor")
    const at = new Date(cursor.u)
    conditions.push(or(lt(table.updatedAt, at), and(eq(table.updatedAt, at), lt(table.sessionId, cursor.s))))
  }
  const rows = await db
    .select({
      sessionId: table.sessionId,
      memberId: table.memberId,
      kind: table.kind,
      createdAt: table.createdAt,
      updatedAt: table.updatedAt,
      hotBytes: table.hotBytes,
      segmentCount: table.segmentCount,
      totalBytes: table.totalBytes,
      activeTurnSince: table.activeTurnSince,
      deletedAt: table.deletedAt,
      retentionClass: table.retentionClass,
      legalHold: table.legalHold,
      lastReportedAt: table.lastReportedAt,
    })
    .from(table)
    .where(and(...conditions))
    .orderBy(desc(table.updatedAt), desc(table.sessionId))
    .limit(query.limit + 1)
  const page = rows.slice(0, query.limit)
  const last = page.at(-1)
  return {
    sessions: page.map((row) => ({
      sessionId: row.sessionId,
      memberId: row.memberId,
      kind: row.kind,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      hotBytes: Number(row.hotBytes),
      segmentCount: Number(row.segmentCount),
      totalBytes: Number(row.totalBytes),
      activeTurnSince: row.activeTurnSince ? row.activeTurnSince.toISOString() : null,
      deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
      retentionClass: row.retentionClass,
      legalHold: row.legalHold,
      lastReportedAt: row.lastReportedAt.toISOString(),
    })),
    nextCursor: rows.length > query.limit && last ? encodeCursor(last.updatedAt, last.sessionId) : null,
  }
}

