/**
 * Config blobs: the change-request service (docs/features/config-blobs/
 * change-requests.md). Export, upload, analysis, decisions and inputs,
 * approval, apply, revert and cancel. Routes (routes/org/config-blobs.ts) and
 * the worker (./worker.ts) call these; the engine (./engine) stays pure and
 * the adapters (./areas) do the writes.
 *
 * Status flow, as implemented:
 * - submit → `uploaded` (202). Garbage (size, envelope, unknown areas) is a
 *   synchronous 400 and is never stored.
 * - analysis (worker) → `needs_review`, or `invalid` for request-level errors
 *   (unknown area, newer spec version, duplicate ids/keys). Invalid item specs
 *   only block their items. With `autoApply` and approvals still valid for the
 *   same plan hash it goes straight to `queued`.
 * - decisions / inputs re-plan synchronously; a new plan hash, or any secret
 *   value entered, drops approvals (PlanetScale rule; change-requests.md ›
 *   Secret inputs).
 * - approve records `{ memberId, at, apiKeyId? }` against the current plan
 *   hash → `approved` once enough approvals exist (one, or two with the
 *   org's "require a second approver"); `autoApply` or an explicit apply →
 *   `queued`.
 * - apply (worker, one per org) re-plans against the live org: a different
 *   plan hash means drift → `stale` (re-analyzed, approvals dropped). Then the
 *   before-snapshot, the adapters, aliases, secret purge → `applied` /
 *   `failed`; every other open request of the org goes `stale`.
 *
 * Transactions: most adapters call route handlers that open their own
 * organization-locked transactions (`ConfigArea.transactional: false`), so an
 * apply is NOT one database transaction. It stops at the first failing item
 * (later items are reported `skipped`); the before-snapshot is the recovery
 * path (revert).
 */
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
  EMPTY_CONFIG_DECISIONS,
  configBlobSchema,
  flattenConfigAreas,
  isConfigRef,
  isConfigSecret,
  nestConfigAreas,
  parseConfigRef,
  type ConfigApplyReport,
  type ConfigAreaKey,
  type ConfigAreasResponse,
  type ConfigBlob,
  type ConfigBlobArea,
  type ConfigBlobItem,
  type ConfigBlobSecretIndexEntry,
  type ConfigBlobSettings,
  type ConfigChangeRequestStatus,
  type ConfigChangeRequestSummary,
  type ConfigDecisions,
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
import { getOrganizationFeatures, organizationFeatureEnabled, type FeatureMap } from "../features.js"
import { appLogger } from "../observability/logger.js"
import { updateOrganizationMetadata } from "../organization-metadata.js"
import { resolvePermissionsForMember } from "../permissions/resolve.js"
import type { ConfigActor, ConfigArea, ConfigAreaContext, ConfigItem } from "./area.js"
import { SEND_INVITE_EMAIL_FIELD } from "./areas/members-people.js"
import {
  baseHash as computeBaseHash,
  buildPlan,
  executePlan,
  findSecrets,
  secretsNeedingValues,
  itemRev,
  unsupportedReason,
  type ExecutionPlan,
} from "./engine/index.js"
import { configSecretEnvPolicy, readConfigSecretEnv } from "./env-secrets.js"
import { getConfigInstanceId } from "./instance.js"
import { configBlobSchemaUrl } from "./json-schema.js"
import { CONFIG_AREAS, getConfigArea } from "./registry.js"
import {
  CONFIG_APPLY_INTERRUPTED_ERROR,
  createChangeRequest,
  extendClaim,
  findExportByBaseHash,
  getChangeRequest,
  deleteAliasesForLocalIds,
  insertAliases,
  listAliasRows,
  listChangeRequests,
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
  type ClaimedChangeRequest,
  type ConfigChangeRequestId,
  type ConfigChangeRequestRow,
} from "./repository.js"

type OrganizationId = DenTypeId<"organization">
type MemberId = DenTypeId<"member">

const logger = appLogger.child({ component: "config_blobs" })
const SETTINGS_METADATA_KEY = "configBlobs"
const APPLY_LEASE_MS = 600_000
const APPLY_LEASE_EXTEND_EVERY_MS = 60_000
const MAX_ANALYSIS_ATTEMPTS = 3
/** Requests a disabled feature leaves waiting are looked at again after this long. */
const FEATURE_OFF_RETRY_MS = 60_000

// ---------------------------------------------------------------------------
// Errors, callers

/** A refusal with an HTTP status and JSON body the route sends as is. */
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

/** Who calls: the member (for an API key, its issuing member) and the key, if any. */
export type ConfigCaller = ConfigActor & {
  apiKeyId: string | null
  /** Holds `key` (no recent sign-in check: filtering only). */
  can: (key: PermissionKey) => boolean
  /** Config token area limit; null = every area. */
  tokenAreas: readonly string[] | null
  /**
   * Enforces permissions for a write, including the recent sign-in of
   * sensitive keys. Throws ConfigBlobError (the route's permission response).
   */
  authorize: (keys: readonly PermissionKey[]) => Promise<void>
  /**
   * Approving and applying: passes for a config token (D3) and for a person
   * who signed in recently (the organization's fresh-session window); throws
   * ConfigBlobError (`reauth`) otherwise, whatever the areas.
   */
  requireApprovalStepUp: () => void
}

export type ConfigOrganization = { id: OrganizationId; slug: string; name: string; features: FeatureMap }

function tokenAllows(tokenAreas: readonly string[] | null, area: ConfigAreaKey): boolean {
  if (tokenAreas === null) return true
  return tokenAreas.some((entry) => entry === area || (entry.endsWith(".*") && area.startsWith(entry.slice(0, -1))))
}

function canView(caller: Pick<ConfigCaller, "can" | "tokenAreas">, area: ConfigAreaKey): boolean {
  return caller.can(getConfigArea(area).viewPermission) && tokenAllows(caller.tokenAreas, area)
}

function canImport(caller: Pick<ConfigCaller, "can" | "tokenAreas">, area: ConfigAreaKey): boolean {
  return caller.can(getConfigArea(area).managePermission) && tokenAllows(caller.tokenAreas, area)
}

function managePermissions(areas: readonly ConfigAreaKey[]): PermissionKey[] {
  return [...new Set(areas.map((area) => getConfigArea(area).managePermission))]
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

/**
 * An error as stored on the request (`errors`, report items): those columns
 * are not encrypted, and messages can quote blob or provider text. One line,
 * at most 500 characters, and withheld entirely when it looks like a
 * credential (the audit log's redaction, audit/domain/snapshot.ts).
 */
export function storedError(message: string): string {
  const line = message.replace(/[\u0000-\u001f\u007f]+/g, " ").trim()
  const bounded = line.length > STORED_ERROR_MAX ? `${line.slice(0, STORED_ERROR_MAX - 1)}…` : line
  return auditText(bounded, STORED_ERROR_MAX) ?? ""
}

function storedErrors(messages: readonly string[]): string[] {
  return messages.map(storedError)
}

// ---------------------------------------------------------------------------
// Areas

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

/** `?areas=a,b` → known keys in registry order; unknown names are a 400. */
export function parseAreaList(value: string | undefined | null): ConfigAreaKey[] | null {
  if (!value || !value.trim()) return null
  const wanted = value.split(",").map((entry) => entry.trim()).filter(Boolean)
  const unknown = wanted.filter((entry) => !(CONFIG_AREA_KEYS as readonly string[]).includes(entry))
  if (unknown.length > 0) throw new ConfigBlobError(400, { error: "unknown_area", message: `Unknown config area: ${unknown.join(", ")}.`, areas: unknown })
  return CONFIG_AREA_KEYS.filter((key) => wanted.includes(key))
}

// ---------------------------------------------------------------------------
// Export

function areaContext(organizationId: string, actor: ConfigActor, features: FeatureMap): ConfigAreaContext {
  return { db, organizationId, actor: { userId: actor.userId, memberId: actor.memberId }, deployment: configDeployment(), features }
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
    const items = await area.exportItems(ctx)
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

/**
 * Exports the requested areas (default: all) the caller may view. Others are
 * listed in `omitted`. Keeps a copy (`config_blob_export`) as the three-way
 * base for a later import of the same blob into this organization.
 */
export async function exportBlob(org: ConfigOrganization, caller: ConfigCaller, areas: readonly ConfigAreaKey[] | null): Promise<ConfigBlob> {
  const deployment = configDeployment()
  const requested = areas ?? CONFIG_AREA_KEYS
  const omitted: Array<{ area: ConfigAreaKey; reason: string }> = []
  const keys: ConfigAreaKey[] = []
  for (const key of requested) {
    const area = getConfigArea(key)
    const unsupported = unsupportedReason(area, deployment, org.features)
    if (unsupported) omitted.push({ area: key, reason: unsupported })
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
  return blob
}

// ---------------------------------------------------------------------------
// Members and settings

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

/** Normalized email → member id, for members and invited people (their placeholder member rows). */
async function loadPeople(organizationId: OrganizationId): Promise<Map<string, string>> {
  const rows = await db.$primary
    .select({ id: MemberTable.id, userEmail: AuthUserTable.email, inviteEmail: InvitationTable.email })
    .from(MemberTable)
    .leftJoin(AuthUserTable, eq(MemberTable.userId, AuthUserTable.id))
    .leftJoin(InvitationTable, eq(MemberTable.inviteId, InvitationTable.id))
    .where(eq(MemberTable.organizationId, organizationId))
  const people = new Map<string, string>()
  for (const row of rows) {
    const email = (row.userEmail ?? row.inviteEmail)?.trim().toLowerCase()
    if (email && !people.has(email)) people.set(email, row.id)
  }
  return people
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

// ---------------------------------------------------------------------------
// Summaries and reads

async function summaries(organizationId: OrganizationId, rows: Parameters<typeof toChangeRequestSummary>[0][]): Promise<ConfigChangeRequestSummary[]> {
  const names = await loadMemberNames(organizationId, summaryMemberIds(rows))
  return rows.map((row) => toChangeRequestSummary(row, names))
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
  return summaries(organizationId, rows.filter((row) => visibleTo(caller, row.areas)))
}

export async function getChangeRequestDetail(organizationId: OrganizationId, id: string, caller: Pick<ConfigCaller, "can" | "tokenAreas">): Promise<{ changeRequest: ConfigChangeRequestSummary; report: ConfigApplyReport | null }> {
  const row = await loadVisible(organizationId, id, caller)
  return { changeRequest: await summaryOf(row), report: row.report }
}

export async function getChangeRequestPlan(organizationId: OrganizationId, id: string, caller: Pick<ConfigCaller, "can" | "tokenAreas">): Promise<{ plan: ConfigPlan | null; decisions: ConfigDecisions }> {
  const row = await loadVisible(organizationId, id, caller)
  return { plan: row.plan, decisions: row.decisions ?? EMPTY_CONFIG_DECISIONS }
}

export async function getBeforeSnapshot(organizationId: OrganizationId, id: string, caller: Pick<ConfigCaller, "can" | "tokenAreas">): Promise<unknown> {
  const row = await loadVisible(organizationId, id, caller)
  if (row.beforeSnapshot === null || row.beforeSnapshot === undefined) {
    throw new ConfigBlobError(404, { error: "before_snapshot_not_found", message: "This change has no before-snapshot: it was never applied." })
  }
  return row.beforeSnapshot
}

// ---------------------------------------------------------------------------
// Submit

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

/**
 * Stores an upload as a change request (`uploaded`); the worker analyzes it.
 * Rejected synchronously: too large, not a blob, unknown areas, or areas the
 * caller can't import. D5: a newer upload from the same API key and scope
 * supersedes that key's older open ones.
 */
function checkSubmission(caller: ConfigCaller, raw: unknown, options: { internal?: boolean } = {}): { blob: ConfigBlob; scope: ConfigAreaKey[] } {
  // The size limit is for uploads. A revert's blob is this server's own before-snapshot, which a large organization can push past it.
  if (!options.internal && blobBytes(raw) > CONFIG_BLOB_MAX_BYTES) {
    throw new ConfigBlobError(413, { error: "blob_too_large", message: `Config files are limited to ${CONFIG_BLOB_MAX_BYTES / (1024 * 1024)} MB.` })
  }
  const envelope = parseEnvelope(raw)
  if (!envelope.ok) throw new ConfigBlobError(400, { error: "invalid_blob", message: envelope.errors[0] ?? "This isn't an OpenWork config file.", errors: envelope.errors })
  const { blob } = envelope.value
  const scope = CONFIG_AREA_KEYS.filter((key) => blob.scope.includes(key))
  const denied = scope.filter((area) => !canImport(caller, area))
  if (denied.length > 0) {
    throw new ConfigBlobError(403, {
      error: "forbidden",
      message: `You can't import ${denied.map((area) => getConfigArea(area).label).join(", ")}.`,
      areas: denied,
      requiredPermissions: managePermissions(denied),
    })
  }
  return { blob, scope }
}

export type ConfigDryRunResult = { plan: ConfigPlan | null; errors: string[] }

/**
 * `?dryRun=true`: the same checks and analysis as an upload, run at once and
 * stored nowhere (no change request, no supersede, no export copy). `errors`
 * are what would make the request `invalid`; blocking decisions show in
 * `plan.summary.blocking`. Secrets are never involved: no inputs exist yet.
 */
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
  if ("invalid" in planned) return { plan: null, errors: planned.invalid }
  return { plan: planned.plan, errors: planned.fatal }
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
    decisions: options.decisions ?? null,
    autoApply: input.autoApply,
    availableAt: new Date(),
    ...(options.revertsChangeRequestId ? { revertsChangeRequestId: options.revertsChangeRequestId } : {}),
  })
  if (caller.apiKeyId) await supersedeOpenRequestsFromApiKey({ organizationId: org.id, apiKeyId: caller.apiKeyId, areas: scope, exceptId: row.id })
  return summaryOf(row)
}

// ---------------------------------------------------------------------------
// Planning (analysis, re-plans, the pre-apply check)

type Planned = {
  plan: ConfigPlan
  execution: ExecutionPlan
  /** Request-level errors: the request is `invalid`. */
  fatal: string[]
  ctx: ConfigAreaContext
}

/** Areas the plan reads: the scope, their dependencies, and every area a `$ref` points at. */
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
  let grew = true
  while (grew) {
    grew = false
    for (const key of [...needed]) {
      for (const dependency of getConfigArea(key).dependsOn) {
        if (!needed.has(dependency)) {
          needed.add(dependency)
          grew = true
        }
      }
    }
  }
  return needed
}

type GroupedAliases = {
  /** area → source id → local id (the engine's alias tier). */
  aliases: Map<ConfigAreaKey, Map<string, string>>
  /** area → source id → the change request that wrote the alias (provenance shown in the plan). */
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

/** M8: an alias match says which earlier import created it, so a reviewer can tell it from an id match. */
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

/** Areas the planning member (and its config token's area limit) may view: references elsewhere lose their names in the plan. */
async function visibleAreasFor(organizationId: OrganizationId, actor: ConfigActor, apiKeyId: string | null): Promise<Set<ConfigAreaKey>> {
  const permissions = await resolvePermissionsForMember({ organizationId, memberId: normalizeDenTypeId("member", actor.memberId) })
  const token = apiKeyId ? await getApiKeySessionById(apiKeyId) : null
  // A token that is gone sees nothing; an unrestricted one (null) sees what its member sees.
  const tokenAreas = apiKeyId ? (token ? token.configAreas : []) : null
  return new Set(CONFIG_AREA_KEYS.filter((key) => permissions.has(getConfigArea(key).viewPermission) && tokenAllows(tokenAreas, key)))
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

/** What planning reads from a request: a stored row, or an unsaved dry run. */
type PlanSource = Pick<ConfigChangeRequestRow, "organizationId" | "blob" | "mode" | "baseHash" | "createdByMemberId" | "approvals" | "decisions" | "secretInputs" | "apiKeyId">

/** The member a plan is computed for: the creator, else the last approver. Stable, so re-plans hash the same. */
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
    const area = getConfigArea(key)
    if (unsupportedReason(area, deployment, features)) continue
    targetItems.set(key, await area.exportItems(ctx))
  }
  const instanceId = await getConfigInstanceId()
  const sourceInstanceId = blob.source?.instanceId
  const sameOrganization = blob.source?.organization.id === row.organizationId && sourceInstanceId === instanceId
  const decisions = overrides.decisions ?? row.decisions ?? EMPTY_CONFIG_DECISIONS
  const secretInputs = overrides.secretInputs ?? row.secretInputs ?? []
  const grouped = sourceInstanceId ? groupAliases(await listAliasRows(row.organizationId, sourceInstanceId, db.$primary)) : null
  const result = buildPlan({
    areas: CONFIG_AREAS,
    blobAreas: areas,
    scope,
    mode: row.mode,
    targetItems,
    aliases: grouped?.aliases,
    visibleAreas: await visibleAreasFor(row.organizationId, actor, row.apiKeyId),
    decisions,
    secretInputs,
    people: await loadPeople(row.organizationId),
    allowEnv: configAllowEnv(),
    deployment,
    features,
    ...(sourceInstanceId ? { sourceInstanceId } : {}),
    sameOrganization,
    baseSpecs: sameOrganization ? await baseSpecsFor(row.organizationId, row.baseHash) : undefined,
    ctx,
  })
  if (grouped) addAliasProvenance(result.plan, grouped.provenance)
  for (const entry of blob.omitted ?? []) {
    result.plan.issues.push({ level: "warning", message: `${getConfigArea(entry.area).label} was left out of the export: ${entry.reason}`, area: entry.area })
  }
  return { plan: result.plan, execution: result.execution, fatal: result.fatalErrors, ctx }
}

function currentApprovals(row: Pick<ConfigChangeRequestRow, "approvals" | "approvedPlanHash" | "planHash">): ConfigChangeRequestApproval[] {
  return row.planHash && row.approvedPlanHash === row.planHash ? row.approvals : []
}

function approvalsSatisfied(approvals: readonly ConfigChangeRequestApproval[], settings: ConfigBlobSettings): boolean {
  const distinct = new Set(approvals.map((approval) => approval.memberId))
  return distinct.size >= (settings.requireSecondApprover ? 2 : 1)
}

/** The patch a fresh plan implies: status, plan, errors, and approvals dropped when the plan hash moved. */
async function planPatch(row: ConfigChangeRequestRow, planned: Planned | { invalid: string[] }, options: { dropApprovals?: boolean } = {}): Promise<ChangeRequestPatch> {
  // `invalid` is terminal: its secret inputs are deleted at once.
  if ("invalid" in planned) return { status: "invalid", errors: storedErrors(planned.invalid), approvals: [], approvedPlanHash: null, secretInputs: null }
  if (planned.fatal.length > 0) {
    return { status: "invalid", plan: planned.plan, planHash: planned.plan.planHash, errors: storedErrors(planned.fatal), approvals: [], approvedPlanHash: null, secretInputs: null }
  }
  const keep = !options.dropApprovals && row.approvedPlanHash === planned.plan.planHash
  const approvals = keep ? row.approvals : []
  const patch: ChangeRequestPatch = {
    plan: planned.plan,
    planHash: planned.plan.planHash,
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

/** Worker: analyze one claimed request. */
export async function analyzeClaimedChangeRequest(claim: ClaimedChangeRequest): Promise<ConfigChangeRequestStatus | null> {
  if (!await organizationFeatureEnabled(claim.organizationId, "configBlobs")) {
    await releaseClaim(claim, { status: "uploaded", availableAt: new Date(Date.now() + FEATURE_OFF_RETRY_MS), attempts: Math.max(0, claim.attempts - 1) })
    return null
  }
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

// ---------------------------------------------------------------------------
// Decisions and inputs

const EDITABLE_STATUSES: readonly ConfigChangeRequestStatus[] = ["needs_review", "approved", "stale"]

async function replan(row: ConfigChangeRequestRow, change: ChangeRequestPatch & { decisions?: ConfigDecisions; secretInputs?: ConfigSecretInput[] }, options: { dropApprovals?: boolean } = {}) {
  const planned = await planChangeRequest(row, {
    ...(change.decisions ? { decisions: change.decisions } : {}),
    ...(change.secretInputs ? { secretInputs: change.secretInputs } : {}),
  })
  const patch = await planPatch(row, planned, options)
  const updated = await updateChangeRequest(row.organizationId, row.id, [row.status], { ...change, ...patch })
  if (!updated) throw new ConfigBlobError(409, { error: "change_request_moved_on", message: "This change moved on while you were editing it. Reload and try again." })
  return { changeRequest: await summaryOf(updated), plan: updated.plan }
}

async function loadEditable(organizationId: OrganizationId, id: string, caller: ConfigCaller): Promise<ConfigChangeRequestRow> {
  const row = await loadVisible(organizationId, id, caller)
  if (!EDITABLE_STATUSES.includes(row.status)) {
    throw new ConfigBlobError(409, { error: "change_request_not_editable", message: row.status === "uploaded" || row.status === "analyzing" ? "This change is still being analyzed." : "This change can no longer be edited.", status: row.status })
  }
  await caller.authorize(managePermissions(row.areas))
  return row
}

export async function updateDecisions(organizationId: OrganizationId, id: string, caller: ConfigCaller, decisions: ConfigDecisions) {
  const row = await loadEditable(organizationId, id, caller)
  return replan(row, { decisions })
}

/**
 * Merges secret inputs by path (write-only: values are stored encrypted on the
 * request and never returned). Entering a value always drops approvals.
 */
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
  return replan(row, { secretInputs }, { dropApprovals: inputs.some((input) => input.decision === "value") })
}

// ---------------------------------------------------------------------------
// Approve, apply, cancel

function writeAreas(plan: ConfigPlan | null): ConfigAreaKey[] {
  if (!plan) return []
  return plan.areas.filter((area) => area.items.some((item) => item.op === "create" || item.op === "update" || item.op === "rename" || item.op === "delete")).map((area) => area.area)
}

/** L6: who queued the apply, kept for the apply's audit (it runs later, as the last approver). */
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
  await caller.authorize(managePermissions(writeAreas(row.plan)))
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
  return summaryOf(await approveRow(row, caller, planHash))
}

/** Queues an approved request; with `planHash` a request in review is approved first (approve and apply in one call). */
export async function requestApply(organizationId: OrganizationId, id: string, caller: ConfigCaller, planHash: string | undefined): Promise<ConfigChangeRequestSummary> {
  let row = await loadVisible(organizationId, id, caller)
  if (row.status === "queued" || row.status === "applying") return summaryOf(row)
  if (row.status === "needs_review" && planHash) row = await approveRow(row, caller, planHash)
  if (row.status === "queued") return summaryOf(row)
  if (row.status !== "approved") {
    throw new ConfigBlobError(409, { error: "change_request_not_approved", message: row.status === "needs_review" ? "This change needs approval first." : "This change can't be applied now.", status: row.status })
  }
  caller.requireApprovalStepUp()
  await caller.authorize(managePermissions(writeAreas(row.plan)))
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
  return summaryOf(updated)
}

const CANCELLABLE: readonly ConfigChangeRequestStatus[] = CONFIG_CHANGE_REQUEST_OPEN_STATUSES.filter((status) => status !== "applying")

export async function cancelChangeRequest(organizationId: OrganizationId, id: string, caller: ConfigCaller): Promise<ConfigChangeRequestSummary> {
  const row = await loadVisible(organizationId, id, caller)
  if (!CANCELLABLE.includes(row.status)) {
    throw new ConfigBlobError(409, { error: "change_request_not_cancellable", message: row.status === "applying" ? "This change is being applied." : "This change is already closed.", status: row.status })
  }
  if (row.createdByMemberId !== caller.memberId) await caller.authorize(managePermissions(row.areas))
  const updated = await updateChangeRequest(organizationId, row.id, [row.status], { status: "cancelled", secretInputs: null, leaseOwner: null, leaseUntil: null })
  if (!updated) throw new ConfigBlobError(409, { error: "change_request_moved_on", message: "This change moved on. Reload and try again." })
  return summaryOf(updated)
}

// ---------------------------------------------------------------------------
// Revert

/**
 * The blob a revert uploads: the before-snapshot, with
 * - each item's `rev` set to its state right after the apply (`afterRevs`),
 *   so the three-way diff sees "what the apply wrote" as the base: items
 *   nobody touched since revert cleanly, items changed since show as drift;
 * - secret placeholders turned into `keep` (when the source had a value) or
 *   `unset`. Old secret values were never stored, so a revert keeps the
 *   current ones; an item the apply deleted needs its secrets entered again.
 */
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

/**
 * Revert = a new change request (source `revert`) from the before-snapshot,
 * in `mirror` mode over the same scope, with the deletes of every item the
 * original apply created already ticked. It goes through the normal review.
 */
export async function revertChangeRequest(org: ConfigOrganization, id: string, caller: ConfigCaller): Promise<ConfigChangeRequestSummary> {
  const row = await loadVisible(org.id, id, caller)
  if (row.status !== "applied" && row.status !== "failed") {
    throw new ConfigBlobError(409, { error: "change_request_not_revertable", message: "Only an applied change can be reverted.", status: row.status })
  }
  if (row.beforeSnapshot === null || row.beforeSnapshot === undefined) {
    throw new ConfigBlobError(409, { error: "before_snapshot_not_found", message: "This change has no before-snapshot to revert to." })
  }
  if (row.revertedByChangeRequestId) {
    const existing = await getChangeRequest(org.id, row.revertedByChangeRequestId, db.$primary)
    if (existing && CONFIG_CHANGE_REQUEST_OPEN_STATUSES.includes(existing.status)) {
      throw new ConfigBlobError(409, { error: "revert_in_progress", message: "A revert of this change is already open.", changeRequestId: existing.id })
    }
  }
  await caller.authorize(managePermissions(row.areas))
  const created = (row.report?.items ?? []).filter((item) => item.op === "create" && item.status === "applied" && item.localId)
  const decisions: ConfigDecisions = {
    ...EMPTY_CONFIG_DECISIONS,
    deletes: created.flatMap((item) => (item.localId ? [{ area: item.area, targetId: item.localId }] : [])),
  }
  const summary = await submitChangeRequest(org, caller, {
    blob: revertBlob(row.beforeSnapshot, row.report?.afterRevs ?? {}),
    mode: "mirror",
    title: `Revert: ${row.title ?? row.id}`.slice(0, 200),
    autoApply: false,
  }, { source: "revert", revertsChangeRequestId: row.id, decisions })
  await updateChangeRequest(org.id, row.id, [row.status], { revertedByChangeRequestId: normalizeDenTypeId("configChangeRequest", summary.id) })
  return summary
}

// ---------------------------------------------------------------------------
// Apply

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

/**
 * D4 (M6): an id may be reused only when
 * - no row of the area's tables holds it, in any organization, and
 * - it never appeared in this organization's audit history (a deleted item's
 *   id must not come back as a different item under the same audit trail).
 *   Audit history is per organization, so this is one lookup on
 *   `audit_resource_lookup` (organization prefix, resource id; the resource
 *   type is skipped), as the audit log's own resource filter does.
 * Callers only ask for blobs from another instance (see `reusesSourceIds`).
 */
async function isConfigIdFree(organizationId: OrganizationId, area: ConfigAreaKey, id: string): Promise<boolean> {
  for (const name of getConfigArea(area).tables) {
    const entry = tablesWithId().get(name)
    if (!entry) continue
    const rows = await db.$primary.select({ one: sql<number>`1` }).from(entry.table).where(eq(entry.column, id)).limit(1)
    if (rows.length > 0) return false
  }
  const audited = await db.$primary
    .select({ one: sql<number>`1` })
    .from(AuditEventResourceTable)
    // Plain `=` (not `binary`) so the index applies; a case-insensitive hit only means one id fewer reused.
    .where(and(eq(AuditEventResourceTable.organization_id, organizationId), eq(AuditEventResourceTable.resource_id, id)))
    .limit(1)
  return audited.length === 0
}

/**
 * Source ids are reused only for a blob from ANOTHER instance (cloud →
 * self-hosted → cloud). A blob from this instance (a clone into another
 * organization, a re-import after a delete) or with no source always gets new
 * ids plus aliases: its ids are, or were, this instance's own rows.
 */
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

function withInviteEmails(execution: ExecutionPlan, send: boolean): ExecutionPlan {
  if (!send) return execution
  return {
    ...execution,
    ops: execution.ops.map((op) => op.area === "members.people" && op.kind === "create" && op.item
      ? { ...op, item: { ...op.item, spec: { ...op.item.spec, [SEND_INVITE_EMAIL_FIELD]: true } } }
      : op),
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

async function afterRevsOf(ctx: ConfigAreaContext, areas: readonly ConfigAreaKey[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const { area, items } of await exportAreas(ctx, areas)) for (const item of items) out[`${area.key}/${item.id}`] = itemRev(area, item)
  return out
}

/** An apply runs this long after its last approval at most; later, approvals are dropped and it needs review again (M5). */
export const CONFIG_APPROVAL_MAX_AGE_MS = 24 * 60 * 60 * 1000
const APPROVAL_EXPIRED_ERROR = "Approval expired: changes are applied within 24 hours of their last approval. Review and approve it again."
const LEASE_LOST_ERROR = "lease lost: another worker took over this apply, so it stopped before its next change; check the before-snapshot and revert if needed"

function approvalExpired(approval: ConfigChangeRequestApproval, now = Date.now()): boolean {
  const at = Date.parse(approval.at)
  return !Number.isFinite(at) || now - at > CONFIG_APPROVAL_MAX_AGE_MS
}

/** Whether `(source org, baseHash)` is an export this instance recorded (and still keeps). */
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

/** The member an apply runs as: the last approver (for a config token approval, its issuing member). */
function applyingApproval(row: ConfigChangeRequestRow): ConfigChangeRequestApproval | null {
  const approvals = currentApprovals(row)
  return approvals[approvals.length - 1] ?? null
}

/** Worker: apply one claimed request (the org's apply lock is the claim). */
export async function applyClaimedChangeRequest(claim: ClaimedChangeRequest): Promise<ConfigChangeRequestStatus | null> {
  const organizationId = claim.organizationId
  if (!await organizationFeatureEnabled(organizationId, "configBlobs")) {
    await releaseClaim(claim, { status: "queued", availableAt: new Date(Date.now() + FEATURE_OFF_RETRY_MS), attempts: Math.max(0, claim.attempts - 1) })
    return null
  }
  const settings = await getConfigBlobSettings(organizationId)
  const approval = applyingApproval(claim)
  if (!approval || !approvalsSatisfied(currentApprovals(claim), settings)) {
    await releaseClaim(claim, { status: "needs_review", approvals: [], approvedPlanHash: null, errors: ["The approval no longer matches this plan."] })
    return "needs_review"
  }
  // M5: the apply runs as the last approver with a session counted as freshly signed in
  // (areas/route-support.ts). That only holds while the approval itself is recent.
  if (approvalExpired(approval)) {
    await releaseClaim(claim, { status: "needs_review", approvals: [], approvedPlanHash: null, applyRequestedBy: null, errors: [APPROVAL_EXPIRED_ERROR] })
    return "needs_review"
  }

  // The applying member must still be a member holding every area's manage permission (and a config token still usable).
  const actor = await loadActor(organizationId, approval.memberId)
  const refusal = async (message: string): Promise<ConfigChangeRequestStatus> => {
    const error = storedError(message)
    await releaseClaim(claim, { status: "failed", errors: [error], secretInputs: null, report: { items: [], warnings: [error] } })
    return "failed"
  }
  if (!actor) return refusal("The person who approved this change is no longer a member of the organization.")
  if (approval.apiKeyId && !await apiKeyUsable(approval.apiKeyId)) return refusal("The config token that approved this change was revoked or expired.")
  const permissions = await resolvePermissionsForMember({ organizationId, memberId: normalizeDenTypeId("member", actor.memberId) })
  const missingPermissions = managePermissions(writeAreas(claim.plan)).filter((key) => !permissions.has(key))
  if (missingPermissions.length > 0) return refusal(`The person who approved this change no longer holds ${missingPermissions.join(", ")}.`)

  // Drift check: plan again against the organization as it is now.
  const planned = await planChangeRequest(claim)
  if ("invalid" in planned || planned.fatal.length > 0 || planned.plan.planHash !== claim.approvedPlanHash) {
    await releaseClaim(claim, { status: "stale", approvals: [], approvedPlanHash: null, availableAt: new Date() })
    return "stale"
  }

  const decisions = claim.decisions ?? EMPTY_CONFIG_DECISIONS
  const execution = withInviteEmails(planned.execution, decisions.people.sendInviteEmails)
  const { secrets, missing } = resolveSecretValues(execution, claim.secretInputs ?? [])
  if (missing.length > 0) return refusal(`Nothing was applied: ${missing.join("; ")}.`)

  const features = planned.ctx.features
  const ctx = areaContext(organizationId, actor, features)
  const org = await db.$primary.select({ id: OrganizationTable.id, slug: OrganizationTable.slug, name: OrganizationTable.name }).from(OrganizationTable).where(eq(OrganizationTable.id, organizationId)).limit(1)
  const target = org[0]
  if (!target) return refusal("The organization no longer exists.")

  // Before-snapshot of the whole scope (the revert source), not kept as an export. Never overwritten.
  if (claim.beforeSnapshot === null || claim.beforeSnapshot === undefined) {
    const beforeSnapshot = await assembleBlob(target, await exportAreas(ctx, claim.areas), [])
    if (!await releaseClaimKeepLease(claim, { beforeSnapshot })) return null
  }

  // L6: who runs it (the last approver) and who queued it (explicit apply, or the approval that auto-applied).
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

  // M10: the claim is the org's apply lock. Lost (expired and taken over) → stop before the next write.
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
      if (!await holdLease()) throw new Error(LEASE_LOST_ERROR)
      return area.apply(applyCtx, op)
    },
  }))
  const instanceId = await getConfigInstanceId()
  const reuseIds = reusesSourceIds(claim.sourceInstanceId, instanceId)
  let result: Awaited<ReturnType<typeof executePlan>>
  try {
    result = await runWithAuditJobChangeCapture(capture, () => executePlan(execution, leasedAreas, ctx, secrets, {
      isIdFree: (id, area) => (reuseIds ? isConfigIdFree(organizationId, area, id) : Promise.resolve(false)),
    }))
  } finally {
    clearInterval(keepAlive)
  }

  // Aliases. Creates under a new id always get one. A confirmed match ("decision") only when the
  // blob is from another instance or is an export this instance recorded: a hand-made blob claiming
  // to be from here could otherwise pin any source id to any local item (M8).
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

  let afterRevs: Record<string, string> = {}
  try {
    afterRevs = await afterRevsOf(ctx, claim.areas)
  } catch (error) {
    result.warnings.push(storedError(`The state after the apply couldn't be read, so a revert will treat every difference as intended: ${errorMessage(error)}`))
  }
  if (leaseLost) result.warnings.push(LEASE_LOST_ERROR)
  const items = result.items.map((item) => (item.error === undefined ? item : { ...item, error: storedError(item.error) }))
  const report: ConfigApplyReport = { items, warnings: result.warnings, afterRevs }
  const ok = result.ok && !leaseLost
  const status: ConfigChangeRequestStatus = ok ? "applied" : "failed"
  const failures = items.filter((item) => item.status === "failed")
  const errors = failures.map((item) => storedError(`${getConfigArea(item.area).label}: ${item.error ?? "failed"}`))
  if (leaseLost && !errors.includes(LEASE_LOST_ERROR)) errors.push(LEASE_LOST_ERROR)
  const released = await releaseClaim(claim, { status, report, secretInputs: null, appliedAt: new Date(), errors })
  if (!released) {
    // Taken over: the new holder marked it failed (CONFIG_APPLY_INTERRUPTED_ERROR); record what this run did on top.
    await updateChangeRequest(organizationId, claim.id, ["failed"], { report, secretInputs: null, errors: [...errors, CONFIG_APPLY_INTERRUPTED_ERROR] })
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
      after: { status, created: count("create"), updated: count("update") + count("rename"), deleted: count("delete"), failed: failures.length, ...who },
      changedFields: ["status"],
    },
    idempotencyKey: `config_change_request:${claim.id}:apply:${claim.attempts}:completed`,
  })
  return status
}

/** Writes part of a claimed request without giving up its lease. */
async function releaseClaimKeepLease(claim: ClaimedChangeRequest, patch: ChangeRequestPatch): Promise<boolean> {
  const updated = await updateChangeRequest(claim.organizationId, claim.id, ["applying"], patch)
  return updated !== null && updated.leaseOwner === claim.leaseOwner
}
