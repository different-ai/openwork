import * as crypto from "node:crypto"
import { and, eq, inArray, isNull, lt, sql } from "@openwork-ee/den-db/drizzle"
import { HeadlessResumeGrantTable, MemberTable, RateLimitTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../db.js"
import { organizationFeatureEnabled } from "../features.js"
import { mintHeadlessRunMcpToken } from "../mcp/headless-run-token-mint.js"
import { appLogger } from "../observability/logger.js"
import { checkRateLimit } from "../utils/rate-limit.js"

/**
 * Resume grants (feature `headlessDurableTurns`): a narrow credential Den hands the headless runner with each turn,
 * which the runner can only exchange (POST /v1/headless/resume-token) for a fresh member-scoped MCP token for that
 * exact turn, its background tasks (`<messageId>.tN`) and their reports (`<messageId>.tN.r`). It lets the runner
 * continue a turn on its own after a restart, deploy or failover, and refresh a long turn's token in place.
 *
 * Den stores only the grant's SHA-256 hash. Grants live 12 hours, are revoked wherever the member's credentials are
 * revoked (resume-grant-revocation.ts: membership removed, role changed) and deleted with the user; expired rows are
 * pruned on mint. Never log or report a grant or a token.
 */

export const HEADLESS_RESUME_GRANT_TTL_MS = 12 * 60 * 60 * 1000
export const HEADLESS_RESUME_GRANT_PREFIX = "hrg_"
/** `hrg_` + 32 random bytes in base64url (43 characters). */
export const HEADLESS_RESUME_GRANT_PATTERN = /^hrg_[A-Za-z0-9_-]{43}$/
/** Exchanges allowed per grant per hour: a runner refreshes about every 50 minutes and retries with backoff. */
export const HEADLESS_RESUME_GRANT_EXCHANGES_PER_WINDOW = 60
export const HEADLESS_RESUME_GRANT_EXCHANGE_WINDOW_MS = 60 * 60 * 1000
/** The runner's own limits on ids it accepts; anything longer cannot be a real turn. */
const MAX_BOUND_ID_LENGTH = 128
/** Expired rows deleted per mint, so one mint never turns into a long delete. */
const PRUNE_BATCH = 500

const logger = appLogger.child({ component: "headless_resume_grants" })

type GrantRow = typeof HeadlessResumeGrantTable.$inferSelect

export function hashHeadlessResumeGrant(grant: string) {
  return crypto.createHash("sha256").update(grant).digest("hex")
}

export function headlessResumeGrantRateLimitKey(grantId: string) {
  return `headless-resume-grant:${grantId}`
}

/** Deletes expired grants (and their exchange counters). */
async function pruneExpiredHeadlessResumeGrants(now: Date) {
  const expired = await db
    .select({ id: HeadlessResumeGrantTable.id })
    .from(HeadlessResumeGrantTable)
    .where(lt(HeadlessResumeGrantTable.expiresAt, now))
    .limit(PRUNE_BATCH)
  if (!expired.length) return
  const ids = expired.map((row) => row.id)
  await db.delete(HeadlessResumeGrantTable).where(inArray(HeadlessResumeGrantTable.id, ids))
  await db.delete(RateLimitTable).where(inArray(RateLimitTable.key, ids.map(headlessResumeGrantRateLimitKey)))
}

/**
 * Mints a resume grant for one turn. Only trusted server code that has already authorized the member for this turn
 * may call it, and only where `headlessDurableTurns` is on (see mintHeadlessTurnCredentials).
 */
export async function mintHeadlessResumeGrant(input: {
  userId: string
  organizationId: string
  sessionId: string
  messageId: string
  readOnly?: boolean
  now?: Date
}): Promise<{ grant: string; grantId: string; expiresAt: Date }> {
  const now = input.now ?? new Date()
  await pruneExpiredHeadlessResumeGrants(now)
  const grant = `${HEADLESS_RESUME_GRANT_PREFIX}${crypto.randomBytes(32).toString("base64url")}`
  const grantId = createDenTypeId("headlessResumeGrant")
  const expiresAt = new Date(now.getTime() + HEADLESS_RESUME_GRANT_TTL_MS)
  await db.insert(HeadlessResumeGrantTable).values({
    id: grantId,
    organizationId: normalizeDenTypeId("organization", input.organizationId),
    userId: normalizeDenTypeId("user", input.userId),
    sessionId: input.sessionId,
    messageId: input.messageId,
    readOnly: input.readOnly === true,
    tokenHash: hashHeadlessResumeGrant(grant),
    expiresAt,
    createdAt: now,
    useCount: 0,
  })
  return { grant, grantId, expiresAt }
}

function boundId(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_BOUND_ID_LENGTH
}

/**
 * A resume grant for the turn, or undefined: when `headlessDurableTurns` is off for the organization, when the turn's
 * session or message is unknown, or when minting fails (the turn then runs exactly as without the feature).
 */
async function resumeGrantForTurn(input: {
  userId: string
  organizationId: string
  sessionId?: string
  messageId?: string
  readOnly?: boolean
}): Promise<string | undefined> {
  const { sessionId, messageId } = input
  if (!boundId(sessionId) || !boundId(messageId)) return undefined
  try {
    if (!(await organizationFeatureEnabled(input.organizationId, "headlessDurableTurns"))) return undefined
    const { grant } = await mintHeadlessResumeGrant({ ...input, sessionId, messageId })
    return grant
  } catch (error) {
    // The turn still runs; only self-resume is lost. Never log the grant.
    logger.warn("headless resume grant not minted", { error_name: error instanceof Error ? error.name : typeof error })
    return undefined
  }
}

/**
 * The credentials Den sends with one headless turn: a member-scoped MCP token and, where `headlessDurableTurns` is on
 * and the turn's session and message are known, a resume grant. Without the feature the result has no
 * `resumeGrant` field at all, so nothing changes for callers or the runner.
 */
export async function mintHeadlessTurnCredentials(input: {
  userId: string
  organizationId: string
  ttlMs?: number
  readOnly?: boolean
  sessionId?: string
  messageId?: string
}): Promise<{ token: string; tokenId: string; expiresAt: Date; resumeGrant?: string }> {
  const minted = await mintHeadlessRunMcpToken(input)
  const resumeGrant = await resumeGrantForTurn(input)
  return resumeGrant ? { ...minted, resumeGrant } : minted
}

export type HeadlessResumeGrantError =
  | "grant_invalid"
  | "grant_expired"
  | "grant_revoked"
  | "grant_mismatch"
  | "membership_inactive"
  | "feature_disabled"

/** The stored grant behind a presented one, or null when it is malformed or unknown. */
export async function findHeadlessResumeGrant(grant: string): Promise<GrantRow | null> {
  if (!HEADLESS_RESUME_GRANT_PATTERN.test(grant)) return null
  const [row] = await db
    .select()
    .from(HeadlessResumeGrantTable)
    .where(eq(HeadlessResumeGrantTable.tokenHash, hashHeadlessResumeGrant(grant)))
    .limit(1)
  return row ?? null
}

/** The turn itself, or a background task or report it started (`<messageId>.…`). */
export function headlessResumeGrantCovers(row: Pick<GrantRow, "sessionId" | "messageId">, input: { sessionId: string; messageId: string }) {
  if (input.sessionId !== row.sessionId) return false
  return input.messageId === row.messageId || input.messageId.startsWith(`${row.messageId}.`)
}

/** The member id when the grant's user is still an active member of its organization. */
export async function activeHeadlessResumeGrantMember(row: Pick<GrantRow, "userId" | "organizationId">): Promise<string | null> {
  const [member] = await db
    .select({ id: MemberTable.id })
    .from(MemberTable)
    .where(and(eq(MemberTable.organizationId, row.organizationId), eq(MemberTable.userId, row.userId), isNull(MemberTable.removedAt)))
    .limit(1)
  return member?.id ?? null
}

export type HeadlessResumeExchange =
  | { ok: true; mcpToken: string; expiresAt: Date; readOnly: boolean }
  | { ok: false; status: 403; error: HeadlessResumeGrantError }
  | { ok: false; status: 429; error: "rate_limited"; retryAfterMs: number }

/**
 * Exchanges a found grant for a fresh MCP token, checking in order: revoked, expired, bound to this turn, member
 * still active, feature on, rate limit. `memberId` is the active membership (null when it ended).
 */
export async function exchangeHeadlessResumeGrant(
  row: GrantRow,
  input: { sessionId: string; messageId: string; memberId: string | null; now?: Date },
): Promise<HeadlessResumeExchange> {
  const now = input.now ?? new Date()
  if (row.revokedAt) return { ok: false, status: 403, error: "grant_revoked" }
  if (row.expiresAt.getTime() <= now.getTime()) return { ok: false, status: 403, error: "grant_expired" }
  if (!headlessResumeGrantCovers(row, input)) return { ok: false, status: 403, error: "grant_mismatch" }
  if (!input.memberId) return { ok: false, status: 403, error: "membership_inactive" }
  if (!(await organizationFeatureEnabled(row.organizationId, "headlessDurableTurns"))) {
    return { ok: false, status: 403, error: "feature_disabled" }
  }
  const retryAfterSeconds = await checkRateLimit(
    headlessResumeGrantRateLimitKey(row.id),
    HEADLESS_RESUME_GRANT_EXCHANGES_PER_WINDOW,
    HEADLESS_RESUME_GRANT_EXCHANGE_WINDOW_MS,
    now.getTime(),
  )
  if (retryAfterSeconds !== null) return { ok: false, status: 429, error: "rate_limited", retryAfterMs: retryAfterSeconds * 1000 }
  const minted = await mintHeadlessRunMcpToken({ userId: row.userId, organizationId: row.organizationId, readOnly: row.readOnly })
  await db
    .update(HeadlessResumeGrantTable)
    .set({ lastUsedAt: now, useCount: sql`${HeadlessResumeGrantTable.useCount} + 1` })
    .where(eq(HeadlessResumeGrantTable.id, row.id))
  return { ok: true, mcpToken: minted.token, expiresAt: minted.expiresAt, readOnly: row.readOnly }
}
