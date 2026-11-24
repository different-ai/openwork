import * as crypto from "node:crypto"
import { and, eq, inArray, isNull, lt, sql } from "@openwork-ee/den-db/drizzle"
import { HeadlessResumeGrantTable, HeadlessResumeRevocationTable, MemberTable, RateLimitTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../db.js"
import { mintHeadlessRunMcpToken, revokeHeadlessRunMcpToken } from "../mcp/headless-run-token-mint.js"
import { isWorkbotTurnLimitScope } from "../mcp/workbot-turn-limits.js"
import { appLogger } from "../observability/logger.js"
import { checkRateLimit } from "../utils/rate-limit.js"
import type { HeadlessModelAccess } from "@openwork-ee/headless-protocol"
import { organizationCloudModelSelection } from "../workbot/model.js"
import { cloudAgentGatewayAccess } from "../workbot/gateway-model.js"
import { isWorkbotManagedLuna } from "@openwork/types/den/workbot-settings"
import { workbotManagedLunaAccess } from "../workbot/managed-luna.js"
import { indexCapabilityForTurn, type HeadlessIndexKind } from "./session-index.js"

export const HEADLESS_RESUME_GRANT_TTL_MS = 12 * 60 * 60 * 1000
export const HEADLESS_RESUME_GRANT_PREFIX = "hrg_"
export const HEADLESS_RESUME_GRANT_PATTERN = /^hrg_[A-Za-z0-9_-]{43}$/
export const HEADLESS_RESUME_GRANT_EXCHANGES_PER_WINDOW = 60
export const HEADLESS_RESUME_GRANT_EXCHANGE_WINDOW_MS = 60 * 60 * 1000
const MAX_BOUND_ID_LENGTH = 128
export const HEADLESS_RESUME_REVOCATION_MARGIN_MS = 30_000
const PRUNE_BATCH = 500

const logger = appLogger.child({ component: "headless_resume_grants" })

type GrantRow = typeof HeadlessResumeGrantTable.$inferSelect

export function hashHeadlessResumeGrant(grant: string) {
  return crypto.createHash("sha256").update(grant).digest("hex")
}

export function headlessResumeGrantRateLimitKey(grantId: string) {
  return `headless-resume-grant:${grantId}`
}

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

export async function mintHeadlessResumeGrant(input: {
  userId: string
  organizationId: string
  sessionId: string
  messageId: string
  readOnly?: boolean
  scopes?: readonly string[]
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
    scopes: grantScopes(input),
    tokenHash: hashHeadlessResumeGrant(grant),
    expiresAt,
    createdAt: now,
    useCount: 0,
  })
  return { grant, grantId, expiresAt }
}

function grantScopes(input: { readOnly?: boolean; scopes?: readonly string[] }): string[] | null {
  const scopes = input.readOnly === true ? [...(input.scopes ?? [])] : (input.scopes ?? []).filter(isWorkbotTurnLimitScope)
  return scopes.length ? scopes : null
}

function boundId(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_BOUND_ID_LENGTH
}

async function resumeGrantForTurn(input: {
  userId: string
  organizationId: string
  sessionId?: string
  messageId?: string
  readOnly?: boolean
  scopes?: readonly string[]
  authorizedAt: Date
}): Promise<Awaited<ReturnType<typeof mintHeadlessResumeGrant>> | undefined> {
  const { sessionId, messageId } = input
  if (!boundId(sessionId) || !boundId(messageId)) return undefined
  try {
    return await mintHeadlessResumeGrant({ ...input, sessionId, messageId, now: input.authorizedAt })
  } catch (error) {
    logger.warn("headless resume grant not minted", { error_name: error instanceof Error ? error.name : typeof error })
    return undefined
  }
}

export async function mintHeadlessTurnCredentials(input: {
  userId: string
  organizationId: string
  ttlMs?: number
  readOnly?: boolean
  scopes?: readonly string[]
  sessionId?: string
  messageId?: string
  model?: string
  indexKind?: HeadlessIndexKind
  memberId?: string
}): Promise<{ token: string; tokenId: string; expiresAt: Date; resumeGrant?: string; modelAccess?: HeadlessModelAccess; indexCapability?: string }> {
  const authorizedAt = new Date()
  const modelAccess = input.indexKind === "workbot" && input.model && isWorkbotManagedLuna(input.model)
    ? await workbotManagedLunaAccess(input, input.model)
    : await cloudAgentGatewayAccess(input, input.model ?? await organizationCloudModelSelection(input) ?? "")
  const minted = await mintHeadlessRunMcpToken(input)
  const resumeGrant = await resumeGrantForTurn({ ...input, authorizedAt })
  const indexCapability = await indexCapabilityForTurn(input)
  if (input.indexKind === "workbot") {
    await (await import("../mcp-events/context.js")).bindEventTurn({ ...input, tokenId: minted.tokenId, resumeGrantId: resumeGrant?.grantId, expiresAt: resumeGrant?.expiresAt ?? minted.expiresAt })
  }
  return { ...minted, ...(resumeGrant ? { resumeGrant: resumeGrant.grant } : {}), modelAccess, ...(indexCapability ? { indexCapability } : {}) }
}

export type HeadlessResumeGrantError =
  | "grant_invalid"
  | "grant_expired"
  | "grant_revoked"
  | "grant_mismatch"
  | "membership_inactive"
  | "model_unavailable"

export async function findHeadlessResumeGrant(grant: string): Promise<GrantRow | null> {
  if (!HEADLESS_RESUME_GRANT_PATTERN.test(grant)) return null
  const [row] = await db.$primary
    .select()
    .from(HeadlessResumeGrantTable)
    .where(eq(HeadlessResumeGrantTable.tokenHash, hashHeadlessResumeGrant(grant)))
    .limit(1)
  return row ?? null
}

export function headlessResumeGrantCovers(row: Pick<GrantRow, "sessionId" | "messageId">, input: { sessionId: string; messageId: string }) {
  if (input.sessionId !== row.sessionId) return false
  return input.messageId === row.messageId || input.messageId.startsWith(`${row.messageId}.`)
}

export async function activeHeadlessResumeGrantMember(row: Pick<GrantRow, "userId" | "organizationId">): Promise<string | null> {
  const [member] = await db.$primary
    .select({ id: MemberTable.id })
    .from(MemberTable)
    .where(and(eq(MemberTable.organizationId, row.organizationId), eq(MemberTable.userId, row.userId), isNull(MemberTable.removedAt)))
    .limit(1)
  return member?.id ?? null
}

export async function headlessResumeGrantAuthorizedBeforeRevocation(row: Pick<GrantRow, "userId" | "organizationId" | "createdAt">) {
  const [revocation] = await db.$primary
    .select({ revokedAt: HeadlessResumeRevocationTable.revokedAt })
    .from(HeadlessResumeRevocationTable)
    .where(and(eq(HeadlessResumeRevocationTable.organizationId, row.organizationId), eq(HeadlessResumeRevocationTable.userId, row.userId)))
    .limit(1)
  if (!revocation) return false
  return row.createdAt.getTime() <= revocation.revokedAt.getTime() + HEADLESS_RESUME_REVOCATION_MARGIN_MS
}

async function headlessResumeGrantRevokedNow(row: GrantRow) {
  const [current] = await db.$primary
    .select({ revokedAt: HeadlessResumeGrantTable.revokedAt })
    .from(HeadlessResumeGrantTable)
    .where(eq(HeadlessResumeGrantTable.id, row.id))
    .limit(1)
  if (!current || current.revokedAt) return true
  return headlessResumeGrantAuthorizedBeforeRevocation(row)
}

export type HeadlessResumeExchange =
  | { ok: true; mcpToken: string; expiresAt: Date; readOnly: boolean; modelAccess?: HeadlessModelAccess }
  | { ok: false; status: 403; error: HeadlessResumeGrantError }
  | { ok: false; status: 429; error: "rate_limited"; retryAfterMs: number }

export async function exchangeHeadlessResumeGrant(
  row: GrantRow,
  input: {
    sessionId: string
    messageId: string
    memberId: string | null
    model?: string
    modelAccessRequired?: boolean
    now?: Date
    afterMint?: () => Promise<void>
  },
): Promise<HeadlessResumeExchange> {
  const now = input.now ?? new Date()
  if (row.revokedAt || (await headlessResumeGrantAuthorizedBeforeRevocation(row))) return { ok: false, status: 403, error: "grant_revoked" }
  if (row.expiresAt.getTime() <= now.getTime()) return { ok: false, status: 403, error: "grant_expired" }
  if (!headlessResumeGrantCovers(row, input)) return { ok: false, status: 403, error: "grant_mismatch" }
  if (!input.memberId) return { ok: false, status: 403, error: "membership_inactive" }
  const retryAfterSeconds = await checkRateLimit(
    headlessResumeGrantRateLimitKey(row.id),
    HEADLESS_RESUME_GRANT_EXCHANGES_PER_WINDOW,
    HEADLESS_RESUME_GRANT_EXCHANGE_WINDOW_MS,
    now.getTime(),
  )
  if (retryAfterSeconds !== null) return { ok: false, status: 429, error: "rate_limited", retryAfterMs: retryAfterSeconds * 1000 }
  let modelAccess: HeadlessModelAccess | undefined
  if (input.modelAccessRequired) {
    if (!input.model) return { ok: false, status: 403, error: "model_unavailable" }
    try {
      modelAccess = await (isWorkbotManagedLuna(input.model) ? workbotManagedLunaAccess : cloudAgentGatewayAccess)(row, input.model)
    } catch {
      return { ok: false, status: 403, error: "model_unavailable" }
    }
  }
  const minted = await mintHeadlessRunMcpToken({ userId: row.userId, organizationId: row.organizationId, readOnly: row.readOnly, ...(row.scopes?.length ? { scopes: row.scopes } : {}) })
  await input.afterMint?.()
  if (await headlessResumeGrantRevokedNow(row)) {
    await revokeHeadlessRunMcpToken(minted.tokenId)
    return { ok: false, status: 403, error: "grant_revoked" }
  }
  if (!row.readOnly) {
    await (await import("../mcp-events/context.js")).rebindEventTurn({
      tokenId: minted.tokenId, resumeGrantId: row.id, organizationId: row.organizationId, userId: row.userId,
      memberId: input.memberId, sessionId: row.sessionId, expiresAt: row.expiresAt,
    })
  }
  await db
    .update(HeadlessResumeGrantTable)
    .set({ lastUsedAt: now, useCount: sql`${HeadlessResumeGrantTable.useCount} + 1` })
    .where(eq(HeadlessResumeGrantTable.id, row.id))
  return { ok: true, mcpToken: minted.token, expiresAt: minted.expiresAt, readOnly: row.readOnly, ...(modelAccess ? { modelAccess } : {}) }
}
