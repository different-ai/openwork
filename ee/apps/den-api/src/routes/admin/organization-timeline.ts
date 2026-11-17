import { and, desc, eq, or, sql, type SQL, type MySqlTable } from "@openwork-ee/den-db/drizzle"
import { AuditOperationTable, CapabilityUsageEventTable, DesktopStartupReportTable, GatewayRequestLogTable, OrganizationTable, RemoteDeviceEventTable, TelemetryEventTable, WorkflowRunTable } from "@openwork-ee/den-db/schema"
import { isDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { GATEWAY_REQUEST_ROUTES } from "@openwork/types/den/gateway"
import { adminOrganizationTimelineSchema, adminTimelineEntrySchema, adminTimelineKindSchema, adminTimelineSourceSchema, type AdminOrganizationTimeline, type AdminTimelineEntry, type AdminTimelineSource } from "@openwork/types/den/admin-organization-timeline"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { db } from "../../db.js"
import { adminRoute, queryValidator } from "../../middleware/index.js"
import { forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import type { AuthContextVariables } from "../../session.js"

const PAGE_SIZE = 100
export const TIMELINE_SUMMARY_LIMIT = 10_000
const DAY = 86_400_000
const querySchema = z.object({
  days: z.coerce.number().int().min(1).max(30).default(7),
  source: adminTimelineSourceSchema.optional(), failuresOnly: z.enum(["0", "1"]).default("0"),
  cursor: z.string().min(1).max(2048).optional(),
})
const cursorSchema = z.object({
  organizationId: z.string(), since: z.iso.datetime(), until: z.iso.datetime(),
  days: z.number().int().min(1).max(30), source: adminTimelineSourceSchema.optional(), failuresOnly: z.enum(["0", "1"]),
  at: z.iso.datetime(), entrySource: adminTimelineSourceSchema, recordId: z.string().min(1).max(128),
})
type Cursor = z.infer<typeof cursorSchema>
type Window = { since: string; until: string }
type Reader = {
  source: AdminTimelineSource; table: MySqlTable; index: string; organizationId: SQL<string>; at: SQL<Date>; recordId: SQL<string>;
  memberId: SQL<string | null>; kind: SQL<string>; outcome: SQL<string>; branches?: SQL[]; coverage: string;
}
const readers: Reader[] = [
  {
    source: "desktop_startup", table: DesktopStartupReportTable, index: "desktop_startup_report_org_observed",
    organizationId: sql`${DesktopStartupReportTable.organizationId}`, at: sql`${DesktopStartupReportTable.observedAt}`.mapWith(DesktopStartupReportTable.observedAt),
    recordId: sql`${DesktopStartupReportTable.id}`, memberId: sql`${DesktopStartupReportTable.orgMembershipId}`,
    kind: sql`case when ${DesktopStartupReportTable.success} then 'startup_ready' else coalesce(${DesktopStartupReportTable.failureReason}, 'startup_failed') end`,
    outcome: sql`case when ${DesktopStartupReportTable.success} then 'ok' else 'failed' end`,
    coverage: "Reported launches only; reports are retained for up to 30 days.",
  },
  {
    source: "inference_request", table: GatewayRequestLogTable, index: "gateway_request_logs_org_route_started",
    organizationId: sql`${GatewayRequestLogTable.organization_id}`, at: sql`${GatewayRequestLogTable.started_at}`.mapWith(GatewayRequestLogTable.started_at),
    recordId: sql`${GatewayRequestLogTable.id}`, memberId: sql`${GatewayRequestLogTable.org_membership_id}`, kind: sql`${GatewayRequestLogTable.outcome}`,
    outcome: sql`case when ${GatewayRequestLogTable.status} >= 400 or ${GatewayRequestLogTable.outcome} in ('upstream_error', 'upstream_unreachable', 'rejected') then 'failed' when ${GatewayRequestLogTable.outcome} = 'ok' then 'ok' else 'unknown' end`,
    branches: GATEWAY_REQUEST_ROUTES.map((route) => eq(GatewayRequestLogTable.route, route)),
    coverage: "Retained individual requests only; older requests may have been rolled up.",
  },
  {
    source: "capability_use", table: CapabilityUsageEventTable, index: "capability_usage_recent",
    organizationId: sql`${CapabilityUsageEventTable.organization_id}`, at: sql`${CapabilityUsageEventTable.created_at}`.mapWith(CapabilityUsageEventTable.created_at),
    recordId: sql`${CapabilityUsageEventTable.id}`, memberId: sql`${CapabilityUsageEventTable.org_membership_id}`, kind: sql`${CapabilityUsageEventTable.kind}`,
    outcome: sql`case ${CapabilityUsageEventTable.outcome} when 'error' then 'failed' when 'ok' then 'ok' else 'unknown' end`,
    coverage: "Individual uses are retained for about two days. Skill outcomes are not recorded.",
  },
  {
    source: "workflow_run", table: WorkflowRunTable, index: "workflow_run_org_created",
    organizationId: sql`${WorkflowRunTable.organization_id}`, at: sql`${WorkflowRunTable.created_at}`.mapWith(WorkflowRunTable.created_at),
    recordId: sql`${WorkflowRunTable.id}`, memberId: sql`${WorkflowRunTable.org_membership_id}`, kind: sql`${WorkflowRunTable.status}`,
    outcome: sql`case ${WorkflowRunTable.status} when 'failed' then 'failed' when 'succeeded' then 'ok' else 'unknown' end`,
    coverage: "Workflow receipts, including receipts linked to automations; time is when the receipt was saved.",
  },
  {
    source: "audit_operation", table: AuditOperationTable, index: "audit_operation_org_time",
    organizationId: sql`${AuditOperationTable.organization_id}`, at: sql`${AuditOperationTable.first_recorded_at}`.mapWith(AuditOperationTable.first_recorded_at),
    recordId: sql`${AuditOperationTable.id}`, memberId: sql`null`, kind: sql`${AuditOperationTable.kind}`,
    outcome: sql`case ${AuditOperationTable.outcome} when 'failed' then 'failed' when 'partial' then 'failed' when 'succeeded' then 'ok' else 'unknown' end`,
    coverage: "Operation summaries, not individual audit events; capture and retention depend on the team's audit policy.",
  },
  {
    source: "remote_device_event", table: RemoteDeviceEventTable, index: "remote_device_event_organization",
    organizationId: sql`${RemoteDeviceEventTable.organizationId}`, at: sql`${RemoteDeviceEventTable.createdAt}`.mapWith(RemoteDeviceEventTable.createdAt),
    recordId: sql`${RemoteDeviceEventTable.id}`, memberId: sql`null`, kind: sql`${RemoteDeviceEventTable.type}`,
    outcome: sql`case when ${RemoteDeviceEventTable.level} = 'error' or ${RemoteDeviceEventTable.type} = 'failed' then 'failed' else 'unknown' end`,
    coverage: "Reported computer events only; at most 200 events per computer, retained for up to 30 days.",
  },
  {
    source: "client_activity", table: TelemetryEventTable, index: "telemetry_event_org_ts_window",
    organizationId: sql`${TelemetryEventTable.org_id}`, at: sql`${TelemetryEventTable.event_timestamp}`.mapWith(TelemetryEventTable.event_timestamp),
    recordId: sql`${TelemetryEventTable.id}`, memberId: sql`${TelemetryEventTable.member_id}`, kind: sql`${TelemetryEventTable.event_type}`,
    outcome: sql`case when ${TelemetryEventTable.success} = false or ${TelemetryEventTable.event_type} in ('task.failed', 'workbot.greeting_failed') then 'failed' when ${TelemetryEventTable.success} = true or ${TelemetryEventTable.event_type} in ('task.completed', 'workbot.greeting_completed', 'connection.connected') then 'ok' else 'unknown' end`,
    branches: [sql`${TelemetryEventTable.event_type} in ('session.started', 'session.ended', 'task.started', 'task.completed', 'task.failed', 'workbot.greeting_started', 'workbot.greeting_completed', 'workbot.greeting_failed', 'workbot.turn_completed', 'connection.connected')`],
    coverage: "Existing client and worker lifecycle reports only; time is the reported event time. Activity pings are excluded.",
  },
]
const excludedSources = [
  { source: "Connection sign-ins and checks", reason: "Latest readiness is stored on connected_account and external_mcp_connection, not as history. Neither has an organization-and-check-time index." },
  { source: "Automation runs and progress", reason: "automation_run and automation_run_event are indexed by automation or run, not organization and time. Workflow receipts are included separately." },
  { source: "Remote sessions and workers", reason: "remote_session_command, remote_session_request, worker and worker_instance have no organization-and-time index." },
  { source: "Individual audit events", reason: "audit_event has no organization-and-time index. Indexed operation summaries are included instead; platform_audit_event is not organization-scoped." },
  { source: "Connector sync attempts", reason: "connector_sync_event and connector_target_reconcile have no organization-and-time index." },
  { source: "Directory sync attempts", reason: "scim_sync_event is indexed by organization and status, not time. sso_connection stores current test state, not test history." },
  { source: "Event deliveries and background checks", reason: "mcp_event_receipt, mcp_native_delivery, slack_assistant_event, agent_check and agent_member_check have no organization-leading time index." },
  { source: "Installation attempts", reason: "managed_deployment_run, managed_deployment_event and managed_deployment_health are indexed by installation or run, not organization and time." },
  { source: "Legacy task analytics and usage accounting", reason: "Deprecated models_analytics_event and aggregate usage, allowance and policy records are not included. Client lifecycle and retained request records are shown instead." },
]
const utc = (value: string) => value.replace("T", " ").replace("Z", "")
const compareText = (left: string, right: string) => left < right ? 1 : left > right ? -1 : 0
export function compareTimelineEntries(left: AdminTimelineEntry, right: AdminTimelineEntry) {
  return compareText(left.at, right.at) || compareText(left.source, right.source) || compareText(left.recordId, right.recordId)
}

async function readSource(reader: Reader, organizationId: DenTypeId<"organization">, window: Window, limit: number, failuresOnly = false, cursor?: Cursor) {
  const boundary = !cursor ? undefined : or(
    sql`${reader.at} < ${utc(cursor.at)}`,
    reader.source < cursor.entrySource ? sql`${reader.at} = ${utc(cursor.at)}` : reader.source === cursor.entrySource
      ? and(sql`${reader.at} = ${utc(cursor.at)}`, sql`${reader.recordId} < ${cursor.recordId}`) : undefined,
  )
  const branches = reader.branches ?? [sql`true`]
  const rows = await Promise.all(branches.map((branch) => db.select({
    at: reader.at, recordId: reader.recordId, memberId: reader.memberId, kind: reader.kind, outcome: reader.outcome,
  }).from(reader.table, { forceIndex: reader.index }).where(and(
    eq(reader.organizationId, organizationId), sql`${reader.at} >= ${utc(window.since)}`, sql`${reader.at} <= ${utc(window.until)}`,
    branch, boundary, failuresOnly ? eq(reader.outcome, "failed") : undefined,
  )).orderBy(desc(reader.at), desc(reader.recordId)).limit(limit)))
  return rows.flat().map((row) => adminTimelineEntrySchema.parse({
    at: row.at.toISOString(), source: reader.source, outcome: row.outcome,
    kind: adminTimelineKindSchema.safeParse(row.kind).data ?? "unknown", recordId: row.recordId, memberId: row.memberId,
  })).sort(compareTimelineEntries).slice(0, limit)
}

export function summarizeTimelineSource(source: AdminTimelineSource, rows: AdminTimelineEntry[], coverage: string): AdminOrganizationTimeline["sources"][number] {
  const limited = rows.length > TIMELINE_SUMMARY_LIMIT
  const sample = rows.slice(0, TIMELINE_SUMMARY_LIMIT)
  const failureCount = sample.filter((entry) => entry.outcome === "failed").length
  return {
    source, count: sample.length, failureCount, lastSeenAt: sample[0]?.at ?? null, limited, coverage,
    outcome: failureCount ? "failed" : !sample.length || limited || sample.some((entry) => entry.outcome === "unknown") ? "unknown" : "ok",
  }
}

export function registerAdminOrganizationTimelineRoutes<T extends { Variables: AuthContextVariables }>(app: Hono<T>) {
  app.get("/v1/admin/organizations/:organizationId/timeline", describeRoute({
    tags: ["Admin"], summary: "Read an organization's failure and activity timeline",
    description: "Staff-only, read-only diagnostic records for 7 days by default, at most 30. Each indexed source is limited to 101 rows per page and 10,001 rows for the window summary (per inference route); limited summaries are lower bounds. Counts ignore timeline filters. Only retained individual reports are counted, never rolled-up totals. Cursors preserve the window and deterministic timestamp/source/id order. No content or raw error text is returned.",
    responses: {
      200: jsonResponse("Organization timeline returned.", adminOrganizationTimelineSchema),
      400: jsonResponse("Invalid organization, window, filter or cursor.", invalidRequestSchema),
      401: jsonResponse("Authentication required.", unauthorizedSchema), 403: jsonResponse("Platform admin access required.", forbiddenSchema),
      404: jsonResponse("Organization not found.", notFoundSchema),
    },
  }), adminRoute(), queryValidator(querySchema), async (c) => {
    c.header("Cache-Control", "no-store")
    const organizationId = c.req.param("organizationId")
    if (!isDenTypeId("organization", organizationId)) return c.json({ error: "invalid_request", message: "Invalid organization id." }, 400)
    const query = c.req.valid("query")
    let cursor: Cursor | undefined
    if (query.cursor) {
      try { cursor = cursorSchema.parse(JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"))) } catch {
        return c.json({ error: "invalid_request", message: "Invalid timeline cursor." }, 400)
      }
      if (cursor.organizationId !== organizationId || cursor.days !== query.days || cursor.source !== query.source || cursor.failuresOnly !== query.failuresOnly
        || Date.parse(cursor.until) > Date.now() || Date.parse(cursor.until) - Date.parse(cursor.since) !== query.days * DAY
        || cursor.at < cursor.since || cursor.at > cursor.until) {
        return c.json({ error: "invalid_request", message: "The cursor does not match this timeline window or filters." }, 400)
      }
    }
    const [organization] = await db.select({ id: OrganizationTable.id }).from(OrganizationTable).where(eq(OrganizationTable.id, organizationId)).limit(1)
    if (!organization) return c.json({ error: "not_found", message: "Organization not found." }, 404)
    const now = Date.now()
    const window = cursor ? { since: cursor.since, until: cursor.until } : { since: new Date(now - query.days * DAY).toISOString(), until: new Date(now).toISOString() }
    const [summaries, pages] = await Promise.all([
      Promise.all(readers.map(async (reader) => summarizeTimelineSource(reader.source, await readSource(reader, organizationId, window, TIMELINE_SUMMARY_LIMIT + 1), reader.coverage))),
      Promise.all(readers.filter((reader) => !query.source || query.source === reader.source).map((reader) => readSource(reader, organizationId, window, PAGE_SIZE + 1, query.failuresOnly === "1", cursor))),
    ])
    const merged = pages.flat().sort(compareTimelineEntries)
    const entries = merged.slice(0, PAGE_SIZE)
    const last = entries.at(-1)
    const nextCursor = merged.length > PAGE_SIZE && last ? Buffer.from(JSON.stringify({
      organizationId, ...window, days: query.days, source: query.source, failuresOnly: query.failuresOnly,
      at: last.at, entrySource: last.source, recordId: last.recordId,
    } satisfies Cursor)).toString("base64url") : null
    return c.json(adminOrganizationTimelineSchema.parse({ window, entries, sources: summaries, excludedSources, nextCursor }))
  })
}
