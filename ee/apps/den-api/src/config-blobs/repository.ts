/**
 * Storage for config blobs: change requests (a table-as-queue with leases, as
 * in `slack-assistant/repository.ts`), alias rows and recent exports.
 * Business rules (what a status transition means) live in the engine; this
 * file only reads and writes rows, with optimistic status guards.
 */
import { randomUUID } from "node:crypto"
import { and, asc, desc, eq, gt, inArray, isNull, lte, ne, or } from "@openwork-ee/den-db/drizzle"
import {
  AuthUserTable,
  ConfigBlobAliasTable,
  ConfigBlobExportTable,
  ConfigChangeRequestTable,
  MemberTable,
  OrganizationTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import {
  CONFIG_CHANGE_REQUEST_OPEN_STATUSES,
  type ConfigAreaKey,
  type ConfigChangeRequestStatus,
  type ConfigChangeRequestSummary,
} from "@openwork/types/den/config-blobs"
import { db } from "../db.js"

export type ConfigChangeRequestRow = typeof ConfigChangeRequestTable.$inferSelect
export type ConfigChangeRequestInsert = typeof ConfigChangeRequestTable.$inferInsert
export type ConfigChangeRequestId = DenTypeId<"configChangeRequest">
export type ConfigBlobAliasRow = typeof ConfigBlobAliasTable.$inferSelect
export type ConfigBlobExportRow = typeof ConfigBlobExportTable.$inferSelect
type OrganizationId = DenTypeId<"organization">
type MemberId = DenTypeId<"member">

export type ConfigTx = Parameters<Parameters<typeof db.transaction>[0]>[0]
/** `db`, `db.$primary` or a transaction. */
export type ConfigDatabase = typeof db.$primary | ConfigTx

/** Statuses the analysis worker picks up. `analyzing` only once its lease expired (a crashed worker). */
export const CONFIG_ANALYSIS_CLAIMABLE_STATUSES: readonly ConfigChangeRequestStatus[] = ["uploaded", "stale", "analyzing"]
/** Statuses the apply worker picks up. `applying` only once its lease expired. */
export const CONFIG_APPLY_CLAIMABLE_STATUSES: readonly ConfigChangeRequestStatus[] = ["queued", "applying"]
/** Open statuses that go `stale` when another request of the org is applied. */
export const CONFIG_STALEABLE_STATUSES: readonly ConfigChangeRequestStatus[] = ["needs_review", "approved", "queued"]
export const CONFIG_CLOSED_STATUSES: readonly ConfigChangeRequestStatus[] = ["invalid", "applied", "failed", "superseded", "cancelled"]
export const CONFIG_BLOB_EXPORTS_KEPT = 20
const ANALYSIS_LEASE_MS = 120_000
const APPLY_LEASE_MS = 600_000
const CLAIM_CANDIDATES = 10

function affectedRows(result: unknown): number {
  if (Array.isArray(result)) return affectedRows(result[0])
  if (typeof result !== "object" || result === null) return 0
  if ("rowsAffected" in result && typeof result.rowsAffected === "number") return result.rowsAffected
  if ("affectedRows" in result && typeof result.affectedRows === "number") return result.affectedRows
  return 0
}

// ---------------------------------------------------------------------------
// Change requests

export type CreateChangeRequestInput = Omit<ConfigChangeRequestInsert, "id" | "approvals" | "errors" | "createdAt" | "updatedAt"> & {
  errors?: string[]
}

export async function createChangeRequest(input: CreateChangeRequestInput, database: ConfigDatabase = db.$primary): Promise<ConfigChangeRequestRow> {
  const id = createDenTypeId("configChangeRequest")
  await database.insert(ConfigChangeRequestTable).values({ ...input, id, approvals: [], errors: input.errors ?? [] })
  const row = await getChangeRequest(input.organizationId, id, database)
  if (!row) throw new Error("config_change_request_insert_lost")
  return row
}

export async function getChangeRequest(
  organizationId: OrganizationId,
  id: ConfigChangeRequestId,
  database: ConfigDatabase = db,
): Promise<ConfigChangeRequestRow | null> {
  const rows = await database
    .select()
    .from(ConfigChangeRequestTable)
    .where(and(eq(ConfigChangeRequestTable.organizationId, organizationId), eq(ConfigChangeRequestTable.id, id)))
    .limit(1)
  return rows[0] ?? null
}

/** The columns a summary needs: leaves the blob, secret inputs and snapshot encrypted and unread. */
const summaryColumns = {
  id: ConfigChangeRequestTable.id,
  organizationId: ConfigChangeRequestTable.organizationId,
  status: ConfigChangeRequestTable.status,
  title: ConfigChangeRequestTable.title,
  mode: ConfigChangeRequestTable.mode,
  sourceKind: ConfigChangeRequestTable.sourceKind,
  createdByMemberId: ConfigChangeRequestTable.createdByMemberId,
  apiKeyName: ConfigChangeRequestTable.apiKeyName,
  sourceOrgId: ConfigChangeRequestTable.sourceOrgId,
  sourceOrgSlug: ConfigChangeRequestTable.sourceOrgSlug,
  sourceOrgName: ConfigChangeRequestTable.sourceOrgName,
  sourceDeployment: ConfigChangeRequestTable.sourceDeployment,
  areas: ConfigChangeRequestTable.areas,
  plan: ConfigChangeRequestTable.plan,
  planHash: ConfigChangeRequestTable.planHash,
  approvals: ConfigChangeRequestTable.approvals,
  autoApply: ConfigChangeRequestTable.autoApply,
  revertsChangeRequestId: ConfigChangeRequestTable.revertsChangeRequestId,
  revertedByChangeRequestId: ConfigChangeRequestTable.revertedByChangeRequestId,
  errors: ConfigChangeRequestTable.errors,
  createdAt: ConfigChangeRequestTable.createdAt,
  updatedAt: ConfigChangeRequestTable.updatedAt,
  appliedAt: ConfigChangeRequestTable.appliedAt,
}
export type ConfigChangeRequestSummaryRow = Pick<ConfigChangeRequestRow, keyof typeof summaryColumns>

export async function listChangeRequests(
  organizationId: OrganizationId,
  options: { state: "open" | "closed"; limit?: number },
): Promise<ConfigChangeRequestSummaryRow[]> {
  const statuses = options.state === "open" ? CONFIG_CHANGE_REQUEST_OPEN_STATUSES : CONFIG_CLOSED_STATUSES
  return db
    .select(summaryColumns)
    .from(ConfigChangeRequestTable)
    .where(and(eq(ConfigChangeRequestTable.organizationId, organizationId), inArray(ConfigChangeRequestTable.status, [...statuses])))
    .orderBy(desc(ConfigChangeRequestTable.createdAt), desc(ConfigChangeRequestTable.id))
    .limit(options.limit ?? 100)
}

export type ChangeRequestPatch = Partial<Omit<ConfigChangeRequestInsert, "id" | "organizationId" | "createdAt" | "updatedAt">>

/**
 * Updates a request only while its status is one of `from` (optimistic guard).
 * Returns the updated row, or null when the request moved on or does not exist.
 */
export async function updateChangeRequest(
  organizationId: OrganizationId,
  id: ConfigChangeRequestId,
  from: readonly ConfigChangeRequestStatus[],
  patch: ChangeRequestPatch,
  database: ConfigDatabase = db.$primary,
): Promise<ConfigChangeRequestRow | null> {
  const result = await database
    .update(ConfigChangeRequestTable)
    .set(patch)
    .where(and(
      eq(ConfigChangeRequestTable.organizationId, organizationId),
      eq(ConfigChangeRequestTable.id, id),
      inArray(ConfigChangeRequestTable.status, [...from]),
    ))
  if (affectedRows(result) === 0) return null
  return getChangeRequest(organizationId, id, database)
}

export type ClaimedChangeRequest = ConfigChangeRequestRow & { leaseOwner: string }

/**
 * Finishes a claimed step: applies `patch`, clears the lease. Guarded by the
 * lease owner so a worker whose lease expired cannot overwrite a newer claim.
 */
export async function releaseClaim(
  claim: Pick<ClaimedChangeRequest, "id" | "leaseOwner">,
  patch: ChangeRequestPatch,
  database: ConfigDatabase = db.$primary,
): Promise<boolean> {
  const result = await database
    .update(ConfigChangeRequestTable)
    .set({ ...patch, leaseOwner: null, leaseUntil: null })
    .where(and(eq(ConfigChangeRequestTable.id, claim.id), eq(ConfigChangeRequestTable.leaseOwner, claim.leaseOwner)))
  return affectedRows(result) > 0
}

/** Pushes a live claim's lease forward; false when the lease was lost. */
export async function extendClaim(claim: Pick<ClaimedChangeRequest, "id" | "leaseOwner">, leaseMs: number): Promise<boolean> {
  const result = await db.$primary
    .update(ConfigChangeRequestTable)
    .set({ leaseUntil: new Date(Date.now() + leaseMs) })
    .where(and(eq(ConfigChangeRequestTable.id, claim.id), eq(ConfigChangeRequestTable.leaseOwner, claim.leaseOwner)))
  return affectedRows(result) > 0
}

function claimableWhere(statuses: readonly ConfigChangeRequestStatus[], now: Date) {
  return and(
    inArray(ConfigChangeRequestTable.status, [...statuses]),
    lte(ConfigChangeRequestTable.availableAt, now),
    or(isNull(ConfigChangeRequestTable.leaseUntil), lte(ConfigChangeRequestTable.leaseUntil, now)),
  )
}

/** Claims the next request to analyze (any org) and marks it `analyzing`. */
export async function claimNextAnalysis(options: { leaseMs?: number } = {}): Promise<ClaimedChangeRequest | null> {
  return db.transaction(async (tx) => {
    const now = new Date()
    const [row] = await tx
      .select()
      .from(ConfigChangeRequestTable)
      .where(claimableWhere(CONFIG_ANALYSIS_CLAIMABLE_STATUSES, now))
      .orderBy(asc(ConfigChangeRequestTable.availableAt), asc(ConfigChangeRequestTable.id))
      .limit(1)
      .for("update", { skipLocked: true })
    if (!row) return null
    const claim = { leaseOwner: randomUUID(), leaseUntil: new Date(now.getTime() + (options.leaseMs ?? ANALYSIS_LEASE_MS)), status: "analyzing" as const, attempts: row.attempts + 1 }
    await tx.update(ConfigChangeRequestTable).set(claim).where(eq(ConfigChangeRequestTable.id, row.id))
    return { ...row, ...claim }
  })
}

/**
 * Claims the next request to apply and marks it `applying`. Only one request
 * per org applies at a time: a candidate is skipped while another request of
 * its org is `applying` with a live lease. The org row is locked (SKIP LOCKED,
 * so claims never wait on each other) while that is checked, which serializes
 * concurrent claims for the same org without deadlocks.
 */
export async function claimNextApply(options: { leaseMs?: number } = {}): Promise<ClaimedChangeRequest | null> {
  return db.transaction(async (tx) => {
    const now = new Date()
    const candidates = await tx
      .select()
      .from(ConfigChangeRequestTable)
      .where(claimableWhere(CONFIG_APPLY_CLAIMABLE_STATUSES, now))
      .orderBy(asc(ConfigChangeRequestTable.availableAt), asc(ConfigChangeRequestTable.id))
      .limit(CLAIM_CANDIDATES)
      .for("update", { skipLocked: true })
    const triedOrgs = new Set<string>()
    for (const row of candidates) {
      if (triedOrgs.has(row.organizationId)) continue
      triedOrgs.add(row.organizationId)
      const [org] = await tx
        .select({ id: OrganizationTable.id })
        .from(OrganizationTable)
        .where(eq(OrganizationTable.id, row.organizationId))
        .for("update", { skipLocked: true })
      if (!org) continue
      // A locking read sees the latest committed rows, not the transaction's snapshot.
      const [busy] = await tx
        .select({ id: ConfigChangeRequestTable.id })
        .from(ConfigChangeRequestTable)
        .where(and(
          eq(ConfigChangeRequestTable.organizationId, row.organizationId),
          eq(ConfigChangeRequestTable.status, "applying"),
          ne(ConfigChangeRequestTable.id, row.id),
          gt(ConfigChangeRequestTable.leaseUntil, now),
        ))
        .limit(1)
        .for("update")
      if (busy) continue
      const claim = { leaseOwner: randomUUID(), leaseUntil: new Date(now.getTime() + (options.leaseMs ?? APPLY_LEASE_MS)), status: "applying" as const, attempts: row.attempts + 1 }
      await tx.update(ConfigChangeRequestTable).set(claim).where(eq(ConfigChangeRequestTable.id, row.id))
      return { ...row, ...claim }
    }
    return null
  })
}

/**
 * After an apply: every other open request of the org that was planned or
 * approved goes `stale` (re-analyzed, approval dropped). Returns their ids.
 */
export async function markOtherOpenRequestsStale(
  organizationId: OrganizationId,
  exceptId: ConfigChangeRequestId,
  database: ConfigDatabase = db.$primary,
): Promise<ConfigChangeRequestId[]> {
  const scope = and(
    eq(ConfigChangeRequestTable.organizationId, organizationId),
    ne(ConfigChangeRequestTable.id, exceptId),
    inArray(ConfigChangeRequestTable.status, [...CONFIG_STALEABLE_STATUSES]),
  )
  const rows = await database.select({ id: ConfigChangeRequestTable.id }).from(ConfigChangeRequestTable).where(scope)
  if (rows.length === 0) return []
  const ids = rows.map((row) => row.id)
  await database
    .update(ConfigChangeRequestTable)
    .set({ status: "stale", approvals: [], approvedPlanHash: null, availableAt: new Date() })
    .where(and(scope, inArray(ConfigChangeRequestTable.id, ids)))
  return ids
}

// ---------------------------------------------------------------------------
// Summaries

/** Member ids a list of summaries needs names for (creators and approvers). */
export function summaryMemberIds(rows: ConfigChangeRequestSummaryRow[]): string[] {
  const ids = new Set<string>()
  for (const row of rows) {
    if (row.createdByMemberId) ids.add(row.createdByMemberId)
    for (const approval of row.approvals) ids.add(approval.memberId)
  }
  return [...ids]
}

/** Display names of the org's members (user name; null when the member has no user). */
export async function loadMemberNames(organizationId: OrganizationId, memberIds: string[]): Promise<Map<string, string | null>> {
  const names = new Map<string, string | null>()
  if (memberIds.length === 0) return names
  const rows = await db
    .select({ id: MemberTable.id, name: AuthUserTable.name })
    .from(MemberTable)
    .leftJoin(AuthUserTable, eq(AuthUserTable.id, MemberTable.userId))
    .where(and(eq(MemberTable.organizationId, organizationId), inArray(MemberTable.id, memberIds.filter(isMemberId))))
  for (const row of rows) names.set(row.id, row.name ?? null)
  return names
}

function isMemberId(value: string): value is MemberId {
  return value.startsWith("om_")
}

export function toChangeRequestSummary(row: ConfigChangeRequestSummaryRow, names: Map<string, string | null>): ConfigChangeRequestSummary {
  return {
    id: row.id,
    status: row.status,
    title: row.title,
    mode: row.mode,
    source: row.sourceKind,
    sourceOrganization: row.sourceOrgId
      ? { id: row.sourceOrgId, slug: row.sourceOrgSlug ?? "", name: row.sourceOrgName ?? "" }
      : null,
    sourceDeployment: row.sourceDeployment,
    areas: row.areas,
    summary: row.plan?.summary ?? null,
    planHash: row.planHash,
    approvals: row.approvals.map((approval) => ({ memberId: approval.memberId, name: names.get(approval.memberId) ?? null, at: approval.at })),
    autoApply: row.autoApply,
    createdBy: {
      memberId: row.createdByMemberId,
      name: row.createdByMemberId ? names.get(row.createdByMemberId) ?? null : null,
      apiKeyName: row.apiKeyName,
    },
    revertsChangeRequestId: row.revertsChangeRequestId,
    revertedByChangeRequestId: row.revertedByChangeRequestId,
    errors: row.errors,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    appliedAt: row.appliedAt?.toISOString() ?? null,
  }
}

// ---------------------------------------------------------------------------
// Aliases

export function aliasKey(area: ConfigAreaKey, sourceId: string): string {
  return `${area}:${sourceId}`
}

/** `${area}:${sourceId}` → local id, for one source instance. */
export async function listAliases(organizationId: OrganizationId, sourceInstanceId: string, database: ConfigDatabase = db): Promise<Map<string, string>> {
  const rows = await database
    .select({ area: ConfigBlobAliasTable.area, sourceId: ConfigBlobAliasTable.sourceId, localId: ConfigBlobAliasTable.localId })
    .from(ConfigBlobAliasTable)
    .where(and(eq(ConfigBlobAliasTable.organizationId, organizationId), eq(ConfigBlobAliasTable.sourceInstanceId, sourceInstanceId)))
  return new Map(rows.map((row) => [aliasKey(row.area, row.sourceId), row.localId]))
}

export type AliasInput = {
  area: ConfigAreaKey
  sourceInstanceId: string
  sourceId: string
  localId: string
  createdByChangeRequestId: ConfigChangeRequestId | null
}

/** Records aliases; a second alias for the same source item replaces the first. */
export async function insertAliases(organizationId: OrganizationId, aliases: AliasInput[], database: ConfigDatabase = db.$primary): Promise<void> {
  for (const alias of aliases) {
    await database
      .insert(ConfigBlobAliasTable)
      .values({ id: createDenTypeId("configBlobAlias"), organizationId, ...alias })
      .onDuplicateKeyUpdate({ set: { localId: alias.localId, createdByChangeRequestId: alias.createdByChangeRequestId } })
  }
}

// ---------------------------------------------------------------------------
// Exports

/** Keeps a copy of an export (the three-way base) and prunes the org's older ones. */
export async function recordExport(input: {
  organizationId: OrganizationId
  baseHash: string
  areas: ConfigAreaKey[]
  blob: unknown
}): Promise<DenTypeId<"configBlobExport">> {
  const id = createDenTypeId("configBlobExport")
  await db.$primary.insert(ConfigBlobExportTable).values({ id, ...input })
  await pruneExports(input.organizationId)
  return id
}

export async function findExportByBaseHash(organizationId: OrganizationId, baseHash: string): Promise<ConfigBlobExportRow | null> {
  const rows = await db
    .select()
    .from(ConfigBlobExportTable)
    .where(and(eq(ConfigBlobExportTable.organizationId, organizationId), eq(ConfigBlobExportTable.baseHash, baseHash)))
    .orderBy(desc(ConfigBlobExportTable.createdAt), desc(ConfigBlobExportTable.id))
    .limit(1)
  return rows[0] ?? null
}

/** Deletes all but the newest `keep` exports of the org. Returns how many went. */
export async function pruneExports(organizationId: OrganizationId, keep = CONFIG_BLOB_EXPORTS_KEPT): Promise<number> {
  const old = await db.$primary
    .select({ id: ConfigBlobExportTable.id })
    .from(ConfigBlobExportTable)
    .where(eq(ConfigBlobExportTable.organizationId, organizationId))
    .orderBy(desc(ConfigBlobExportTable.createdAt), desc(ConfigBlobExportTable.id))
    .limit(1000)
    .offset(keep)
  if (old.length === 0) return 0
  return affectedRows(await db.$primary.delete(ConfigBlobExportTable).where(inArray(ConfigBlobExportTable.id, old.map((row) => row.id))))
}
