import { ORGANIZATION_WEB_ORIGIN_LIMIT, normalizeExactHttpsOrigin } from "@openwork/types/den/organization-web-origins"
import { and, asc, count, eq, isNull } from "@openwork-ee/den-db/drizzle"
import { AuthUserTable, MemberTable, OrganizationTable, OrganizationWebOriginTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "./db.js"

type OrganizationId = DenTypeId<"organization">
type OrganizationWebOriginId = DenTypeId<"organizationWebOrigin">
type MemberId = DenTypeId<"member">
type UserId = DenTypeId<"user">

export type OrganizationWebOriginRecord = {
  id: OrganizationWebOriginId
  origin: string
  createdAt: Date
  createdByName: string | null
}

export type ApproveOrganizationWebOriginResult =
  | { ok: true; webOrigin: OrganizationWebOriginRecord }
  | { ok: false; reason: "already_approved" | "limit_reached" }

/** Resolves whether `origin` is approved, optionally scoped to one organization. */
type WebOriginApprovalLookup = (input: { origin: string; organizationId?: OrganizationId }) => Promise<boolean>

const APPROVAL_CACHE_TTL_MS = 30_000
const APPROVAL_CACHE_MAX_ENTRIES = 2_000

const approvalCache = new Map<string, { approved: boolean; expiresAt: number }>()
const inFlightApprovals = new Map<string, Promise<boolean>>()
let approvalCacheGeneration = 0

async function lookupWebOriginApprovalInDatabase(input: { origin: string; organizationId?: OrganizationId }) {
  const originMatch = eq(OrganizationWebOriginTable.origin, input.origin)
  const rows = await db
    .select({ id: OrganizationWebOriginTable.id })
    .from(OrganizationWebOriginTable)
    .where(input.organizationId ? and(eq(OrganizationWebOriginTable.organizationId, input.organizationId), originMatch) : originMatch)
    .limit(1)
  return rows.length > 0
}

let activeApprovalLookup: WebOriginApprovalLookup = lookupWebOriginApprovalInDatabase

/** Test-only: replace the database lookup. Pass null to restore it. Also clears the cache. */
export function setWebOriginApprovalLookupForTest(lookup: WebOriginApprovalLookup | null) {
  activeApprovalLookup = lookup ?? lookupWebOriginApprovalInDatabase
  invalidateWebOriginApprovalCache()
}

/** Organizations the user currently belongs to that approved `origin`, oldest membership first. */
type MemberWebOriginLookup = (input: { userId: UserId; origin: string }) => Promise<OrganizationId[]>

async function lookupMemberOrganizationsApprovingInDatabase(input: { userId: UserId; origin: string }) {
  const rows = await db
    .select({ organizationId: OrganizationWebOriginTable.organizationId })
    .from(OrganizationWebOriginTable)
    .innerJoin(MemberTable, and(
      eq(MemberTable.organizationId, OrganizationWebOriginTable.organizationId),
      eq(MemberTable.userId, input.userId),
      isNull(MemberTable.removedAt),
    ))
    .where(eq(OrganizationWebOriginTable.origin, input.origin))
    .orderBy(asc(MemberTable.createdAt))
    .limit(ORGANIZATION_WEB_ORIGIN_LIMIT)
  return rows.map((row) => row.organizationId)
}

let activeMemberLookup: MemberWebOriginLookup = lookupMemberOrganizationsApprovingInDatabase

/** Test-only: replace the member-scoped database lookup. Pass null to restore it. */
export function setMemberWebOriginLookupForTest(lookup: MemberWebOriginLookup | null) {
  activeMemberLookup = lookup ?? lookupMemberOrganizationsApprovingInDatabase
}

/**
 * Handoff check when the session's active organization did not approve the
 * origin (or the session has none yet, as with a fresh sign-in by someone in
 * several organizations): organizations the user belongs to that did. Uncached.
 */
export async function findMemberOrganizationsApprovingWebOrigin(userId: UserId, origin: string): Promise<OrganizationId[]> {
  if (!isCanonicalExactHttpsOrigin(origin)) return []
  return activeMemberLookup({ userId, origin })
}

function isCanonicalExactHttpsOrigin(origin: string) {
  return normalizeExactHttpsOrigin(origin) === origin
}

function isDuplicateEntry(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  if ("code" in error && error.code === "ER_DUP_ENTRY") return true
  if ("errno" in error && error.errno === 1062) return true
  return "cause" in error && error.cause !== error && isDuplicateEntry(error.cause)
}

/**
 * Drops cached CORS approvals on this process. Other Den API replicas keep
 * their entries until the TTL expires, so changes propagate within 30 seconds.
 */
export function invalidateWebOriginApprovalCache(origin?: string) {
  approvalCacheGeneration += 1
  if (origin === undefined) {
    approvalCache.clear()
    inFlightApprovals.clear()
    return
  }
  approvalCache.delete(origin)
  inFlightApprovals.delete(origin)
}

function rememberApproval(origin: string, approved: boolean) {
  approvalCache.delete(origin)
  approvalCache.set(origin, { approved, expiresAt: Date.now() + APPROVAL_CACHE_TTL_MS })
  while (approvalCache.size > APPROVAL_CACHE_MAX_ENTRIES) {
    const oldest = approvalCache.keys().next()
    if (oldest.done) break
    approvalCache.delete(oldest.value)
  }
}

/**
 * CORS check: true when any organization approved this exact origin. Results
 * (positive and negative) are cached per process for 30 seconds. Lookup
 * errors propagate uncached so callers can fail closed.
 */
export async function isWebOriginApprovedByAnyOrganization(origin: string): Promise<boolean> {
  if (!isCanonicalExactHttpsOrigin(origin)) return false

  const cached = approvalCache.get(origin)
  if (cached && cached.expiresAt > Date.now()) return cached.approved
  if (cached) approvalCache.delete(origin)

  const inFlight = inFlightApprovals.get(origin)
  if (inFlight) return inFlight

  const generation = approvalCacheGeneration
  const lookup = activeApprovalLookup({ origin }).then((approved) => {
    if (generation === approvalCacheGeneration) rememberApproval(origin, approved)
    return approved
  }).finally(() => {
    if (inFlightApprovals.get(origin) === lookup) inFlightApprovals.delete(origin)
  })
  inFlightApprovals.set(origin, lookup)
  return lookup
}

/** Handoff check: uncached, so a removal takes effect immediately on every replica. */
export async function isWebOriginApprovedForOrganization(organizationId: OrganizationId, origin: string): Promise<boolean> {
  if (!isCanonicalExactHttpsOrigin(origin)) return false
  return activeApprovalLookup({ origin, organizationId })
}

export async function listOrganizationWebOrigins(organizationId: OrganizationId): Promise<OrganizationWebOriginRecord[]> {
  const rows = await db
    .select({
      id: OrganizationWebOriginTable.id,
      origin: OrganizationWebOriginTable.origin,
      createdAt: OrganizationWebOriginTable.createdAt,
      userName: AuthUserTable.name,
      userEmail: AuthUserTable.email,
    })
    .from(OrganizationWebOriginTable)
    .leftJoin(MemberTable, eq(OrganizationWebOriginTable.createdByOrgMemberId, MemberTable.id))
    .leftJoin(AuthUserTable, eq(MemberTable.userId, AuthUserTable.id))
    .where(eq(OrganizationWebOriginTable.organizationId, organizationId))
    .orderBy(asc(OrganizationWebOriginTable.createdAt), asc(OrganizationWebOriginTable.id))

  return rows.map((row) => ({
    id: row.id,
    origin: row.origin,
    createdAt: row.createdAt,
    createdByName: row.userName?.trim() || row.userEmail?.trim() || null,
  }))
}

async function readCreatorName(memberId: MemberId) {
  const [row] = await db
    .select({ name: AuthUserTable.name, email: AuthUserTable.email })
    .from(MemberTable)
    .innerJoin(AuthUserTable, eq(MemberTable.userId, AuthUserTable.id))
    .where(eq(MemberTable.id, memberId))
    .limit(1)
  return row?.name?.trim() || row?.email?.trim() || null
}

/** `origin` must already be normalized with normalizeExactHttpsOrigin. */
export async function approveOrganizationWebOrigin(input: {
  organizationId: OrganizationId
  origin: string
  createdByOrgMemberId: MemberId
}): Promise<ApproveOrganizationWebOriginResult> {
  const id = createDenTypeId("organizationWebOrigin")
  const createdAt = new Date()

  let outcome: "created" | "already_approved" | "limit_reached"
  try {
    outcome = await db.transaction(async (tx) => {
      // The organization row is the serialization point for the per-org limit.
      await tx.select({ id: OrganizationTable.id }).from(OrganizationTable)
        .where(eq(OrganizationTable.id, input.organizationId)).for("update")

      const [existing] = await tx.select({ id: OrganizationWebOriginTable.id }).from(OrganizationWebOriginTable)
        .where(and(eq(OrganizationWebOriginTable.organizationId, input.organizationId), eq(OrganizationWebOriginTable.origin, input.origin)))
        .limit(1)
      if (existing) return "already_approved" as const

      const [total] = await tx.select({ value: count() }).from(OrganizationWebOriginTable)
        .where(eq(OrganizationWebOriginTable.organizationId, input.organizationId))
      if ((total?.value ?? 0) >= ORGANIZATION_WEB_ORIGIN_LIMIT) return "limit_reached" as const

      await tx.insert(OrganizationWebOriginTable).values({
        id,
        organizationId: input.organizationId,
        origin: input.origin,
        createdByOrgMemberId: input.createdByOrgMemberId,
        createdAt,
      })
      return "created" as const
    })
  } catch (error) {
    if (!isDuplicateEntry(error)) throw error
    outcome = "already_approved"
  }

  if (outcome !== "created") return { ok: false, reason: outcome }

  invalidateWebOriginApprovalCache(input.origin)
  return {
    ok: true,
    webOrigin: {
      id,
      origin: input.origin,
      createdAt,
      createdByName: await readCreatorName(input.createdByOrgMemberId),
    },
  }
}

/** Removes one approved origin from the organization. Returns the removed origin, or null when absent. */
export async function removeOrganizationWebOrigin(input: {
  organizationId: OrganizationId
  id: OrganizationWebOriginId
}): Promise<string | null> {
  const scope = and(eq(OrganizationWebOriginTable.id, input.id), eq(OrganizationWebOriginTable.organizationId, input.organizationId))
  const [row] = await db.select({ origin: OrganizationWebOriginTable.origin }).from(OrganizationWebOriginTable).where(scope).limit(1)
  if (!row) return null

  await db.delete(OrganizationWebOriginTable).where(scope)
  invalidateWebOriginApprovalCache(row.origin)
  return row.origin
}
