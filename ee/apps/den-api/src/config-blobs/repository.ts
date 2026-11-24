import { randomUUID } from "node:crypto"
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, lte, ne, or } from "@openwork-ee/den-db/drizzle"
import {
  AuthUserTable,
  ConfigApplyRunTable,
  ConfigBlobAliasTable,
  ConfigBlobExportTable,
  ConfigChangeRequestTable,
  MemberTable,
  OrganizationTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import {
  CONFIG_CHANGE_REQUEST_OPEN_STATUSES,
  type ConfigApplyReport,
  type ConfigAreaKey,
  type ConfigChangeRequestStatus,
  type ConfigChangeRequestSummary,
} from "@openwork/types/den/config-blobs"
import { db } from "../db.js"
import { interruptReport, summarizeReport } from "./engine/report.js"

export type ConfigChangeRequestRow = typeof ConfigChangeRequestTable.$inferSelect
export type ConfigChangeRequestInsert = typeof ConfigChangeRequestTable.$inferInsert
export type ConfigChangeRequestId = DenTypeId<"configChangeRequest">
export type ConfigBlobAliasRow = typeof ConfigBlobAliasTable.$inferSelect
export type ConfigBlobExportRow = typeof ConfigBlobExportTable.$inferSelect
export type ConfigApplyRunRow = typeof ConfigApplyRunTable.$inferSelect
export type ConfigApplyRunId = DenTypeId<"configApplyRun">
type OrganizationId = DenTypeId<"organization">
type MemberId = DenTypeId<"member">

export type ConfigTx = Parameters<Parameters<typeof db.transaction>[0]>[0]
export type ConfigDatabase = typeof db.$primary | ConfigTx

export const CONFIG_ANALYSIS_CLAIMABLE_STATUSES: readonly ConfigChangeRequestStatus[] = ["uploaded", "stale", "analyzing"]
export const CONFIG_APPLY_CLAIMABLE_STATUSES: readonly ConfigChangeRequestStatus[] = ["queued", "applying"]
export const CONFIG_APPLY_INTERRUPTED_ERROR = "The apply stopped part-way (the server restarted or lost its lock). Check the apply report, then fix and upload again, or restore the previous config."
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

export async function latestAppliedFromSource(
  organizationId: OrganizationId,
  source: { instanceId: string; organizationId: string },
  database: ConfigDatabase = db.$primary,
): Promise<Pick<ConfigChangeRequestRow, "id" | "decisions"> | null> {
  const rows = await database
    .select({ id: ConfigChangeRequestTable.id, decisions: ConfigChangeRequestTable.decisions })
    .from(ConfigChangeRequestTable)
    .where(and(
      eq(ConfigChangeRequestTable.organizationId, organizationId),
      eq(ConfigChangeRequestTable.status, "applied"),
      eq(ConfigChangeRequestTable.sourceInstanceId, source.instanceId),
      eq(ConfigChangeRequestTable.sourceOrgId, source.organizationId),
      ne(ConfigChangeRequestTable.sourceKind, "revert"),
      isNotNull(ConfigChangeRequestTable.decisions),
    ))
    .orderBy(desc(ConfigChangeRequestTable.appliedAt), desc(ConfigChangeRequestTable.id))
    .limit(1)
  return rows[0] ?? null
}

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

export async function listChangeRequestStatuses(
  organizationId: OrganizationId,
  ids: readonly ConfigChangeRequestId[],
  database: ConfigDatabase = db.$primary,
): Promise<Map<string, ConfigChangeRequestStatus>> {
  if (ids.length === 0) return new Map()
  const rows = await database
    .select({ id: ConfigChangeRequestTable.id, status: ConfigChangeRequestTable.status })
    .from(ConfigChangeRequestTable)
    .where(and(eq(ConfigChangeRequestTable.organizationId, organizationId), inArray(ConfigChangeRequestTable.id, [...new Set(ids)])))
  return new Map(rows.map((row) => [row.id, row.status]))
}

export type ChangeRequestPatch = Partial<Omit<ConfigChangeRequestInsert, "id" | "organizationId" | "createdAt" | "updatedAt">>

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
      if (row.status === "applying") {
        await tx.update(ConfigChangeRequestTable).set({
          status: "failed",
          errors: [CONFIG_APPLY_INTERRUPTED_ERROR],
          secretInputs: null,
          leaseOwner: null,
          leaseUntil: null,
        }).where(and(eq(ConfigChangeRequestTable.id, row.id), eq(ConfigChangeRequestTable.status, "applying")))
        await interruptRunningApplyRuns(row.organizationId, row.id, tx)
        await markOtherOpenRequestsStale(row.organizationId, row.id, tx)
        continue
      }
      if (triedOrgs.has(row.organizationId)) continue
      triedOrgs.add(row.organizationId)
      const [org] = await tx
        .select({ id: OrganizationTable.id })
        .from(OrganizationTable)
        .where(eq(OrganizationTable.id, row.organizationId))
        .for("update", { skipLocked: true })
      if (!org) continue
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

export const CONFIG_SUPERSEDABLE_STATUSES: readonly ConfigChangeRequestStatus[] = ["uploaded", "analyzing", "needs_review", "approved", "stale"]

export async function supersedeOpenRequestsFromApiKey(input: {
  organizationId: OrganizationId
  apiKeyId: string
  areas: readonly ConfigAreaKey[]
  exceptId: ConfigChangeRequestId
}, database: ConfigDatabase = db.$primary): Promise<ConfigChangeRequestId[]> {
  const scope = and(
    eq(ConfigChangeRequestTable.organizationId, input.organizationId),
    eq(ConfigChangeRequestTable.apiKeyId, input.apiKeyId),
    ne(ConfigChangeRequestTable.id, input.exceptId),
    inArray(ConfigChangeRequestTable.status, [...CONFIG_SUPERSEDABLE_STATUSES]),
  )
  const rows = await database.select({ id: ConfigChangeRequestTable.id, areas: ConfigChangeRequestTable.areas }).from(ConfigChangeRequestTable).where(scope)
  const wanted = [...new Set(input.areas)].sort().join(",")
  const ids = rows.filter((row) => [...new Set(row.areas)].sort().join(",") === wanted).map((row) => row.id)
  if (ids.length === 0) return []
  await database
    .update(ConfigChangeRequestTable)
    .set({ status: "superseded", secretInputs: null, leaseOwner: null, leaseUntil: null })
    .where(and(scope, inArray(ConfigChangeRequestTable.id, ids)))
  return ids
}

export const CONFIG_SECRET_INPUTS_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const CONFIG_SECRET_INPUT_EXPIRY_STATUSES: readonly ConfigChangeRequestStatus[] = ["needs_review", "approved", "stale", "queued"]

export async function expireSecretInputs(options: { now?: Date; limit?: number } = {}, database: ConfigDatabase = db.$primary): Promise<ConfigChangeRequestId[]> {
  const now = options.now ?? new Date()
  const scope = and(
    inArray(ConfigChangeRequestTable.status, [...CONFIG_SECRET_INPUT_EXPIRY_STATUSES]),
    lt(ConfigChangeRequestTable.createdAt, new Date(now.getTime() - CONFIG_SECRET_INPUTS_TTL_MS)),
    isNotNull(ConfigChangeRequestTable.secretInputs),
  )
  const rows = await database.select({ id: ConfigChangeRequestTable.id }).from(ConfigChangeRequestTable).where(scope).limit(options.limit ?? 50)
  if (rows.length === 0) return []
  const ids = rows.map((row) => row.id)
  await database
    .update(ConfigChangeRequestTable)
    .set({ secretInputs: null, status: "stale", approvals: [], approvedPlanHash: null, availableAt: new Date() })
    .where(and(scope, inArray(ConfigChangeRequestTable.id, ids)))
  return ids
}

export function summaryMemberIds(rows: ConfigChangeRequestSummaryRow[]): string[] {
  const ids = new Set<string>()
  for (const row of rows) {
    if (row.createdByMemberId) ids.add(row.createdByMemberId)
    for (const approval of row.approvals) ids.add(approval.memberId)
  }
  return [...ids]
}

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

export function aliasKey(area: ConfigAreaKey, sourceId: string): string {
  return `${area}:${sourceId}`
}

export async function listAliases(organizationId: OrganizationId, sourceInstanceId: string, database: ConfigDatabase = db): Promise<Map<string, string>> {
  const rows = await listAliasRows(organizationId, sourceInstanceId, database)
  return new Map(rows.map((row) => [aliasKey(row.area, row.sourceId), row.localId]))
}

export type ConfigAliasEntry = Pick<ConfigBlobAliasRow, "area" | "sourceId" | "localId" | "createdByChangeRequestId">

export async function listAliasRows(organizationId: OrganizationId, sourceInstanceId: string, database: ConfigDatabase = db): Promise<ConfigAliasEntry[]> {
  return database
    .select({ area: ConfigBlobAliasTable.area, sourceId: ConfigBlobAliasTable.sourceId, localId: ConfigBlobAliasTable.localId, createdByChangeRequestId: ConfigBlobAliasTable.createdByChangeRequestId })
    .from(ConfigBlobAliasTable)
    .where(and(eq(ConfigBlobAliasTable.organizationId, organizationId), eq(ConfigBlobAliasTable.sourceInstanceId, sourceInstanceId)))
}

export async function deleteAliasesForLocalIds(
  organizationId: OrganizationId,
  deleted: ReadonlyArray<{ area: ConfigAreaKey; localId: string }>,
  database: ConfigDatabase = db.$primary,
): Promise<number> {
  let removed = 0
  const byArea = new Map<ConfigAreaKey, string[]>()
  for (const entry of deleted) byArea.set(entry.area, [...(byArea.get(entry.area) ?? []), entry.localId])
  for (const [area, localIds] of byArea) {
    removed += affectedRows(await database.delete(ConfigBlobAliasTable).where(and(
      eq(ConfigBlobAliasTable.organizationId, organizationId),
      eq(ConfigBlobAliasTable.area, area),
      inArray(ConfigBlobAliasTable.localId, localIds),
    )))
  }
  return removed
}

export type AliasInput = {
  area: ConfigAreaKey
  sourceInstanceId: string
  sourceId: string
  localId: string
  createdByChangeRequestId: ConfigChangeRequestId | null
}

export async function insertAliases(organizationId: OrganizationId, aliases: AliasInput[], database: ConfigDatabase = db.$primary): Promise<void> {
  for (const alias of aliases) {
    await database
      .insert(ConfigBlobAliasTable)
      .values({ id: createDenTypeId("configBlobAlias"), organizationId, ...alias })
      .onDuplicateKeyUpdate({ set: { localId: alias.localId, createdByChangeRequestId: alias.createdByChangeRequestId } })
  }
}

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

function failureColumns(report: ConfigApplyReport) {
  return {
    failureArea: report.failure?.area ?? null,
    failureRef: report.failure ? report.failure.ref.slice(0, 200) : null,
    failureCode: report.failure ? report.failure.failure.code.slice(0, 100) : null,
  }
}

export type CreateApplyRunInput = {
  organizationId: OrganizationId
  changeRequestId: ConfigChangeRequestId
  requestedByMemberId: MemberId | null
  requestedByApiKeyId: string | null
  runsAsMemberId: MemberId | null
  report: ConfigApplyReport
  startedAt: Date
}

export async function createApplyRun(input: CreateApplyRunInput, database: ConfigDatabase = db.$primary): Promise<ConfigApplyRunRow> {
  const id = createDenTypeId("configApplyRun")
  const previous = await database
    .select({ attempt: ConfigApplyRunTable.attempt })
    .from(ConfigApplyRunTable)
    .where(eq(ConfigApplyRunTable.changeRequestId, input.changeRequestId))
    .orderBy(desc(ConfigApplyRunTable.attempt))
    .limit(1)
  const attempt = (previous[0]?.attempt ?? 0) + 1
  const report = summarizeReport({ ...input.report, runId: id, attempt, status: "running" })
  await database.insert(ConfigApplyRunTable).values({
    id,
    organizationId: input.organizationId,
    changeRequestId: input.changeRequestId,
    attempt,
    status: "running",
    requestedByMemberId: input.requestedByMemberId,
    requestedByApiKeyId: input.requestedByApiKeyId,
    runsAsMemberId: input.runsAsMemberId,
    report,
    ...failureColumns(report),
    startedAt: input.startedAt,
  })
  const row = await getApplyRun(input.organizationId, input.changeRequestId, id, database)
  if (!row) throw new Error("config_apply_run_insert_lost")
  return row
}

export async function saveApplyRunReport(
  run: Pick<ConfigApplyRunRow, "id" | "organizationId">,
  report: ConfigApplyReport,
  database: ConfigDatabase = db.$primary,
): Promise<boolean> {
  const summarized = summarizeReport(report)
  const finishedAt = summarized.finishedAt ? new Date(summarized.finishedAt) : null
  const result = await database
    .update(ConfigApplyRunTable)
    .set({ report: summarized, status: summarized.status, finishedAt, ...failureColumns(summarized) })
    .where(and(eq(ConfigApplyRunTable.organizationId, run.organizationId), eq(ConfigApplyRunTable.id, run.id), eq(ConfigApplyRunTable.status, "running")))
  if (affectedRows(result) > 0) return true
  await database
    .update(ConfigApplyRunTable)
    .set({ report: { ...summarized, status: "interrupted" }, ...failureColumns(summarized) })
    .where(and(eq(ConfigApplyRunTable.organizationId, run.organizationId), eq(ConfigApplyRunTable.id, run.id), eq(ConfigApplyRunTable.status, "interrupted")))
  return false
}

export async function getApplyRun(
  organizationId: OrganizationId,
  changeRequestId: ConfigChangeRequestId,
  id: ConfigApplyRunId,
  database: ConfigDatabase = db,
): Promise<ConfigApplyRunRow | null> {
  const rows = await database
    .select()
    .from(ConfigApplyRunTable)
    .where(and(eq(ConfigApplyRunTable.organizationId, organizationId), eq(ConfigApplyRunTable.changeRequestId, changeRequestId), eq(ConfigApplyRunTable.id, id)))
    .limit(1)
  return rows[0] ?? null
}

export async function listApplyRuns(organizationId: OrganizationId, changeRequestId: ConfigChangeRequestId, database: ConfigDatabase = db): Promise<ConfigApplyRunRow[]> {
  return database
    .select()
    .from(ConfigApplyRunTable)
    .where(and(eq(ConfigApplyRunTable.organizationId, organizationId), eq(ConfigApplyRunTable.changeRequestId, changeRequestId)))
    .orderBy(desc(ConfigApplyRunTable.attempt))
    .limit(50)
}

export async function latestApplyRun(organizationId: OrganizationId, changeRequestId: ConfigChangeRequestId, database: ConfigDatabase = db): Promise<ConfigApplyRunRow | null> {
  const rows = await database
    .select()
    .from(ConfigApplyRunTable)
    .where(and(eq(ConfigApplyRunTable.organizationId, organizationId), eq(ConfigApplyRunTable.changeRequestId, changeRequestId)))
    .orderBy(desc(ConfigApplyRunTable.attempt))
    .limit(1)
  return rows[0] ?? null
}

export async function interruptRunningApplyRuns(organizationId: OrganizationId, changeRequestId: ConfigChangeRequestId, database: ConfigDatabase = db.$primary): Promise<number> {
  const running = await database
    .select()
    .from(ConfigApplyRunTable)
    .where(and(eq(ConfigApplyRunTable.organizationId, organizationId), eq(ConfigApplyRunTable.changeRequestId, changeRequestId), eq(ConfigApplyRunTable.status, "running")))
  const now = new Date()
  for (const run of running) {
    const report = interruptReport(run.report, now, CONFIG_APPLY_INTERRUPTED_ERROR)
    await database
      .update(ConfigApplyRunTable)
      .set({ report, status: "interrupted", finishedAt: now, ...failureColumns(report) })
      .where(and(eq(ConfigApplyRunTable.id, run.id), eq(ConfigApplyRunTable.status, "running")))
  }
  return running.length
}
