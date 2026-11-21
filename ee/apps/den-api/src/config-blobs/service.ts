import { and, eq, getTableConfig, MySqlTable, sql } from "@openwork-ee/den-db/drizzle"
import * as denSchema from "@openwork-ee/den-db/schema"
import { AuditEventResourceTable, AuthApiKeyTable, AuthUserTable, InvitationTable, MemberTable, OrganizationTable } from "@openwork-ee/den-db/schema"
import type { ConfigChangeRequestApplyRequest, ConfigChangeRequestApproval } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import type { AuditActor, AuditEventInput, AuditOrigin } from "@openwork-ee/den-db/audit-log"
import {
  CONFIG_AREA_KEYS,
  CONFIG_BLOB_FORMAT,
  CONFIG_BLOB_FORMAT_VERSION,
  CONFIG_BLOB_MAX_BYTES,
  CONFIG_CHANGE_REQUEST_OPEN_STATUSES,
  CONFIG_DECISIONS_FILE_FORMAT,
  EMPTY_CONFIG_DECISIONS,
  configBlobSchema,
  flattenConfigAreas,
  isConfigRef,
  isConfigSecret,
  nestConfigAreas,
  parseConfigRef,
  type ConfigApplyFailure,
  type ConfigApplyReport,
  type ConfigApplyReportItem,
  type ConfigApplyRunResponse,
  type ConfigAreaKey,
  type ConfigAreasResponse,
  type ConfigBlob,
  type ConfigBlobArea,
  type ConfigBlobItem,
  type ConfigBlobSecretIndexEntry,
  type ConfigBlobSettings,
  type ConfigChangeRequestDetailResponse,
  type ConfigChangeRequestStatus,
  type ConfigChangeRequestSummary,
  type ConfigDecisions,
  type ConfigDecisionsFile,
  type ConfigDeployment,
  type ConfigImportMode,
  type ConfigPlan,
  type ConfigSecretInput,
  type ConfigSpec,
  type ResolvedConfigSecret,
} from "@openwork/types/den/config-blobs"
import { readOrganizationMetadata } from "@openwork/types/den/managed-models-policy"
import type { PermissionKey } from "@openwork/types/den/permissions"
import { auditText } from "../audit/domain/snapshot.js"
import { recordAuditJobOutcome } from "../audit/job-capture.js"
import { CONFIG_BLOB_APPLY_JOB_KIND } from "../audit/job-outcomes.js"
import {
  auditUserPrincipalKey,
  readEffectiveAuditPolicyWithRetry,
  runWithAuditJobChangeCapture,
  type AuditChangeCapture,
} from "../audit/request-capture.js"
import { getApiKeySessionById } from "../api-keys.js"
import { db } from "../db.js"
import { env } from "../env.js"
import { getOrganizationFeatures, type FeatureMap } from "../features.js"
import { appLogger } from "../observability/logger.js"
import { updateOrganizationMetadata } from "../organization-metadata.js"
import { resolvePermissionsForMember } from "../permissions/resolve.js"
import type { ConfigActor, ConfigArea, ConfigAreaContext, ConfigItem } from "./area.js"
import { ConfigApplyError } from "./areas/route-support.js"
import {
  baseHash as computeBaseHash,
  buildPlan,
  planRefTargets,
  checkWrittenItems,
  CONFIG_APPLY_INTERRUPTED_CODE,
  emptyApplyCounts,
  executePlan,
  findSecrets,
  parseStoredExecution,
  pendingReportItems,
  readItemsFor,
  runPreflight,
  summarizeReport,
  secretsNeedingValues,
  itemRev,
  unsupportedReason,
  withInviteEmails,
  createPeopleRedactor,
  type ExecutionPlan,
  type PeopleRedactor,
} from "./engine/index.js"
import { configSecretEnvPolicy, readConfigSecretEnv } from "./env-secrets.js"
import { getConfigInstanceId } from "./instance.js"
import { configBlobSchemaUrl } from "./json-schema.js"
import { CONFIG_AREAS, getConfigArea } from "./registry.js"
import {
  CONFIG_APPLY_INTERRUPTED_ERROR,
  createApplyRun,
  createChangeRequest,
  extendClaim,
  getApplyRun,
  listApplyRuns,
  saveApplyRunReport,
  findExportByBaseHash,
  getChangeRequest,
  deleteAliasesForLocalIds,
  insertAliases,
  latestAppliedFromSource,
  listAliasRows,
  listChangeRequests,
  listChangeRequestStatuses,
  loadMemberNames,
  markOtherOpenRequestsStale,
  recordExport,
  releaseClaim,
  summaryMemberIds,
  supersedeOpenRequestsFromApiKey,
  toChangeRequestSummary,
  updateChangeRequest,
  type ChangeRequestPatch,
  type ConfigAliasEntry,
  type ConfigApplyRunId,
  type ClaimedChangeRequest,
  type ConfigChangeRequestId,
  type ConfigChangeRequestRow,
} from "./repository.js"

type OrganizationId = DenTypeId<"organization">
type MemberId = DenTypeId<"member">

const logger = appLogger.child({ component: "config_blobs" })
const SETTINGS_METADATA_KEY = "configBlobs"
const PEOPLE_AREA_KEY: ConfigAreaKey = "members.people"
const APPLY_LEASE_MS = 600_000
const APPLY_LEASE_EXTEND_EVERY_MS = 60_000
const MAX_ANALYSIS_ATTEMPTS = 3

export class ConfigBlobError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 503,
    readonly body: { error: string; message?: string; [key: string]: unknown },
    readonly headers: Record<string, string> = {},
  ) {
    super(body.message ?? body.error)
    this.name = "ConfigBlobError"
  }
}

export type ConfigCaller = ConfigActor & {
  apiKeyId: string | null
  can: (key: PermissionKey) => boolean
  tokenAreas: readonly string[] | null
  authorize: (keys: readonly PermissionKey[]) => Promise<void>
  requireApprovalStepUp: () => void
}

export type ConfigOrganization = { id: OrganizationId; slug: string; name: string; features: FeatureMap }

function registeredArea(key: ConfigAreaKey): ConfigArea | null {
  return CONFIG_AREAS.find((area) => area.key === key) ?? null
}

function areaLabel(key: ConfigAreaKey): string {
  return registeredArea(key)?.label ?? key
}

function tokenAllows(tokenAreas: readonly string[] | null, area: ConfigAreaKey): boolean {
  if (tokenAreas === null) return true
  return tokenAreas.some((entry) => entry === area || (entry.endsWith(".*") && area.startsWith(entry.slice(0, -1))))
}

function canView(caller: Pick<ConfigCaller, "can" | "tokenAreas">, area: ConfigAreaKey): boolean {
  const definition = registeredArea(area)
  return definition !== null && caller.can(definition.viewPermission) && tokenAllows(caller.tokenAreas, area)
}

function canImport(caller: Pick<ConfigCaller, "can" | "tokenAreas">, area: ConfigAreaKey): boolean {
  const definition = registeredArea(area)
  return definition !== null && caller.can(definition.managePermission) && caller.can(definition.viewPermission) && tokenAllows(caller.tokenAreas, area)
}

function missingImportPermissions(caller: Pick<ConfigCaller, "can">, areas: readonly ConfigAreaKey[]): PermissionKey[] {
  return [...new Set(areas.flatMap((area) => {
    const definition = registeredArea(area)
    return definition ? [definition.viewPermission, definition.managePermission].filter((key) => !caller.can(key)) : []
  }))]
}

async function authorizeWrites(caller: ConfigCaller, areas: readonly ConfigAreaKey[]): Promise<void> {
  const outside = areas.filter((area) => !tokenAllows(caller.tokenAreas, area))
  if (outside.length > 0) {
    throw new ConfigBlobError(403, {
      error: "forbidden",
      message: `This config token can't change ${outside.map(areaLabel).join(", ")}.`,
      areas: outside,
    })
  }
  await caller.authorize(managePermissions(areas))
}

function managePermissions(areas: readonly ConfigAreaKey[]): PermissionKey[] {
  return [...new Set(areas.flatMap((area) => {
    const definition = registeredArea(area)
    return definition ? [definition.managePermission] : []
  }))]
}

function configDeployment(): ConfigDeployment {
  return env.features.deployment
}

function configAllowEnv(): (name: string) => boolean {
  return configSecretEnvPolicy(configDeployment(), env.configBlobs.secretEnvAllowlist)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const STORED_ERROR_MAX = 500

export function storedError(message: string): string {
  const line = message.replace(/[\u0000-\u001f\u007f]+/g, " ").trim()
  const bounded = line.length > STORED_ERROR_MAX ? `${line.slice(0, STORED_ERROR_MAX - 1)}…` : line
  return auditText(bounded, STORED_ERROR_MAX) ?? ""
}

function storedErrors(messages: readonly string[]): string[] {
  return messages.map(storedError)
}

export function describeAreas(org: Pick<ConfigOrganization, "features">, caller: Pick<ConfigCaller, "can" | "tokenAreas">): ConfigAreasResponse {
  const deployment = configDeployment()
  return {
    deployment,
    allowEnvSecrets: deployment === "self_hosted" && env.configBlobs.secretEnvAllowlist.length > 0,
    areas: CONFIG_AREAS.map((area) => {
      const unsupported = unsupportedReason(area, deployment, org.features)
      return {
        key: area.key,
        label: area.label,
        path: area.path,
        specVersion: area.specVersion,
        supported: unsupported === null,
        ...(unsupported ? { unsupportedReason: unsupported } : {}),
        canExport: unsupported === null && canView(caller, area.key),
        canImport: unsupported === null && canImport(caller, area.key),
        containsConfidentialContent: area.containsConfidentialContent === true,
        secretFields: [...area.secretFields],
      }
    }),
  }
}

export function parseAreaList(value: string | undefined | null): ConfigAreaKey[] | null {
  if (!value || !value.trim()) return null
  const wanted = value.split(",").map((entry) => entry.trim()).filter(Boolean)
  const unknown = wanted.filter((entry) => !(CONFIG_AREA_KEYS as readonly string[]).includes(entry))
  if (unknown.length > 0) throw new ConfigBlobError(400, { error: "unknown_area", message: `Unknown config area: ${unknown.join(", ")}.`, areas: unknown })
  return CONFIG_AREA_KEYS.filter((key) => wanted.includes(key))
}

function areaContext(organizationId: string, actor: ConfigActor, features: FeatureMap): ConfigAreaContext {
  const acting: ConfigActor = { userId: actor.userId, memberId: actor.memberId }
  if (actor.apiKeyId) acting.apiKeyId = actor.apiKeyId
  return { db, organizationId, actor: acting, deployment: configDeployment(), features }
}

type ExportedArea = { area: ConfigArea; items: ConfigItem[] }

function blobItemFor(area: ConfigArea, item: ConfigItem): ConfigBlobItem {
  const out: ConfigBlobItem = { id: item.id, name: item.name, rev: itemRev(area, item), spec: item.spec }
  if (item.key !== undefined) out.key = item.key
  return out
}

function secretIndex(exported: readonly ExportedArea[]): ConfigBlobSecretIndexEntry[] {
  const out: ConfigBlobSecretIndexEntry[] = []
  for (const { area, items } of exported) {
    for (const item of items) {
      for (const secret of findSecrets(area, item.spec)) {
        out.push({ path: secret.path, area: area.key, itemId: item.id, itemName: item.name, field: secret.field, set: secret.placeholder.set === true })
      }
    }
  }
  return out
}

async function exportAreas(ctx: ConfigAreaContext, keys: readonly ConfigAreaKey[]): Promise<ExportedArea[]> {
  const out: ExportedArea[] = []
  for (const key of keys) {
    const area = getConfigArea(key)
    const read = await area.exportItems(ctx)
    const items = area.ensureKeys ? await area.ensureKeys(ctx, read) : read
    out.push({ area, items: [...items].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)) })
  }
  return out
}

async function assembleBlob(org: Pick<ConfigOrganization, "id" | "slug" | "name">, exported: readonly ExportedArea[], omitted: Array<{ area: ConfigAreaKey; reason: string }>): Promise<ConfigBlob> {
  const flat: Partial<Record<ConfigAreaKey, ConfigBlobArea>> = {}
  for (const { area, items } of exported) flat[area.key] = { specVersion: area.specVersion, items: items.map((item) => blobItemFor(area, item)) }
  const entries = exported.flatMap(({ area, items }) => items.map((item) => ({ area: area.key, id: item.id, rev: itemRev(area, item) })))
  const schemaUrl = configBlobSchemaUrl(CONFIG_BLOB_FORMAT_VERSION)
  const blob: ConfigBlob = {
    ...(schemaUrl ? { $schema: schemaUrl } : {}),
    format: CONFIG_BLOB_FORMAT,
    formatVersion: CONFIG_BLOB_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    source: {
      deployment: configDeployment(),
      instanceId: await getConfigInstanceId(),
      appVersion: env.serviceVersion.slice(0, 64),
      organization: { id: org.id, slug: org.slug, name: org.name },
    },
    scope: exported.map(({ area }) => area.key),
    baseHash: computeBaseHash(entries),
    areas: nestConfigAreas(flat),
    secrets: secretIndex(exported),
  }
  if (omitted.length > 0) blob.omitted = omitted
  return blob
}

export async function exportBlob(org: ConfigOrganization, caller: ConfigCaller, areas: readonly ConfigAreaKey[] | null): Promise<ConfigBlob> {
  const deployment = configDeployment()
  const requested = areas ?? CONFIG_AREAS.map((area) => area.key)
  const omitted: Array<{ area: ConfigAreaKey; reason: string }> = []
  const keys: ConfigAreaKey[] = []
  for (const key of requested) {
    const area = registeredArea(key)
    const unsupported = area ? unsupportedReason(area, deployment, org.features)?.replace(/ here$/, ` in ${org.name}`) ?? null : "not available on this server"
    if (!area || unsupported) omitted.push({ area: key, reason: unsupported ?? "not available on this server" })
    else if (!tokenAllows(caller.tokenAreas, key)) omitted.push({ area: key, reason: "outside this config token's areas" })
    else if (!caller.can(area.viewPermission)) omitted.push({ area: key, reason: `needs the ${area.viewPermission} permission` })
    else keys.push(key)
  }
  if (keys.length === 0) {
    throw new ConfigBlobError(403, { error: "nothing_to_export", message: "You can't export any of these areas.", omitted })
  }
  const exported = await exportAreas(areaContext(org.id, caller, org.features), keys)
  const blob = await assembleBlob(org, exported, omitted)
  if (blob.baseHash) await recordExport({ organizationId: org.id, baseHash: blob.baseHash, areas: blob.scope, blob })
  const people = await peopleRedactorFor(org.id, caller)
  return people ? people.blob(blob) : blob
}

async function loadActor(organizationId: OrganizationId, memberId: string | null): Promise<ConfigActor | null> {
  if (!memberId) return null
  let id: MemberId
  try {
    id = normalizeDenTypeId("member", memberId)
  } catch {
    return null
  }
  const [row] = await db.$primary
    .select({ id: MemberTable.id, userId: MemberTable.userId })
    .from(MemberTable)
    .where(and(eq(MemberTable.organizationId, organizationId), eq(MemberTable.id, id)))
    .limit(1)
  return row?.userId ? { memberId: row.id, userId: row.userId } : null
}

async function loadPeople(organizationId: OrganizationId): Promise<Map<string, string>> {
  return (await loadDirectory(organizationId)).people
}

async function loadDirectory(organizationId: OrganizationId): Promise<{ people: Map<string, string>; names: Map<string, string> }> {
  const rows = await db.$primary
    .select({ id: MemberTable.id, userName: AuthUserTable.name, userEmail: AuthUserTable.email, inviteEmail: InvitationTable.email, removedAt: MemberTable.removedAt })
    .from(MemberTable)
    .leftJoin(AuthUserTable, eq(MemberTable.userId, AuthUserTable.id))
    .leftJoin(InvitationTable, eq(MemberTable.inviteId, InvitationTable.id))
    .where(eq(MemberTable.organizationId, organizationId))
  const people = new Map<string, string>()
  const names = new Map<string, string>()
  for (const row of [...rows.filter((entry) => !entry.removedAt), ...rows.filter((entry) => entry.removedAt)]) {
    const email = (row.userEmail ?? row.inviteEmail)?.trim().toLowerCase()
    if (!email) continue
    if (!people.has(email)) people.set(email, row.id)
    if (!row.removedAt) names.set(row.id, row.userName?.trim() || email)
  }
  return { people, names }
}

function canReadPeople(caller: Pick<ConfigCaller, "can" | "tokenAreas">): boolean {
  return canView(caller, PEOPLE_AREA_KEY)
}

function planFor(plan: ConfigPlan, caller: Pick<ConfigCaller, "can" | "tokenAreas">, people: PeopleRedactor | null): ConfigPlan {
  const shown = people ? people.plan(plan) : plan
  if (!shown.refTargets) return shown
  const { refTargets, ...rest } = shown
  const visible = refTargets.filter((entry) => canView(caller, entry.area))
  return visible.length > 0 ? { ...rest, refTargets: visible } : rest
}

async function peopleRedactorFor(organizationId: OrganizationId, caller: Pick<ConfigCaller, "can" | "tokenAreas">): Promise<PeopleRedactor | null> {
  return canReadPeople(caller) ? null : createPeopleRedactor(await loadPeople(organizationId))
}

async function apiKeyName(apiKeyId: string): Promise<string | null> {
  const [row] = await db.select({ name: AuthApiKeyTable.name }).from(AuthApiKeyTable).where(eq(AuthApiKeyTable.id, apiKeyId)).limit(1)
  return row?.name ?? null
}

async function apiKeyUsable(apiKeyId: string): Promise<boolean> {
  const [row] = await db.$primary
    .select({ enabled: AuthApiKeyTable.enabled, expiresAt: AuthApiKeyTable.expiresAt })
    .from(AuthApiKeyTable)
    .where(eq(AuthApiKeyTable.id, apiKeyId))
    .limit(1)
  return Boolean(row?.enabled) && (!row?.expiresAt || row.expiresAt.getTime() > Date.now())
}

function readSettings(metadata: unknown): ConfigBlobSettings {
  let parsed: Record<string, unknown> = {}
  try {
    parsed = readOrganizationMetadata(metadata)
  } catch {
    parsed = {}
  }
  const value = parsed[SETTINGS_METADATA_KEY]
  const requireSecondApprover = typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.getOwnPropertyDescriptor(value, "requireSecondApprover")?.value === true
  return { requireSecondApprover }
}

export async function getConfigBlobSettings(organizationId: OrganizationId): Promise<ConfigBlobSettings> {
  const [row] = await db.$primary.select({ metadata: OrganizationTable.metadata }).from(OrganizationTable).where(eq(OrganizationTable.id, organizationId)).limit(1)
  return readSettings(row?.metadata ?? null)
}

export async function updateConfigBlobSettings(organizationId: OrganizationId, settings: ConfigBlobSettings): Promise<ConfigBlobSettings> {
  const metadata = await updateOrganizationMetadata(organizationId, (current) => ({ ...current, [SETTINGS_METADATA_KEY]: { requireSecondApprover: settings.requireSecondApprover } }))
  return readSettings(metadata)
}

const WITHDRAWN_RESTORE_STATUSES: readonly ConfigChangeRequestStatus[] = ["cancelled", "invalid", "superseded"]

async function summaries(organizationId: OrganizationId, rows: Parameters<typeof toChangeRequestSummary>[0][]): Promise<ConfigChangeRequestSummary[]> {
  const names = await loadMemberNames(organizationId, summaryMemberIds(rows))
  const restoreIds = rows.flatMap((row) => (row.revertedByChangeRequestId ? [row.revertedByChangeRequestId] : []))
  const restoreStatuses = restoreIds.length > 0 ? await listChangeRequestStatuses(organizationId, restoreIds) : new Map<string, ConfigChangeRequestStatus>()
  return rows.map((row) => {
    const restoreStatus = row.revertedByChangeRequestId ? restoreStatuses.get(row.revertedByChangeRequestId) : undefined
    const withdrawn = row.revertedByChangeRequestId !== null && (restoreStatus === undefined || WITHDRAWN_RESTORE_STATUSES.includes(restoreStatus))
    return toChangeRequestSummary(withdrawn ? { ...row, revertedByChangeRequestId: null } : row, names)
  })
}

async function summaryOf(row: ConfigChangeRequestRow): Promise<ConfigChangeRequestSummary> {
  const [summary] = await summaries(row.organizationId, [row])
  if (!summary) throw new Error("config_change_request_summary_missing")
  return summary
}

function visibleTo(caller: Pick<ConfigCaller, "can" | "tokenAreas">, areas: readonly ConfigAreaKey[]): boolean {
  return areas.every((area) => canView(caller, area))
}

function notFound(): ConfigBlobError {
  return new ConfigBlobError(404, { error: "change_request_not_found", message: "This config change doesn't exist." })
}

async function loadVisible(organizationId: OrganizationId, id: string, caller: Pick<ConfigCaller, "can" | "tokenAreas">): Promise<ConfigChangeRequestRow> {
  let requestId: ConfigChangeRequestId
  try {
    requestId = normalizeDenTypeId("configChangeRequest", id)
  } catch {
    throw notFound()
  }
  const row = await getChangeRequest(organizationId, requestId, db.$primary)
  if (!row || !visibleTo(caller, row.areas)) throw notFound()
  return row
}

export async function listChangeRequestSummaries(organizationId: OrganizationId, caller: Pick<ConfigCaller, "can" | "tokenAreas">, state: "open" | "closed"): Promise<ConfigChangeRequestSummary[]> {
  const rows = await listChangeRequests(organizationId, { state })
  const out = await summaries(organizationId, rows.filter((row) => visibleTo(caller, row.areas)))
  const people = await peopleRedactorFor(organizationId, caller)
  return people ? out.map(people.summary) : out
}

async function summaryFor(row: ConfigChangeRequestRow, caller: Pick<ConfigCaller, "can" | "tokenAreas">): Promise<ConfigChangeRequestSummary> {
  const summary = await summaryOf(row)
  const people = await peopleRedactorFor(row.organizationId, caller)
  return people ? people.summary(summary) : summary
}

export async function getChangeRequestDetail(organizationId: OrganizationId, id: string, caller: Pick<ConfigCaller, "can" | "tokenAreas">): Promise<ConfigChangeRequestDetailResponse> {
  const row = await loadVisible(organizationId, id, caller)
  const people = await peopleRedactorFor(organizationId, caller)
  const runs = (await listApplyRuns(organizationId, row.id, db.$primary)).map((run) => (people ? people.report(run.report) : run.report))
  const summary = await summaryOf(row)
  return { changeRequest: people ? people.summary(summary) : summary, report: runs[0] ?? null, runs }
}

export async function getApplyRunDetail(organizationId: OrganizationId, id: string, runId: string, caller: Pick<ConfigCaller, "can" | "tokenAreas">): Promise<ConfigApplyRunResponse> {
  const row = await loadVisible(organizationId, id, caller)
  let applyRunId: ConfigApplyRunId
  try {
    applyRunId = normalizeDenTypeId("configApplyRun", runId)
  } catch {
    throw runNotFound()
  }
  const run = await getApplyRun(organizationId, row.id, applyRunId, db.$primary)
  if (!run) throw runNotFound()
  const people = await peopleRedactorFor(organizationId, caller)
  return { run: people ? people.report(run.report) : run.report }
}

function runNotFound(): ConfigBlobError {
  return new ConfigBlobError(404, { error: "apply_run_not_found", message: "This apply run doesn't exist." })
}

export async function getChangeRequestPlan(organizationId: OrganizationId, id: string, caller: Pick<ConfigCaller, "can" | "tokenAreas">): Promise<{ plan: ConfigPlan | null; decisions: ConfigDecisions }> {
  const row = await loadVisible(organizationId, id, caller)
  const people = await peopleRedactorFor(organizationId, caller)
  return { plan: row.plan ? planFor(row.plan, caller, people) : row.plan, decisions: row.decisions ?? EMPTY_CONFIG_DECISIONS }
}

export async function getBeforeSnapshot(organizationId: OrganizationId, id: string, caller: Pick<ConfigCaller, "can" | "tokenAreas">): Promise<unknown> {
  const row = await loadVisible(organizationId, id, caller)
  if (row.beforeSnapshot === null || row.beforeSnapshot === undefined) {
    throw new ConfigBlobError(404, { error: "before_snapshot_not_found", message: "This change has no before-snapshot: it was never applied." })
  }
  const people = await peopleRedactorFor(organizationId, caller)
  return people ? people.refs(row.beforeSnapshot) : row.beforeSnapshot
}

export type SubmitInput = { blob: unknown; mode: ConfigImportMode; title?: string; autoApply: boolean }

type ParsedEnvelope = { blob: ConfigBlob; areas: Partial<Record<ConfigAreaKey, ConfigBlobArea>> }

function parseEnvelope(raw: unknown): { ok: true; value: ParsedEnvelope } | { ok: false; errors: string[] } {
  const parsed = configBlobSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.slice(0, 50).map((issue) => `${issue.path.join(".") || "blob"}: ${issue.message}`) }
  const flat = flattenConfigAreas(parsed.data.areas)
  if (flat.errors.length > 0) return { ok: false, errors: flat.errors.slice(0, 50) }
  return { ok: true, value: { blob: { ...parsed.data, areas: nestConfigAreas(flat.areas) }, areas: flat.areas } }
}

function blobBytes(blob: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(blob) ?? "", "utf8")
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

function checkSubmission(caller: ConfigCaller, raw: unknown, options: { internal?: boolean } = {}): { blob: ConfigBlob; scope: ConfigAreaKey[] } {
  if (!options.internal && blobBytes(raw) > CONFIG_BLOB_MAX_BYTES) {
    throw new ConfigBlobError(413, { error: "blob_too_large", message: `Config files are limited to ${CONFIG_BLOB_MAX_BYTES / (1024 * 1024)} MB.` })
  }
  const envelope = parseEnvelope(raw)
  if (!envelope.ok) throw new ConfigBlobError(400, { error: "invalid_blob", message: envelope.errors[0] ?? "This isn't an OpenWork config file.", errors: envelope.errors })
  const { blob } = envelope.value
  const scope = CONFIG_AREA_KEYS.filter((key) => blob.scope.includes(key))
  const denied = scope.filter((area) => !canImport(caller, area))
  if (denied.length > 0) {
    const outside = denied.filter((area) => !tokenAllows(caller.tokenAreas, area))
    const missing = missingImportPermissions(caller, denied)
    throw new ConfigBlobError(403, {
      error: "forbidden",
      message: `You can't import ${denied.map(areaLabel).join(", ")}${outside.length > 0 ? `: outside this config token's areas (${outside.map(areaLabel).join(", ")})` : ""}${missing.length > 0 ? `${outside.length > 0 ? ";" : ":"} importing an area needs permission to view and to manage it (missing ${missing.join(", ")})` : ""}.`,
      areas: denied,
      requiredPermissions: missing.length > 0 ? missing : managePermissions(denied),
    })
  }
  return { blob, scope }
}

export type ConfigDryRunResult = { plan: ConfigPlan | null; errors: string[] }

export async function dryRunChangeRequest(org: ConfigOrganization, caller: ConfigCaller, input: Pick<SubmitInput, "blob" | "mode">): Promise<ConfigDryRunResult> {
  const { blob } = checkSubmission(caller, input.blob)
  const planned = await planChangeRequest({
    organizationId: org.id,
    blob: input.blob,
    mode: input.mode,
    baseHash: blob.baseHash ?? null,
    createdByMemberId: normalizeDenTypeId("member", caller.memberId),
    approvals: [],
    decisions: null,
    secretInputs: null,
    apiKeyId: caller.apiKeyId,
  })
  const people = await peopleRedactorFor(org.id, caller)
  if ("invalid" in planned) return { plan: null, errors: people ? planned.invalid.map(people.text) : planned.invalid }
  return { plan: planFor(planned.plan, caller, people), errors: people ? planned.fatal.map(people.text) : planned.fatal }
}

async function earlierAnswers(org: ConfigOrganization, blob: ConfigBlob): Promise<ConfigDecisions | null> {
  if (!blob.source) return null
  const earlier = await latestAppliedFromSource(org.id, { instanceId: blob.source.instanceId, organizationId: blob.source.organization.id })
  if (!earlier?.decisions) return null
  const { matches, skips, renames } = earlier.decisions
  const refs = earlier.decisions.refs.filter((entry) => !("invite" in entry.resolution))
  if (matches.length + refs.length + skips.length + renames.length === 0) return null
  return { ...EMPTY_CONFIG_DECISIONS, matches, refs, skips, renames, reusedFrom: earlier.id }
}

export async function submitChangeRequest(org: ConfigOrganization, caller: ConfigCaller, input: SubmitInput, options: { source?: "ui" | "api" | "revert"; revertsChangeRequestId?: ConfigChangeRequestId; decisions?: ConfigDecisions } = {}): Promise<ConfigChangeRequestSummary> {
  const source = options.source ?? (caller.apiKeyId ? "api" : "ui")
  const { blob, scope } = checkSubmission(caller, input.blob, { internal: source === "revert" })
  const row = await createChangeRequest({
    organizationId: org.id,
    status: "uploaded",
    title: input.title ?? null,
    mode: input.mode,
    sourceKind: source,
    createdByMemberId: normalizeDenTypeId("member", caller.memberId),
    apiKeyId: caller.apiKeyId,
    apiKeyName: caller.apiKeyId ? await apiKeyName(caller.apiKeyId) : null,
    blob: input.blob,
    sourceInstanceId: blob.source?.instanceId ?? null,
    sourceOrgId: blob.source?.organization.id ?? null,
    sourceOrgSlug: blob.source?.organization.slug ?? null,
    sourceOrgName: blob.source?.organization.name ?? null,
    sourceDeployment: blob.source?.deployment ?? null,
    areas: scope,
    baseHash: blob.baseHash ?? null,
    decisions: options.decisions ?? (source === "revert" ? null : await earlierAnswers(org, blob)),
    autoApply: input.autoApply,
    availableAt: new Date(),
    ...(options.revertsChangeRequestId ? { revertsChangeRequestId: options.revertsChangeRequestId } : {}),
  })
  if (caller.apiKeyId) await supersedeOpenRequestsFromApiKey({ organizationId: org.id, apiKeyId: caller.apiKeyId, areas: scope, exceptId: row.id })
  return summaryFor(row, caller)
}

type Planned = {
  plan: ConfigPlan
  execution: ExecutionPlan
  fatal: string[]
  ctx: ConfigAreaContext
}

function neededAreas(scope: readonly ConfigAreaKey[], areas: Partial<Record<ConfigAreaKey, ConfigBlobArea>>): Set<ConfigAreaKey> {
  const needed = new Set<ConfigAreaKey>(scope)
  const visitRefs = (value: unknown) => {
    if (isConfigRef(value)) {
      const parsed = parseConfigRef(value.$ref)
      if (parsed && parsed.area !== "people") needed.add(parsed.area)
      return
    }
    if (isConfigSecret(value)) return
    if (Array.isArray(value)) value.forEach(visitRefs)
    else if (typeof value === "object" && value !== null) Object.values(value).forEach(visitRefs)
  }
  for (const key of scope) for (const item of areas[key]?.items ?? []) visitRefs(item.spec)
  return needed
}

type GroupedAliases = {
  aliases: Map<ConfigAreaKey, Map<string, string>>
  provenance: Map<ConfigAreaKey, Map<string, string>>
}

function groupAliases(rows: readonly ConfigAliasEntry[]): GroupedAliases {
  const aliases = new Map<ConfigAreaKey, Map<string, string>>()
  const provenance = new Map<ConfigAreaKey, Map<string, string>>()
  for (const row of rows) {
    const areaKey = CONFIG_AREA_KEYS.find((entry) => entry === row.area)
    if (!areaKey) continue
    const byArea = aliases.get(areaKey) ?? new Map<string, string>()
    byArea.set(row.sourceId, row.localId)
    aliases.set(areaKey, byArea)
    if (row.createdByChangeRequestId) {
      const sources = provenance.get(areaKey) ?? new Map<string, string>()
      sources.set(row.sourceId, row.createdByChangeRequestId)
      provenance.set(areaKey, sources)
    }
  }
  return { aliases, provenance }
}

function addAliasProvenance(plan: ConfigPlan, provenance: GroupedAliases["provenance"]): void {
  for (const area of plan.areas) {
    for (const item of area.items) {
      if (item.matchedBy !== "alias" || !item.blob?.id) continue
      const changeRequestId = provenance.get(item.area)?.get(item.blob.id)
      const reason = changeRequestId ? `matched via an earlier import (${changeRequestId})` : "matched via an earlier import"
      item.reasons = [...(item.reasons ?? []), reason]
    }
  }
}

async function planningAccessFor(organizationId: OrganizationId, actor: ConfigActor, apiKeyId: string | null): Promise<{ visibleAreas: Set<ConfigAreaKey>; mayInvite: boolean }> {
  const permissions = await resolvePermissionsForMember({ organizationId, memberId: normalizeDenTypeId("member", actor.memberId) })
  const token = apiKeyId ? await getApiKeySessionById(apiKeyId) : null
  const tokenAreas = apiKeyId ? (token ? token.configAreas : []) : null
  const people = registeredArea(PEOPLE_AREA_KEY)
  return {
    visibleAreas: new Set(CONFIG_AREAS.filter((area) => permissions.has(area.viewPermission) && tokenAllows(tokenAreas, area.key)).map((area) => area.key)),
    mayInvite: people !== null && permissions.has(people.managePermission) && tokenAllows(tokenAreas, PEOPLE_AREA_KEY),
  }
}

async function baseSpecsFor(organizationId: OrganizationId, hash: string | null): Promise<Map<string, ConfigSpec> | undefined> {
  if (!hash) return undefined
  const stored = await findExportByBaseHash(organizationId, hash)
  if (!stored) return undefined
  const parsed = configBlobSchema.safeParse(stored.blob)
  if (!parsed.success) return undefined
  const out = new Map<string, ConfigSpec>()
  for (const [area, value] of Object.entries(flattenConfigAreas(parsed.data.areas).areas)) {
    for (const item of value?.items ?? []) if (item.id) out.set(`${area}/${item.id}`, item.spec)
  }
  return out
}

async function addLinkedTargetItems(input: {
  ctx: ConfigAreaContext
  areas: Partial<Record<ConfigAreaKey, { items: readonly { id?: string | null }[] }>>
  targetItems: Map<ConfigAreaKey, ConfigItem[]>
  aliases: ReadonlyMap<ConfigAreaKey, ReadonlyMap<string, string>>
}): Promise<void> {
  for (const [key, items] of input.targetItems) {
    const links = input.aliases.get(key)
    const area = registeredArea(key)
    if (!links || !area?.readItems) continue
    const known = new Set(items.map((item) => item.id))
    const missing = new Set<string>()
    for (const item of input.areas[key]?.items ?? []) {
      const localId = item.id ? links.get(item.id) : undefined
      if (localId && !known.has(localId)) missing.add(localId)
    }
    if (missing.size === 0) continue
    items.push(...await readItemsFor(area, input.ctx, [...missing]))
  }
}

type PlanSource = Pick<ConfigChangeRequestRow, "organizationId" | "blob" | "mode" | "baseHash" | "createdByMemberId" | "approvals" | "decisions" | "secretInputs" | "apiKeyId">
  & Partial<Pick<ConfigChangeRequestRow, "sourceKind" | "revertsChangeRequestId">>

async function planningActor(row: PlanSource): Promise<ConfigActor | null> {
  return await loadActor(row.organizationId, row.createdByMemberId)
    ?? await loadActor(row.organizationId, row.approvals[row.approvals.length - 1]?.memberId ?? null)
}

async function planChangeRequest(row: PlanSource, overrides: { decisions?: ConfigDecisions; secretInputs?: ConfigSecretInput[] } = {}): Promise<Planned | { invalid: string[] }> {
  const envelope = parseEnvelope(row.blob)
  if (!envelope.ok) return { invalid: envelope.errors }
  const { blob, areas } = envelope.value
  const actor = await planningActor(row)
  if (!actor) return { invalid: ["The person who uploaded this change is no longer a member of the organization."] }
  const features = await getOrganizationFeatures(row.organizationId)
  const ctx = areaContext(row.organizationId, actor, features)
  const deployment = configDeployment()
  const scope = CONFIG_AREA_KEYS.filter((key) => blob.scope.includes(key))
  const needed = neededAreas(scope, areas)
  const targetItems = new Map<ConfigAreaKey, ConfigItem[]>()
  for (const key of CONFIG_AREA_KEYS) {
    if (!needed.has(key)) continue
    const area = registeredArea(key)
    if (!area || unsupportedReason(area, deployment, features)) continue
    targetItems.set(key, await area.exportItems(ctx))
  }
  const instanceId = await getConfigInstanceId()
  const sourceInstanceId = blob.source?.instanceId
  const sameOrganization = blob.source?.organization.id === row.organizationId && sourceInstanceId === instanceId
  const decisions = overrides.decisions ?? row.decisions ?? EMPTY_CONFIG_DECISIONS
  const secretInputs = overrides.secretInputs ?? row.secretInputs ?? []
  const grouped = sourceInstanceId ? groupAliases(await listAliasRows(row.organizationId, sourceInstanceId, db.$primary)) : null
  if (grouped) await addLinkedTargetItems({ ctx, areas, targetItems, aliases: grouped.aliases })
  const access = await planningAccessFor(row.organizationId, actor, row.apiKeyId)
  const directory = await loadDirectory(row.organizationId)
  const planInput: Parameters<typeof buildPlan>[0] = {
    areas: CONFIG_AREAS,
    blobAreas: areas,
    scope,
    mode: row.mode,
    targetItems,
    aliases: grouped?.aliases,
    visibleAreas: access.visibleAreas,
    mayInvite: access.mayInvite,
    decisions,
    secretInputs,
    people: directory.people,
    allowEnv: configAllowEnv(),
    deployment,
    features,
    ...(sourceInstanceId ? { sourceInstanceId } : {}),
    sameOrganization,
    baseSpecs: sameOrganization ? await baseSpecsFor(row.organizationId, row.baseHash) : undefined,
    ctx,
  }
  const restoredId = row.sourceKind === "revert" ? restoredChangeRequestId(row.revertsChangeRequestId ?? null) : null
  if (restoredId) {
    const created = new Map<ConfigAreaKey, Set<string>>()
    for (const entry of createdByRuns(await listApplyRuns(row.organizationId, restoredId, db.$primary))) {
      created.set(entry.area, (created.get(entry.area) ?? new Set<string>()).add(entry.targetId))
    }
    planInput.restore = { created }
  }
  let result = buildPlan(planInput)
  if (result.fatalErrors.length === 0) {
    const verdicts = await runPreflight(result.execution, CONFIG_AREAS, ctx)
    if (verdicts.size > 0) result = buildPlan({ ...planInput, preflight: verdicts })
  }
  if (grouped) addAliasProvenance(result.plan, grouped.provenance)
  const refTargets = planRefTargets(result.plan, { scope, targetItems, members: directory.names, visibleAreas: access.visibleAreas })
  if (refTargets.length > 0) result.plan.refTargets = refTargets
  for (const entry of blob.omitted ?? []) {
    result.plan.issues.push({ level: "warning", message: `${areaLabel(entry.area)} was left out of the export: ${entry.reason}`, area: entry.area })
  }
  if (restoredId) result.plan.issues.push(...await restoreIssues(row.organizationId, restoredId, areas))
  return { plan: result.plan, execution: result.execution, fatal: result.fatalErrors, ctx }
}

function currentApprovals(row: Pick<ConfigChangeRequestRow, "approvals" | "approvedPlanHash" | "planHash">): ConfigChangeRequestApproval[] {
  return row.planHash && row.approvedPlanHash === row.planHash ? row.approvals : []
}

function approvalsSatisfied(approvals: readonly ConfigChangeRequestApproval[], settings: ConfigBlobSettings): boolean {
  const distinct = new Set(approvals.map((approval) => approval.memberId))
  return distinct.size >= (settings.requireSecondApprover ? 2 : 1)
}

async function planPatch(row: ConfigChangeRequestRow, planned: Planned | { invalid: string[] }, options: { dropApprovals?: boolean } = {}): Promise<ChangeRequestPatch> {
  if ("invalid" in planned) return { status: "invalid", errors: storedErrors(planned.invalid), approvals: [], approvedPlanHash: null, secretInputs: null, execution: null }
  if (planned.fatal.length > 0) {
    return { status: "invalid", plan: planned.plan, planHash: planned.plan.planHash, errors: storedErrors(planned.fatal), approvals: [], approvedPlanHash: null, secretInputs: null, execution: null }
  }
  const keep = !options.dropApprovals && row.approvedPlanHash === planned.plan.planHash
  const approvals = keep ? row.approvals : []
  const patch: ChangeRequestPatch = {
    plan: planned.plan,
    planHash: planned.plan.planHash,
    execution: planned.execution,
    errors: [],
    approvals,
    approvedPlanHash: keep ? row.approvedPlanHash : null,
    status: "needs_review",
  }
  if (keep && planned.plan.summary.blocking === 0 && approvalsSatisfied(approvals, await getConfigBlobSettings(row.organizationId))) {
    patch.status = row.autoApply ? "queued" : "approved"
    if (row.autoApply) {
      patch.availableAt = new Date()
      const last = approvals[approvals.length - 1]
      if (last) patch.applyRequestedBy = { memberId: last.memberId, at: new Date().toISOString(), ...(last.apiKeyId ? { apiKeyId: last.apiKeyId } : {}) }
    }
  }
  return patch
}

export async function analyzeClaimedChangeRequest(claim: ClaimedChangeRequest): Promise<ConfigChangeRequestStatus | null> {
  try {
    const patch = await planPatch(claim, await planChangeRequest(claim))
    await releaseClaim(claim, { ...patch, attempts: 0 })
    return patch.status ?? null
  } catch (error) {
    logger.error("config change request analysis failed", { change_request_id: claim.id, organization_id: claim.organizationId, error })
    if (claim.attempts < MAX_ANALYSIS_ATTEMPTS) {
      await releaseClaim(claim, { status: "uploaded", availableAt: new Date(Date.now() + 5_000 * claim.attempts) })
      return "uploaded"
    }
    await releaseClaim(claim, { status: "invalid", errors: [storedError(`The change couldn't be analyzed: ${errorMessage(error)}`)], approvals: [], approvedPlanHash: null, secretInputs: null })
    return "invalid"
  }
}

const EDITABLE_STATUSES: readonly ConfigChangeRequestStatus[] = ["needs_review", "approved", "stale"]

async function replan(row: ConfigChangeRequestRow, caller: ConfigCaller, change: ChangeRequestPatch & { decisions?: ConfigDecisions; secretInputs?: ConfigSecretInput[] }, options: { dropApprovals?: boolean } = {}) {
  const planned = await planChangeRequest(row, {
    ...(change.decisions ? { decisions: change.decisions } : {}),
    ...(change.secretInputs ? { secretInputs: change.secretInputs } : {}),
  })
  const patch = await planPatch(row, planned, options)
  const updated = await updateChangeRequest(row.organizationId, row.id, [row.status], { ...change, ...patch })
  if (!updated) throw new ConfigBlobError(409, { error: "change_request_moved_on", message: "This change moved on while you were editing it. Reload and try again." })
  const people = await peopleRedactorFor(row.organizationId, caller)
  return { changeRequest: await summaryFor(updated, caller), plan: updated.plan ? planFor(updated.plan, caller, people) : updated.plan }
}

async function loadEditable(organizationId: OrganizationId, id: string, caller: ConfigCaller): Promise<ConfigChangeRequestRow> {
  const row = await loadVisible(organizationId, id, caller)
  if (!EDITABLE_STATUSES.includes(row.status)) {
    throw new ConfigBlobError(409, { error: "change_request_not_editable", message: row.status === "uploaded" || row.status === "analyzing" ? "This change is still being analyzed." : "This change can no longer be edited.", status: row.status })
  }
  await authorizeWrites(caller, row.areas)
  return row
}

export async function updateDecisions(organizationId: OrganizationId, id: string, caller: ConfigCaller, decisions: ConfigDecisions) {
  const row = await loadEditable(organizationId, id, caller)
  const inviteKey = (entry: ConfigDecisions["refs"][number]) => `${entry.area}\u0000${entry.ref}\u0000${entry.path}`
  const invitedBefore = new Set((row.decisions?.refs ?? []).filter((entry) => "invite" in entry.resolution).map(inviteKey))
  if (decisions.refs.some((entry) => "invite" in entry.resolution && !invitedBefore.has(inviteKey(entry)))) await authorizeWrites(caller, [PEOPLE_AREA_KEY])
  return replan(row, caller, { decisions })
}

function sourceOrganizationId(row: Pick<ConfigChangeRequestRow, "blob">): string | null {
  const envelope = parseEnvelope(row.blob)
  return envelope.ok ? envelope.value.blob.source?.organization.id ?? null : null
}

export async function getDecisionsFile(organizationId: OrganizationId, id: string, caller: Pick<ConfigCaller, "can" | "tokenAreas">): Promise<ConfigDecisionsFile> {
  const row = await loadVisible(organizationId, id, caller)
  const { matches, refs, skips, renames } = row.decisions ?? EMPTY_CONFIG_DECISIONS
  const source = sourceOrganizationId(row)
  return {
    format: CONFIG_DECISIONS_FILE_FORMAT,
    formatVersion: 1,
    source: source ? { organizationId: source } : null,
    target: { organizationId },
    changeRequestId: row.id,
    decisions: { matches, refs, skips, renames },
  }
}

export async function replayDecisionsFile(organizationId: OrganizationId, id: string, caller: ConfigCaller, file: ConfigDecisionsFile) {
  if (file.target.organizationId !== organizationId) {
    throw new ConfigBlobError(409, { error: "decisions_other_organization", message: "These answers were given in another organization. Answers only carry over to a later import into the same organization." })
  }
  const row = await loadEditable(organizationId, id, caller)
  if ((file.source?.organizationId ?? null) !== sourceOrganizationId(row)) {
    throw new ConfigBlobError(409, { error: "decisions_other_source", message: "These answers were given for a file exported from another organization. Answers only carry over to a later import of the same source." })
  }
  return updateDecisions(organizationId, id, caller, { ...(row.decisions ?? EMPTY_CONFIG_DECISIONS), ...file.decisions, reusedFrom: file.changeRequestId })
}

export async function updateInputs(organizationId: OrganizationId, id: string, caller: ConfigCaller, inputs: readonly ConfigSecretInput[]) {
  const row = await loadEditable(organizationId, id, caller)
  const known = new Set<string>()
  const envelope = parseEnvelope(row.blob)
  if (envelope.ok) {
    for (const [key, area] of Object.entries(envelope.value.areas)) {
      const definition = CONFIG_AREAS.find((entry) => entry.key === key)
      if (!definition || !area) continue
      for (const item of area.items) for (const secret of findSecrets(definition, item.spec)) known.add(secret.path)
    }
  }
  const unknown = inputs.filter((input) => !known.has(input.path)).map((input) => input.path)
  if (unknown.length > 0) throw new ConfigBlobError(400, { error: "unknown_secret", message: `No secret placeholder ${unknown[0]} in this change.`, paths: unknown })
  const allowEnv = configAllowEnv()
  const refused = inputs.filter((input) => input.decision === "env" && !allowEnv(input.env))
  if (refused.length > 0) {
    throw new ConfigBlobError(400, { error: "env_secret_not_allowed", message: "Reading secrets from environment variables is only allowed on self-hosted servers, for variables the operator allowlisted." })
  }
  const merged = new Map((row.secretInputs ?? []).map((input) => [input.path, input]))
  for (const input of inputs) merged.set(input.path, input)
  const secretInputs = [...merged.values()]
  return replan(row, caller, { secretInputs }, { dropApprovals: inputs.some((input) => input.decision === "value") })
}

function writeAreas(plan: ConfigPlan | null): ConfigAreaKey[] {
  if (!plan) return []
  return plan.areas.filter((area) => area.items.some((item) => item.op === "create" || item.op === "update" || item.op === "rename" || item.op === "delete")).map((area) => area.area)
}

function applyRequest(caller: Pick<ConfigCaller, "memberId" | "apiKeyId">): ConfigChangeRequestApplyRequest {
  return { memberId: caller.memberId, at: new Date().toISOString(), ...(caller.apiKeyId ? { apiKeyId: caller.apiKeyId } : {}) }
}

async function approveRow(row: ConfigChangeRequestRow, caller: ConfigCaller, planHash: string): Promise<ConfigChangeRequestRow> {
  if (row.status !== "needs_review" && row.status !== "approved") {
    throw new ConfigBlobError(409, { error: "change_request_not_approvable", message: "Only a change waiting for review can be approved.", status: row.status })
  }
  if (!row.plan || !row.planHash || row.planHash !== planHash) {
    throw new ConfigBlobError(409, { error: "plan_changed", message: "The plan changed since you reviewed it. Review it again.", planHash: row.planHash })
  }
  if (row.plan.summary.blocking > 0) {
    throw new ConfigBlobError(409, { error: "plan_blocked", message: `${row.plan.summary.blocking} item(s) still need a decision.`, blocking: row.plan.summary.blocking })
  }
  caller.requireApprovalStepUp()
  await authorizeWrites(caller, writeAreas(row.plan))
  const approvals = currentApprovals(row)
  if (approvals.some((approval) => approval.memberId === caller.memberId)) {
    throw new ConfigBlobError(409, { error: "already_approved", message: "You already approved this change." })
  }
  const settings = await getConfigBlobSettings(row.organizationId)
  if (settings.requireSecondApprover && approvals.length >= 1 && caller.memberId === row.createdByMemberId) {
    throw new ConfigBlobError(403, { error: "second_approver_required", message: "Your organization requires a second approver who didn't upload this change." })
  }
  const next = [...approvals, { memberId: caller.memberId, at: new Date().toISOString(), ...(caller.apiKeyId ? { apiKeyId: caller.apiKeyId } : {}) }]
  const satisfied = approvalsSatisfied(next, settings)
  const status: ConfigChangeRequestStatus = satisfied ? (row.autoApply ? "queued" : "approved") : "needs_review"
  const updated = await updateChangeRequest(row.organizationId, row.id, [row.status], {
    approvals: next,
    approvedPlanHash: planHash,
    errors: [],
    status,
    ...(status === "queued" ? { availableAt: new Date(), applyRequestedBy: applyRequest(caller) } : {}),
  })
  if (!updated) throw new ConfigBlobError(409, { error: "change_request_moved_on", message: "This change moved on. Reload and try again." })
  return updated
}

export async function approveChangeRequest(organizationId: OrganizationId, id: string, caller: ConfigCaller, planHash: string): Promise<ConfigChangeRequestSummary> {
  const row = await loadVisible(organizationId, id, caller)
  return summaryFor(await approveRow(row, caller, planHash), caller)
}

export async function requestApply(organizationId: OrganizationId, id: string, caller: ConfigCaller, planHash: string | undefined): Promise<ConfigChangeRequestSummary> {
  let row = await loadVisible(organizationId, id, caller)
  if (row.status === "queued" || row.status === "applying") return summaryFor(row, caller)
  if (row.status === "needs_review" && planHash) row = await approveRow(row, caller, planHash)
  if (row.status === "queued") return summaryFor(row, caller)
  if (row.status !== "approved") {
    throw new ConfigBlobError(409, { error: "change_request_not_approved", message: row.status === "needs_review" ? "This change needs approval first." : "This change can't be applied now.", status: row.status })
  }
  caller.requireApprovalStepUp()
  await authorizeWrites(caller, writeAreas(row.plan))
  const lastApproval = applyingApproval(row)
  if (lastApproval && approvalExpired(lastApproval)) {
    await updateChangeRequest(organizationId, row.id, ["approved"], { status: "needs_review", approvals: [], approvedPlanHash: null, errors: [APPROVAL_EXPIRED_ERROR] })
    throw new ConfigBlobError(409, { error: "approval_expired", message: APPROVAL_EXPIRED_ERROR, status: "needs_review" })
  }
  const settings = await getConfigBlobSettings(organizationId)
  if (!approvalsSatisfied(currentApprovals(row), settings)) {
    throw new ConfigBlobError(409, { error: "change_request_not_approved", message: "This change needs another approval.", status: row.status })
  }
  const updated = await updateChangeRequest(organizationId, row.id, ["approved"], { status: "queued", availableAt: new Date(), applyRequestedBy: applyRequest(caller) })
  if (!updated) throw new ConfigBlobError(409, { error: "change_request_moved_on", message: "This change moved on. Reload and try again." })
  return summaryFor(updated, caller)
}

const CANCELLABLE: readonly ConfigChangeRequestStatus[] = CONFIG_CHANGE_REQUEST_OPEN_STATUSES.filter((status) => status !== "applying")

export async function cancelChangeRequest(organizationId: OrganizationId, id: string, caller: ConfigCaller): Promise<ConfigChangeRequestSummary> {
  const row = await loadVisible(organizationId, id, caller)
  if (!CANCELLABLE.includes(row.status)) {
    throw new ConfigBlobError(409, { error: "change_request_not_cancellable", message: row.status === "applying" ? "This change is being applied." : "This change is already closed.", status: row.status })
  }
  if (row.createdByMemberId !== caller.memberId) await authorizeWrites(caller, row.areas)
  const updated = await updateChangeRequest(organizationId, row.id, [row.status], { status: "cancelled", secretInputs: null, leaseOwner: null, leaseUntil: null })
  if (!updated) throw new ConfigBlobError(409, { error: "change_request_moved_on", message: "This change moved on. Reload and try again." })
  return summaryFor(updated, caller)
}

function revertBlob(snapshot: unknown, afterRevs: Record<string, string>): unknown {
  const parsed = configBlobSchema.safeParse(snapshot)
  if (!parsed.success) throw new ConfigBlobError(409, { error: "before_snapshot_invalid", message: "The before-snapshot of this change can't be read." })
  const flat = flattenConfigAreas(parsed.data.areas)
  const toDecision = (value: unknown): unknown => {
    if (isConfigSecret(value)) return value.set ? { $secret: value.$secret, keep: true } : { $secret: value.$secret, unset: true }
    if (isConfigRef(value)) return value
    if (Array.isArray(value)) return value.map(toDecision)
    if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, toDecision(child)]))
    return value
  }
  const areas: Partial<Record<ConfigAreaKey, ConfigBlobArea>> = {}
  for (const [key, area] of Object.entries(flat.areas)) {
    const areaKey = CONFIG_AREA_KEYS.find((entry) => entry === key)
    if (!areaKey || !area) continue
    areas[areaKey] = {
      specVersion: area.specVersion,
      items: area.items.map((item) => {
        const after = item.id ? afterRevs[`${areaKey}/${item.id}`] : undefined
        const spec = toDecision(item.spec)
        const out: ConfigBlobItem = { ...item, spec: typeof spec === "object" && spec !== null && !Array.isArray(spec) ? Object.fromEntries(Object.entries(spec)) : {} }
        if (after) out.rev = after
        else delete out.rev
        return out
      }),
    }
  }
  return { ...parsed.data, areas: nestConfigAreas(areas), secrets: undefined }
}

export async function revertChangeRequest(org: ConfigOrganization, id: string, caller: ConfigCaller): Promise<ConfigChangeRequestSummary> {
  const row = await loadVisible(org.id, id, caller)
  if (row.status !== "applied" && row.status !== "failed") {
    throw new ConfigBlobError(409, { error: "change_request_not_revertable", message: "Only an applied change can be restored from.", status: row.status })
  }
  if (row.beforeSnapshot === null || row.beforeSnapshot === undefined) {
    throw new ConfigBlobError(409, { error: "before_snapshot_not_found", message: "This change has no before-snapshot to restore." })
  }
  if (row.revertedByChangeRequestId) {
    const existing = await getChangeRequest(org.id, row.revertedByChangeRequestId, db.$primary)
    if (existing && CONFIG_CHANGE_REQUEST_OPEN_STATUSES.includes(existing.status)) {
      throw new ConfigBlobError(409, { error: "revert_in_progress", message: "A restore of this change is already open.", changeRequestId: existing.id })
    }
  }
  await authorizeWrites(caller, row.areas)
  const runs = await listApplyRuns(org.id, row.id, db.$primary)
  const afterRevs: Record<string, string> = {}
  for (const run of [...runs].reverse()) Object.assign(afterRevs, run.report.afterRevs ?? {})
  const decisions: ConfigDecisions = { ...EMPTY_CONFIG_DECISIONS, deletes: createdByRuns(runs) }
  const summary = await submitChangeRequest(org, caller, {
    blob: revertBlob(row.beforeSnapshot, afterRevs),
    mode: "mirror",
    title: `Restore previous config: ${row.title ?? row.id}`.slice(0, 200),
    autoApply: false,
  }, { source: "revert", revertsChangeRequestId: row.id, decisions })
  await updateChangeRequest(org.id, row.id, [row.status], { revertedByChangeRequestId: normalizeDenTypeId("configChangeRequest", summary.id) })
  return summary
}

function createdByRuns(runs: readonly { report: ConfigApplyReport }[]): Array<{ area: ConfigAreaKey; targetId: string }> {
  const created = new Map<string, { area: ConfigAreaKey; targetId: string }>()
  for (const run of runs) {
    for (const item of run.report.items) {
      if (item.op === "create" && item.status === "applied" && item.localId) created.set(`${item.area}\u0000${item.localId}`, { area: item.area, targetId: item.localId })
    }
  }
  return [...created.values()]
}

function restoredChangeRequestId(id: string | null): ConfigChangeRequestId | null {
  if (!id) return null
  try {
    return normalizeDenTypeId("configChangeRequest", id)
  } catch {
    return null
  }
}

async function restoreIssues(organizationId: OrganizationId, changeRequestId: ConfigChangeRequestId, blobAreas: Partial<Record<ConfigAreaKey, ConfigBlobArea>>): Promise<ConfigPlan["issues"]> {
  const issues: ConfigPlan["issues"] = []
  const runs = await listApplyRuns(organizationId, changeRequestId, db.$primary)
  const seen = new Set<string>()
  for (const run of runs) {
    for (const item of run.report.items) {
      if (item.irreversible.length === 0 || (item.status !== "applied" && item.steps.length === 0)) continue
      const label = CONFIG_AREAS.find((area) => area.key === item.area)?.label ?? item.area
      const effects = item.irreversible.map((effect) => /[.!?]$/.test(effect) ? effect : `${effect}.`).join(" ")
      const message = `These can't be undone by restoring: ${label} "${item.name}": ${effects}`
      if (seen.has(message)) continue
      seen.add(message)
      issues.push({ level: "warning", message, area: item.area })
    }
    for (const item of run.report.items) {
      if (item.op !== "delete" || item.status !== "applied" || !item.localId) continue
      const area = CONFIG_AREAS.find((entry) => entry.key === item.area)
      const restored = blobAreas[item.area]?.items.find((entry) => entry.id === item.localId)
      if (!area || !restored) continue
      const fields = findSecrets(area, restored.spec).filter((secret) => secret.placeholder.keep === true).map((secret) => secret.field)
      if (fields.length === 0) continue
      const message = `${area.label} "${item.name}" was deleted, so its stored credentials are gone: enter them again (${[...new Set(fields)].join(", ")}).`
      if (seen.has(message)) continue
      seen.add(message)
      issues.push({ level: "warning", message, area: item.area })
    }
  }
  const withSecrets = Object.keys(blobAreas).flatMap((key) => {
    const area = CONFIG_AREAS.find((entry) => entry.key === key)
    return area && area.secretFields.length > 0 ? [area.label] : []
  })
  if (withSecrets.length > 0) {
    issues.push({ level: "info", message: `Credentials are never stored in snapshots: restoring keeps the credentials ${withSecrets.join(", ")} have now.` })
  }
  return issues
}

type TableWithId = { table: MySqlTable; column: ReturnType<typeof getTableConfig>["columns"][number] }
let tablesByName: Map<string, TableWithId> | null = null

function tablesWithId(): Map<string, TableWithId> {
  if (tablesByName) return tablesByName
  const out = new Map<string, TableWithId>()
  for (const value of Object.values(denSchema)) {
    if (!(value instanceof MySqlTable)) continue
    const config = getTableConfig(value)
    const column = config.columns.find((entry) => entry.name === "id")
    if (column) out.set(config.name, { table: value, column })
  }
  tablesByName = out
  return out
}

async function isConfigIdFree(organizationId: OrganizationId, area: ConfigAreaKey, id: string): Promise<boolean> {
  for (const name of getConfigArea(area).tables) {
    const entry = tablesWithId().get(name)
    if (!entry) continue
    const rows = await db.$primary.select({ one: sql<number>`1` }).from(entry.table).where(sql`${entry.column} = ${id}`).limit(1)
    if (rows.length > 0) return false
  }
  const audited = await db.$primary
    .select({ one: sql<number>`1` })
    .from(AuditEventResourceTable)
    .where(and(eq(AuditEventResourceTable.organization_id, organizationId), eq(AuditEventResourceTable.resource_id, id)))
    .limit(1)
  return audited.length === 0
}

function reusesSourceIds(sourceInstanceId: string | null, instanceId: string): boolean {
  return sourceInstanceId !== null && sourceInstanceId !== instanceId
}

async function jobCapture(input: { organizationId: OrganizationId; changeRequestId: string; actor: AuditActor; initiatingActor: AuditActor; principalKey: string }): Promise<AuditChangeCapture | null> {
  if (!env.auditCaptureEnabled) return null
  try {
    const policy = await readEffectiveAuditPolicyWithRetry(input.organizationId)
    if (!policy) return null
    return {
      policy,
      context: {
        organizationId: input.organizationId, actor: input.actor, principalKey: input.principalKey, initiatingActor: input.initiatingActor,
        origin: "api", originTrust: "authenticated", requestId: null,
        kind: CONFIG_BLOB_APPLY_JOB_KIND, scope: input.changeRequestId, jobRunId: input.changeRequestId,
      },
    }
  } catch (error) {
    logger.warn("config apply audit capture unavailable; domain emitters fall back to legacy rows", { change_request_id: input.changeRequestId, error_name: error instanceof Error ? error.name : typeof error })
    return null
  }
}

function resolveSecretValues(execution: ExecutionPlan, inputs: readonly ConfigSecretInput[]): { secrets: Map<string, ResolvedConfigSecret>; missing: string[] } {
  const byPath = new Map(inputs.map((input) => [input.path, input]))
  const allowEnv = configAllowEnv()
  const secrets = new Map<string, ResolvedConfigSecret>()
  const missing: string[] = []
  for (const needed of secretsNeedingValues(execution)) {
    if (needed.decision === "value") {
      const input = byPath.get(needed.path)
      if (input?.decision === "value") secrets.set(needed.path, { $secret: needed.path, decision: "value", value: input.value })
      else missing.push(`${needed.path}: no value was entered`)
      continue
    }
    const value = needed.env ? readConfigSecretEnv(needed.env, allowEnv) : null
    if (value !== null) secrets.set(needed.path, { $secret: needed.path, decision: "value", value })
    else missing.push(`${needed.path}: environment variable ${needed.env ?? "(none)"} is not allowed or not set on this server`)
  }
  return { secrets, missing }
}

async function afterRevsOf(ctx: ConfigAreaContext, items: readonly ConfigApplyReportItem[]): Promise<Record<string, string>> {
  const byArea = new Map<ConfigAreaKey, string[]>()
  for (const item of items) {
    if (item.status !== "applied" || item.op === "delete" || !item.localId) continue
    byArea.set(item.area, [...(byArea.get(item.area) ?? []), item.localId])
  }
  const out: Record<string, string> = {}
  for (const [key, ids] of byArea) {
    const area = getConfigArea(key)
    for (const item of await readItemsFor(area, ctx, ids)) out[`${key}/${item.id}`] = itemRev(area, item)
  }
  return out
}

export const CONFIG_APPROVAL_MAX_AGE_MS = 24 * 60 * 60 * 1000
const APPROVAL_EXPIRED_ERROR = "Approval expired: changes are applied within 24 hours of their last approval. Review and approve it again."
const LEASE_LOST_ERROR = "Another worker took over this apply, so it stopped before its next change. Check the apply report, then fix and upload again, or restore the previous config."

function approvalExpired(approval: ConfigChangeRequestApproval, now = Date.now()): boolean {
  const at = Date.parse(approval.at)
  return !Number.isFinite(at) || now - at > CONFIG_APPROVAL_MAX_AGE_MS
}

async function isRecordedExport(sourceOrgId: string | null, hash: string | null): Promise<boolean> {
  if (!sourceOrgId || !hash) return false
  let organizationId: OrganizationId
  try {
    organizationId = normalizeDenTypeId("organization", sourceOrgId)
  } catch {
    return false
  }
  return (await findExportByBaseHash(organizationId, hash)) !== null
}

function applyingApproval(row: ConfigChangeRequestRow): ConfigChangeRequestApproval | null {
  const approvals = currentApprovals(row)
  return approvals[approvals.length - 1] ?? null
}

class ConfigLeaseLostError extends Error {
  constructor() {
    super(LEASE_LOST_ERROR)
    this.name = "ConfigLeaseLostError"
  }
}

function describeApplyError(error: unknown): ConfigApplyFailure {
  if (error instanceof ConfigLeaseLostError) return { code: CONFIG_APPLY_INTERRUPTED_CODE, message: LEASE_LOST_ERROR }
  if (error instanceof ConfigApplyError) {
    const failure: ConfigApplyFailure = { code: error.code, message: storedError(error.message) }
    if (error.status !== undefined) failure.status = error.status
    if (error.field) failure.field = error.field
    return failure
  }
  return { code: "error", message: storedError(errorMessage(error)) }
}

function itemFailureMessage(name: string, message: string): string {
  const separator = message.indexOf(": ")
  if (!name || separator <= 0) return message
  const prefix = message.slice(0, separator)
  const rest = message.slice(separator + 2)
  return prefix.includes(name) && rest.includes(name) ? rest : message
}

function itemFailureError(areaKey: ConfigAreaKey, name: string, message: string): string {
  return name && message.includes(name) ? `${areaLabel(areaKey)}: ${message}` : `${areaLabel(areaKey)} "${name}": ${message}`
}

function storedReportItems(items: readonly ConfigApplyReportItem[]): ConfigApplyReportItem[] {
  return items.map((item) => {
    const out: ConfigApplyReportItem = {
      ...item,
      warnings: item.warnings.map(storedError),
      steps: item.steps.map((step) => (step.detail === undefined ? step : { ...step, detail: storedError(step.detail) })),
    }
    if (item.failure) {
      out.failure = { ...item.failure, message: storedError(itemFailureMessage(item.name, item.failure.message)) }
      if (item.failure.step?.detail !== undefined) out.failure.step = { ...item.failure.step, detail: storedError(item.failure.step.detail) }
    }
    return out
  })
}

function stalePatch(problems: readonly string[]): ChangeRequestPatch {
  return { status: "stale", approvals: [], approvedPlanHash: null, availableAt: new Date(), errors: storedErrors(problems.slice(0, 20)) }
}

async function applyExecution(claim: ClaimedChangeRequest): Promise<{ execution: ExecutionPlan; features: FeatureMap } | { stale: string[] }> {
  const stored = claim.planHash === claim.approvedPlanHash ? parseStoredExecution(claim.execution, claim.approvedPlanHash) : null
  if (stored) return { execution: stored, features: await getOrganizationFeatures(claim.organizationId) }
  const planned = await planChangeRequest(claim)
  if ("invalid" in planned || planned.fatal.length > 0 || planned.plan.planHash !== claim.approvedPlanHash) return { stale: ["The organization changed since this plan was approved."] }
  return { execution: planned.execution, features: planned.ctx.features }
}

export async function applyClaimedChangeRequest(claim: ClaimedChangeRequest): Promise<ConfigChangeRequestStatus | null> {
  const organizationId = claim.organizationId
  const settings = await getConfigBlobSettings(organizationId)
  const approval = applyingApproval(claim)
  if (!approval || !approvalsSatisfied(currentApprovals(claim), settings)) {
    await releaseClaim(claim, { status: "needs_review", approvals: [], approvedPlanHash: null, errors: ["The approval no longer matches this plan."] })
    return "needs_review"
  }
  if (approvalExpired(approval)) {
    await releaseClaim(claim, { status: "needs_review", approvals: [], approvedPlanHash: null, applyRequestedBy: null, errors: [APPROVAL_EXPIRED_ERROR] })
    return "needs_review"
  }

  const actor = await loadActor(organizationId, approval.memberId)
  const refusal = async (message: string): Promise<ConfigChangeRequestStatus> => {
    await releaseClaim(claim, { status: "failed", errors: [storedError(message)], secretInputs: null })
    return "failed"
  }
  if (!actor) return refusal("The person who approved this change is no longer a member of the organization.")
  if (approval.apiKeyId && !await apiKeyUsable(approval.apiKeyId)) return refusal("The config token that approved this change was revoked or expired.")
  if (approval.apiKeyId) {
    const token = await getApiKeySessionById(approval.apiKeyId)
    const outside = writeAreas(claim.plan).filter((area) => !tokenAllows(token ? token.configAreas : [], area))
    if (outside.length > 0) return refusal(`The config token that approved this change can't change ${outside.map(areaLabel).join(", ")}.`)
  }
  const permissions = await resolvePermissionsForMember({ organizationId, memberId: normalizeDenTypeId("member", actor.memberId) })
  const missingPermissions = managePermissions(writeAreas(claim.plan)).filter((key) => !permissions.has(key))
  if (missingPermissions.length > 0) return refusal(`The person who approved this change no longer holds ${missingPermissions.join(", ")}.`)

  const chosen = await applyExecution(claim)
  if ("stale" in chosen) {
    await releaseClaim(claim, stalePatch(chosen.stale))
    return "stale"
  }
  const deployment = configDeployment()
  const unsupported = [...new Set(chosen.execution.ops.map((op) => op.area))].flatMap((key) => {
    const area = registeredArea(key)
    const reason = area ? unsupportedReason(area, deployment, chosen.features) : "not available on this server"
    return reason ? [`${areaLabel(key)}: ${reason}`] : []
  })
  if (unsupported.length > 0) {
    await releaseClaim(claim, stalePatch(unsupported))
    return "stale"
  }

  const decisions = claim.decisions ?? EMPTY_CONFIG_DECISIONS
  const withInvites = withInviteEmails(chosen.execution, decisions.people.sendInviteEmails)
  const { secrets, missing } = resolveSecretValues(withInvites, claim.secretInputs ?? [])
  if (missing.length > 0) return refusal(`Nothing was applied: ${missing.join("; ")}.`)

  const ctx = areaContext(organizationId, { ...actor, apiKeyId: approval.apiKeyId ?? null }, chosen.features)
  const org = await db.$primary.select({ id: OrganizationTable.id, slug: OrganizationTable.slug, name: OrganizationTable.name }).from(OrganizationTable).where(eq(OrganizationTable.id, organizationId)).limit(1)
  const target = org[0]
  if (!target) return refusal("The organization no longer exists.")

  const checked = await checkWrittenItems(withInvites, CONFIG_AREAS, ctx)
  if (checked.problems.length > 0) {
    await releaseClaim(claim, stalePatch(checked.problems))
    return "stale"
  }
  const execution = checked.execution

  if (claim.beforeSnapshot === null || claim.beforeSnapshot === undefined) {
    const writtenAreas = CONFIG_AREA_KEYS.filter((key) => execution.ops.some((op) => op.area === key))
    const snapshotAreas: ExportedArea[] = writtenAreas.map((key) => ({
      area: getConfigArea(key),
      items: [...(checked.before.get(key) ?? [])].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
    }))
    const beforeSnapshot = await assembleBlob(target, snapshotAreas, [])
    if (!await releaseClaimKeepLease(claim, { beforeSnapshot })) return null
  }

  const auditActor: AuditActor = { type: "user", id: actor.userId, memberId: actor.memberId, ...(approval.apiKeyId ? { credentialId: approval.apiKeyId } : {}) }
  const requestedBy = claim.applyRequestedBy ?? { memberId: approval.memberId, at: approval.at, ...(approval.apiKeyId ? { apiKeyId: approval.apiKeyId } : {}) }
  const requester = requestedBy.memberId === actor.memberId ? actor : await loadActor(organizationId, requestedBy.memberId)
  const initiatingActor: AuditActor = requester
    ? { type: "user", id: requester.userId, memberId: requester.memberId, ...(requestedBy.apiKeyId ? { credentialId: requestedBy.apiKeyId } : {}) }
    : auditActor
  const principalKey = auditUserPrincipalKey({ userId: actor.userId, memberId: actor.memberId, credentialId: approval.apiKeyId ?? null })
  const capture = await jobCapture({ organizationId, changeRequestId: claim.id, actor: auditActor, initiatingActor, principalKey })
  const resources: AuditEventInput["resources"] = [
    { type: "config_change_request", id: claim.id, relationship: "target" },
    { type: "organization", id: organizationId, relationship: "parent" },
  ]
  const origin: AuditOrigin = "api"
  const jobBase = { organizationId, jobRunId: claim.id, kind: CONFIG_BLOB_APPLY_JOB_KIND, actor: auditActor, initiatingActor, principalKey, origin, resources }
  const who = {
    requestedBy: { memberId: requestedBy.memberId, apiKeyId: requestedBy.apiKeyId ?? null, at: requestedBy.at },
    runsAs: { memberId: actor.memberId, apiKeyId: approval.apiKeyId ?? null, approvedAt: approval.at },
  }
  await recordAuditJobOutcome({
    ...jobBase,
    action: "config_change_request.apply_started",
    outcome: "unknown",
    reasonCode: "applying",
    changes: { before: { status: "queued" }, after: { status: "applying", ...who }, changedFields: ["status"] },
    idempotencyKey: `config_change_request:${claim.id}:apply:${claim.attempts}:started`,
  })

  const names = await loadMemberNames(organizationId, [requestedBy.memberId, actor.memberId])
  const startedAt = new Date()
  const requestedByApiKeyName = requestedBy.apiKeyId ? await apiKeyName(requestedBy.apiKeyId) : null
  const baseReport: ConfigApplyReport = {
    runId: "",
    attempt: 0,
    status: "running",
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    requestedBy: { memberId: requestedBy.memberId, name: names.get(requestedBy.memberId) ?? null, apiKeyName: requestedByApiKeyName },
    runsAs: { memberId: actor.memberId, name: names.get(actor.memberId) ?? null },
    counts: emptyApplyCounts(),
    failure: null,
    items: pendingReportItems(execution),
    warnings: [],
  }
  const runRow = await createApplyRun({
    organizationId,
    changeRequestId: claim.id,
    requestedByMemberId: memberIdOrNull(requestedBy.memberId),
    requestedByApiKeyId: requestedBy.apiKeyId ?? null,
    runsAsMemberId: memberIdOrNull(actor.memberId),
    report: baseReport,
    startedAt,
  })
  let report: ConfigApplyReport = runRow.report
  const saveReport = async (next: ConfigApplyReport) => {
    report = next
    try {
      await saveApplyRunReport(runRow, next)
    } catch (error) {
      logger.warn("config apply run report save failed", { change_request_id: claim.id, run_id: runRow.id, error_name: error instanceof Error ? error.name : typeof error })
    }
  }

  let leaseLost = false
  const holdLease = async (): Promise<boolean> => {
    if (leaseLost) return false
    try {
      if (!await extendClaim(claim, APPLY_LEASE_MS)) leaseLost = true
    } catch (error) {
      logger.warn("config apply lease extension failed", { change_request_id: claim.id, error_name: error instanceof Error ? error.name : typeof error })
    }
    return !leaseLost
  }
  const keepAlive = setInterval(() => { void holdLease() }, APPLY_LEASE_EXTEND_EVERY_MS)
  keepAlive.unref()
  const leasedAreas: ConfigArea[] = CONFIG_AREAS.map((area) => ({
    ...area,
    apply: async (applyCtx, op) => {
      if (!await holdLease()) throw new ConfigLeaseLostError()
      return area.apply(applyCtx, op)
    },
  }))
  const instanceId = await getConfigInstanceId()
  const reuseIds = reusesSourceIds(claim.sourceInstanceId, instanceId)
  let result: Awaited<ReturnType<typeof executePlan>>
  try {
    result = await runWithAuditJobChangeCapture(capture, () => executePlan(execution, leasedAreas, ctx, secrets, {
      isIdFree: (id, area) => (reuseIds ? isConfigIdFree(organizationId, area, id) : Promise.resolve(false)),
      describeError: describeApplyError,
      onProgress: (items) => saveReport({ ...report, items: storedReportItems(items) }),
    }))
  } catch (error) {
    await saveReport({ ...report, status: "failed", finishedAt: new Date().toISOString(), warnings: [...report.warnings, storedError(errorMessage(error))] })
    throw error
  } finally {
    clearInterval(keepAlive)
  }

  if (claim.sourceInstanceId && result.aliases.length > 0) {
    const created = new Set(result.created.map((entry) => `${entry.area}\u0000${entry.sourceId ?? ""}\u0000${entry.localId}`))
    const trusted = claim.sourceInstanceId !== instanceId || await isRecordedExport(claim.sourceOrgId, claim.baseHash)
    const aliases = result.aliases.filter((alias) => trusted || created.has(`${alias.area}\u0000${alias.sourceId}\u0000${alias.localId}`))
    if (aliases.length > 0) {
      await insertAliases(organizationId, aliases.map((alias) => ({ ...alias, sourceInstanceId: claim.sourceInstanceId ?? "", createdByChangeRequestId: claim.id })))
    }
  }
  const deleted = result.items.flatMap((item) => (item.op === "delete" && item.status === "applied" && item.localId ? [{ area: item.area, localId: item.localId }] : []))
  if (deleted.length > 0) await deleteAliasesForLocalIds(organizationId, deleted)

  const warnings = [...result.warnings]
  let afterRevs: Record<string, string> = {}
  try {
    afterRevs = await afterRevsOf(ctx, result.items)
  } catch (error) {
    warnings.push(`The state after the apply couldn't be read, so a restore will treat every difference as intended: ${errorMessage(error)}`)
  }
  if (leaseLost) warnings.push(LEASE_LOST_ERROR)
  const items = storedReportItems(result.items)
  const ok = result.ok && !leaseLost
  const status: ConfigChangeRequestStatus = ok ? "applied" : "failed"
  await saveReport(summarizeReport({ ...report, items, warnings: warnings.map(storedError), afterRevs, status: ok ? "applied" : "failed", finishedAt: new Date().toISOString() }))
  const errors = items.flatMap((item) => (item.status === "failed" && item.failure ? [storedError(itemFailureError(item.area, item.name, item.failure.message))] : []))
  if (leaseLost && !errors.includes(LEASE_LOST_ERROR)) errors.push(LEASE_LOST_ERROR)
  const released = await releaseClaim(claim, { status, secretInputs: null, appliedAt: new Date(), errors })
  if (!released) {
    await updateChangeRequest(organizationId, claim.id, ["failed"], { secretInputs: null, errors: [...errors, CONFIG_APPLY_INTERRUPTED_ERROR] })
  }
  if (items.some((item) => item.status === "applied")) await markOtherOpenRequestsStale(organizationId, claim.id)

  const count = (op: string) => items.filter((item) => item.status === "applied" && item.op === op).length
  await recordAuditJobOutcome({
    ...jobBase,
    action: "config_change_request.apply_completed",
    outcome: ok ? "succeeded" : "failed",
    reasonCode: ok ? "applied" : leaseLost ? "lease_lost" : "failed",
    changes: {
      before: { status: "applying" },
      after: { status, created: count("create"), updated: count("update") + count("rename"), deleted: count("delete"), failed: items.filter((item) => item.status === "failed").length, ...who },
      changedFields: ["status"],
    },
    idempotencyKey: `config_change_request:${claim.id}:apply:${claim.attempts}:completed`,
  })
  return status
}

function memberIdOrNull(value: string): MemberId | null {
  try {
    return normalizeDenTypeId("member", value)
  } catch {
    return null
  }
}

async function releaseClaimKeepLease(claim: ClaimedChangeRequest, patch: ChangeRequestPatch): Promise<boolean> {
  const updated = await updateChangeRequest(claim.organizationId, claim.id, ["applying"], patch)
  return updated !== null && updated.leaseOwner === claim.leaseOwner
}
