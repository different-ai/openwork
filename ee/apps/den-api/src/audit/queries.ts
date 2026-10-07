import { and, asc, desc, eq, gt, gte, isNotNull, lt, lte, or, sql } from "@openwork-ee/den-db/drizzle"
import { AuditEventResourceTable, AuditEventTable, AuditOperationTable, AuditStateTable } from "@openwork-ee/den-db/schema"
import { parseStoredAuditEnvelope, readAuditPolicy, type AuditDatabase, type AuditTx } from "@openwork-ee/den-db/audit-log"
import { normalizeDenTypeId, typeId } from "@openwork-ee/utils/typeid"
import { auditEventsResponseSchema, auditOperationOutcomeSchema, auditOperationsResponseSchema, auditOriginSchema, auditUsageResponseSchema, type AuditOperationSummary } from "@openwork/types/den/audit"
import { z } from "zod"
import { initializeAuditPolicyInTx, requireAuditFeature } from "./capture.js"
import { AUDIT_CURSOR_TTL_MS, AuditReadError, auditFilterHash, readAuditCursor, signAuditCursor, type AuditCursor, type AuditCursorBinding } from "./cursors.js"

const safeText = (maximum: number) => z.string().min(1).max(maximum).regex(/^[^\u0000-\u001f\u007f]+$/)
const date = z.union([z.string().max(40).datetime({ offset: true }), z.iso.date()]).transform((value) => new Date(value).toISOString())
const filterFields = {
  from: date.optional(),
  to: date.optional(),
  actorId: typeId.schema("user").optional(),
  action: z.string().min(1).max(128).regex(/^[a-z][a-z0-9_.-]*$/).optional(),
  outcome: auditOperationOutcomeSchema.optional(),
  origin: auditOriginSchema.optional(),
  searchId: safeText(255).regex(/^[^\u0080-\u009f]+$/).optional(),
  resourceId: safeText(255).optional(),
  resourceType: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_.-]*$/).optional(),
}
const pageFields = {
  limit: z.string().regex(/^(?:[1-9][0-9]?|100)$/).transform(Number).default(50),
  cursor: z.string().min(1).max(4096).optional(),
}
export const auditPageQuerySchema = z.object(pageFields).strict()
const validFilters = (value: { from?: string; to?: string; resourceId?: string; resourceType?: string }) => (!value.from || !value.to || value.from <= value.to) && (!value.resourceType || !!value.resourceId)
export const auditOperationsQuerySchema = z.object({ ...pageFields, ...filterFields }).strict().refine(validFilters)
export const auditExportQuerySchema = z.object({ ...pageFields, ...filterFields, format: z.enum(["ndjson", "csv"]).default("ndjson") }).strict().refine(validFilters)
type Filters = Omit<z.infer<typeof auditOperationsQuerySchema>, "limit" | "cursor">
type Page = z.infer<typeof auditPageQuerySchema>
type QueryContext = { database: AuditDatabase; organizationId: string; secret: string }

// Reads take no locks. Events are ordered by their time-ordered TypeID. A page
// set is frozen at `visibleBefore`: later events (including later children of
// an existing operation) are excluded. Exports also leave out the last few
// seconds, because IDs are assigned before commit: an append still in flight
// could otherwise commit behind a page boundary that already moved past it.
export const AUDIT_EXPORT_SETTLE_MS = 5_000
type AuditReader = AuditDatabase | AuditTx
type Snapshot = { visibleBefore: number; issuedAt: number; expiresAt: number }

function exists(query: { getSQL: () => ReturnType<typeof sql> }) { return sql`exists (${query})` }
function retained(organizationId: string) {
  return and(eq(AuditOperationTable.organization_id, normalizeDenTypeId("organization", organizationId)), eq(AuditOperationTable.retention_state, "retained"))
}
function eventJoin(organizationId: string) {
  return and(eq(AuditEventTable.org_id, normalizeDenTypeId("organization", organizationId)), eq(AuditEventTable.org_id, AuditOperationTable.organization_id), eq(AuditEventTable.operation_id, AuditOperationTable.id))
}
function eventScope(organizationId: string, visibleBefore: Date) {
  return and(eq(AuditEventTable.org_id, normalizeDenTypeId("organization", organizationId)), isNotNull(AuditEventTable.envelope), isNotNull(AuditEventTable.operation_id), lte(AuditEventTable.created_at, visibleBefore))
}
function resourceMatch(reader: AuditReader, organizationId: string, visibleBefore: Date, resourceId: string, resourceType?: string) {
  return exists(reader.select({ id: AuditEventResourceTable.id }).from(AuditEventResourceTable).innerJoin(AuditEventTable, and(
    eq(AuditEventTable.org_id, normalizeDenTypeId("organization", organizationId)),
    eq(AuditEventResourceTable.organization_id, AuditEventTable.org_id),
    eq(AuditEventResourceTable.event_id, AuditEventTable.id),
    eq(AuditEventResourceTable.operation_id, AuditEventTable.operation_id),
  )).where(and(
    eq(AuditEventResourceTable.organization_id, normalizeDenTypeId("organization", organizationId)),
    eq(AuditEventResourceTable.organization_id, AuditOperationTable.organization_id),
    eq(AuditEventResourceTable.operation_id, AuditOperationTable.id),
    eventScope(organizationId, visibleBefore),
    sql`binary ${AuditEventResourceTable.resource_id} = ${resourceId}`,
    resourceType ? eq(AuditEventResourceTable.resource_type, resourceType) : undefined,
  )).limit(1))
}
function operationFilters(reader: AuditReader, organizationId: string, visibleBefore: Date, filters: Filters) {
  return and(
    retained(organizationId),
    filters.from ? gte(AuditOperationTable.first_recorded_at, new Date(filters.from)) : undefined,
    filters.to ? lte(AuditOperationTable.first_recorded_at, new Date(filters.to)) : undefined,
    filters.actorId ? sql`json_unquote(json_extract(${AuditOperationTable.initiating_actor}, '$.type')) = 'user' and binary json_unquote(json_extract(${AuditOperationTable.initiating_actor}, '$.id')) = ${filters.actorId}` : undefined,
    filters.outcome ? eq(AuditOperationTable.outcome, filters.outcome) : undefined,
    filters.origin ? eq(AuditOperationTable.origin, filters.origin) : undefined,
    filters.action ? exists(reader.select({ id: AuditEventTable.id }).from(AuditEventTable).where(and(eventJoin(organizationId), eventScope(organizationId, visibleBefore), eq(AuditEventTable.action, filters.action))).limit(1)) : undefined,
    filters.searchId ? or(
      sql`binary ${AuditOperationTable.id} = ${filters.searchId}`,
      exists(reader.select({ id: AuditEventTable.id }).from(AuditEventTable).where(and(
        eventJoin(organizationId), eventScope(organizationId, visibleBefore),
        or(sql`binary ${AuditEventTable.id} = ${filters.searchId}`, sql`json_type(json_extract(${AuditEventTable.envelope}, '$.requestId')) = 'STRING' and binary json_unquote(json_extract(${AuditEventTable.envelope}, '$.requestId')) = ${filters.searchId}`),
      )).limit(1)),
      resourceMatch(reader, organizationId, visibleBefore, filters.searchId),
    ) : undefined,
    filters.resourceId ? resourceMatch(reader, organizationId, visibleBefore, filters.resourceId, filters.resourceType) : undefined,
  )
}

async function snapshot(reader: AuditReader, binding: AuditCursorBinding, cursor?: AuditCursor): Promise<Snapshot> {
  await requireAuditFeature(reader, binding.organizationId)
  if (cursor) return { visibleBefore: cursor.visibleBefore, issuedAt: cursor.issuedAt, expiresAt: cursor.expiresAt }
  const issuedAt = Date.now()
  const settle = binding.mode === "export-csv" || binding.mode === "export-ndjson" ? AUDIT_EXPORT_SETTLE_MS : 0
  return { visibleBefore: issuedAt - settle, issuedAt, expiresAt: issuedAt + AUDIT_CURSOR_TTL_MS }
}

function nextCursor(binding: AuditCursorBinding, state: Snapshot, position: AuditCursor["position"], secret: string) {
  return signAuditCursor({ version: 2, ...binding, ...state, position }, secret)
}
function bindingFor(context: QueryContext, mode: AuditCursor["mode"], filters: Filters = {}, operationId: string | null = null): AuditCursorBinding {
  return { organizationId: normalizeDenTypeId("organization", context.organizationId), mode, filterHash: auditFilterHash(filters), operationId: operationId === null ? null : normalizeDenTypeId("auditOperation", operationId) }
}

export async function listAuditOperations(context: QueryContext, query: z.infer<typeof auditOperationsQuerySchema>) {
  const { cursor: token, limit, ...filters } = query
  const binding = bindingFor(context, "operations", filters)
  const cursor = token ? readAuditCursor(token, binding, context.secret) : undefined
  const reader = context.database
  const state = await snapshot(reader, binding, cursor)
  const visibleBefore = new Date(state.visibleBefore)
  const position = cursor?.position
  const rows = await reader.select({
    id: AuditOperationTable.id, kind: AuditOperationTable.kind, scope: AuditOperationTable.scope,
    initiatingActor: AuditOperationTable.initiating_actor, origin: AuditOperationTable.origin, originTrust: AuditOperationTable.origin_trust,
    startedAt: AuditOperationTable.first_recorded_at, outcome: AuditOperationTable.outcome, eventCount: AuditOperationTable.event_count, logicalBytes: AuditOperationTable.logical_bytes,
  }).from(AuditOperationTable).where(and(
    operationFilters(reader, context.organizationId, visibleBefore, filters),
    exists(reader.select({ id: AuditEventTable.id }).from(AuditEventTable).where(and(eventJoin(context.organizationId), eventScope(context.organizationId, visibleBefore))).limit(1)),
    position ? or(lt(AuditOperationTable.first_recorded_at, new Date(position.startedAt)), and(eq(AuditOperationTable.first_recorded_at, new Date(position.startedAt)), lt(AuditOperationTable.id, position.operationId))) : undefined,
  )).orderBy(desc(AuditOperationTable.first_recorded_at), desc(AuditOperationTable.id)).limit(limit + 1)
  const operations: AuditOperationSummary[] = []
  let lastPosition: AuditCursor["position"] | undefined
  for (const row of rows.slice(0, limit)) {
    const [first] = await reader.select({ id: AuditEventTable.id, action: AuditEventTable.action }).from(AuditEventTable).where(and(eventScope(context.organizationId, visibleBefore), eq(AuditEventTable.operation_id, row.id))).orderBy(asc(AuditEventTable.id)).limit(1)
    if (!first) throw new AuditReadError("audit_storage_inconsistent")
    const refs = await reader.select({ type: AuditEventResourceTable.resource_type, id: AuditEventResourceTable.resource_id, relationship: AuditEventResourceTable.relationship, label: AuditEventResourceTable.label }).from(AuditEventResourceTable).where(and(
      eq(AuditEventResourceTable.organization_id, binding.organizationId), eq(AuditEventResourceTable.operation_id, row.id), eq(AuditEventResourceTable.event_id, first.id),
    )).orderBy(asc(AuditEventResourceTable.id)).limit(257)
    if (refs.length > 256) throw new AuditReadError("audit_storage_inconsistent")
    operations.push({ ...row, startedAt: row.startedAt.toISOString(), action: first.action, resources: refs.map(({ label, ...ref }) => ({ ...ref, ...(label === null ? {} : { label }) })) })
    lastPosition = { operationId: row.id, eventId: first.id, startedAt: row.startedAt.toISOString() }
  }
  return auditOperationsResponseSchema.parse({ operations, nextCursor: rows.length > limit && lastPosition ? nextCursor(binding, state, lastPosition, context.secret) : null, snapshotAt: visibleBefore.toISOString() })
}

export async function listAuditEvents(context: QueryContext, query: Page, operationId: string) {
  return eventPage(context, query, bindingFor(context, "events", {}, operationId), {})
}
export async function listAuditExportEvents(context: QueryContext, query: z.infer<typeof auditExportQuerySchema>) {
  const { format, cursor, limit, ...filters } = query
  return eventPage(context, { cursor, limit }, bindingFor(context, format === "csv" ? "export-csv" : "export-ndjson", filters), filters)
}
async function eventPage(context: QueryContext, query: Page, binding: AuditCursorBinding, filters: Filters) {
  const cursor = query.cursor ? readAuditCursor(query.cursor, binding, context.secret) : undefined
  const reader = context.database
  const state = await snapshot(reader, binding, cursor)
  const visibleBefore = new Date(state.visibleBefore)
  if (binding.operationId) {
    const [operation] = await reader.select({ id: AuditOperationTable.id }).from(AuditOperationTable).where(and(retained(context.organizationId), eq(AuditOperationTable.id, binding.operationId))).limit(1)
    if (!operation) throw new AuditReadError("audit_operation_not_found")
  }
  const rows = await reader.select({ id: AuditEventTable.id, operationId: AuditEventTable.operation_id, envelope: AuditEventTable.envelope }).from(AuditEventTable).innerJoin(AuditOperationTable, eventJoin(context.organizationId)).where(and(
    eventScope(context.organizationId, visibleBefore), operationFilters(reader, context.organizationId, visibleBefore, filters),
    binding.operationId ? eq(AuditEventTable.operation_id, binding.operationId) : undefined,
    cursor ? gt(AuditEventTable.id, cursor.position.eventId) : undefined,
  )).orderBy(asc(AuditEventTable.id)).limit(query.limit + 1)
  const events = rows.slice(0, query.limit).map((row) => {
    const envelope = parseStoredAuditEnvelope(row.envelope)
    if (!envelope || envelope.organizationId !== binding.organizationId || envelope.operationId !== row.operationId || envelope.id !== row.id) throw new AuditReadError("audit_storage_inconsistent")
    return envelope
  })
  const last = events.at(-1)
  return auditEventsResponseSchema.parse({ events, nextCursor: rows.length > query.limit && last ? nextCursor(binding, state, { operationId: normalizeDenTypeId("auditOperation", last.operationId), eventId: normalizeDenTypeId("auditEvent", last.id), startedAt: last.operation.startedAt }, context.secret) : null, snapshotAt: visibleBefore.toISOString() })
}

/**
 * Totals come from audit_state, which the scheduled usage refresh recomputes
 * (POST /internal/audit/usage/refresh); measuredAt says when. The append path
 * never updates them, so they lag live activity until the next refresh.
 */
export async function readAuditUsage(context: Pick<QueryContext, "database" | "organizationId">, captureEnabled: boolean) {
  const organizationId = normalizeDenTypeId("organization", context.organizationId)
  return context.database.transaction(async (tx) => {
    const { entitlement, featureEnabled } = await requireAuditFeature(tx, organizationId)
    const captureAvailable = featureEnabled && captureEnabled
    // GET usage can provision a ready org.
    await initializeAuditPolicyInTx(tx, organizationId, captureAvailable)
    const [state] = await tx.select({ retainedOperations: AuditStateTable.retained_operations, eventCount: AuditStateTable.event_count, logicalBytes: AuditStateTable.logical_bytes, measuredAt: AuditStateTable.updated_at }).from(AuditStateTable).where(eq(AuditStateTable.organization_id, organizationId)).limit(1)
    const policy = await readAuditPolicy(tx, organizationId)
    const [oldest] = await tx.select({ startedAt: AuditOperationTable.first_recorded_at }).from(AuditOperationTable).where(retained(organizationId)).orderBy(asc(AuditOperationTable.first_recorded_at), asc(AuditOperationTable.id)).limit(1)
    return auditUsageResponseSchema.parse({ policy, entitlement, captureOn: policy?.enabled ?? false, captureAvailable, captureEnabled: entitlement.enabled && captureAvailable && policy?.enabled === true, retainedOperations: state?.retainedOperations ?? 0, eventCount: state?.eventCount ?? 0, logicalBytes: state?.logicalBytes ?? 0, oldestAvailableAt: oldest?.startedAt.toISOString() ?? null, measuredAt: state?.measuredAt.toISOString() ?? null, billing: "disabled", cleanup: "dry_run", drains: "not_configured" })
  })
}
