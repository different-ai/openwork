import { and, desc, eq, isNull, sql } from "@openwork-ee/den-db/drizzle"
import {
  TelemetryEventTable,
  TelemetrySessionDimensionTable,
  MemberTable,
  InvitationTable,
} from "@openwork-ee/den-db/schema"
import {
  ANALYTICS_TREND_WEEKS,
  buildSessionDimensionUpsert,
  isKnownTelemetryEventType,
  isKnownTelemetrySource,
  normalizeTelemetrySource,
  readWindowMetrics,
  sessionDimensionKey,
  telemetryAdoptionResponseSchema,
  telemetryAnalyticsQuerySchema,
  telemetryAnalyticsResponseSchema,
  telemetryDimensionListResponseSchema,
  telemetryDimensionsQuerySchema,
  telemetryIngestBatchSchema,
  telemetryWindowConditions,
  weekIndexExpression,
  windowMetricsSelection,
  type DimensionFilter,
  type TelemetryDimensionInput,
  type TelemetryOrgId,
} from "@openwork-ee/telemetry"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { db } from "../../db.js"
import { checkEntitlement } from "../../entitlements.js"
import { jsonValidator, orgMemberRoute, orgRoleRoute, queryValidator } from "../../middleware/index.js"
import { enterprisePlanRequiredSchema, invalidRequestSchema, jsonResponse, unauthorizedSchema, emptyResponse } from "../../openapi.js"
import type { AuthContextVariables } from "../../session.js"
import type { UserOrganizationsContext, OrganizationContextVariables } from "../../middleware/index.js"

type TelemetryRouteVariables = AuthContextVariables & Partial<UserOrganizationsContext> & Partial<OrganizationContextVariables>

const DAY_MS = 24 * 60 * 60 * 1000

async function queryWindowMetrics(orgId: TelemetryOrgId, since: Date, filter: DimensionFilter | null) {
  const rows = await db
    .select(windowMetricsSelection())
    .from(TelemetryEventTable)
    .where(and(...telemetryWindowConditions(orgId, since, filter)))
  return readWindowMetrics(rows[0])
}

export function registerTelemetryRoutes<T extends { Variables: TelemetryRouteVariables }>(app: Hono<T>) {
  // ── POST /v1/telemetry/ingest ─────────────────────────────────────────────
  app.post(
    "/v1/telemetry/ingest",
    describeRoute({
      tags: ["Telemetry"],
      summary: "Ingest telemetry events",
      description: "Receives a batch of telemetry events from the OpenWork app or workers. Auth provides org and member identity. Unknown event types and disallowed fields are dropped. Always returns 204.",
      responses: {
        204: emptyResponse("Events accepted."),
        400: jsonResponse("Invalid event payload.", invalidRequestSchema),
        401: jsonResponse("Caller must be signed in.", unauthorizedSchema),
      },
    }),
    orgMemberRoute(),
    jsonValidator(telemetryIngestBatchSchema),
    async (c) => {
      const orgContext = c.get("organizationContext")
      const orgId = c.get("activeOrganizationId")
      if (!orgContext || !orgId) {
        return c.body(null, 204)
      }

      const memberId = orgContext.currentMember.id
      const batch = c.req.valid("json")

      try {
        const accepted = batch.events.filter((event) => isKnownTelemetryEventType(event.type))

        const eventRows = accepted.map((event) => ({
          id: createDenTypeId("telemetryEvent"),
          org_id: orgId,
          member_id: memberId,
          event_type: event.type,
          event_timestamp: new Date(event.timestamp),
          source: isKnownTelemetrySource(event.source) ? event.source : null,
          session_id: event.sessionId ?? null,
          duration_ms: event.durationMs ?? null,
          success: event.success ?? null,
        }))
        if (eventRows.length > 0) {
          await db.insert(TelemetryEventTable).values(eventRows)
        }

        // Deduplicate dimension sightings within the batch: last write per
        // (source, session, dimension type) wins.
        const pending = new Map<string, { sessionId: string; source: string; dimension: TelemetryDimensionInput; seenAt: Date }>()
        for (const event of accepted) {
          if (!event.sessionId || !event.dimensions?.length) continue
          const source = normalizeTelemetrySource(event.source)
          const seenAt = new Date(event.timestamp)
          for (const dimension of event.dimensions) {
            pending.set(sessionDimensionKey(source, event.sessionId, dimension.type), {
              sessionId: event.sessionId,
              source,
              dimension,
              seenAt,
            })
          }
        }
        for (const sighting of pending.values()) {
          const upsert = buildSessionDimensionUpsert({ orgId, ...sighting })
          await db
            .insert(TelemetrySessionDimensionTable)
            .values(upsert.values)
            .onDuplicateKeyUpdate({ set: upsert.update })
        }
      } catch {
        // Telemetry must never break the app: drop the batch on any failure.
      }

      return c.body(null, 204)
    },
  )

  // ── GET /v1/telemetry/dimensions ──────────────────────────────────────────
  app.get(
    "/v1/telemetry/dimensions",
    describeRoute({
      tags: ["Telemetry"],
      summary: "List telemetry dimension values",
      description: "Returns unique analytics dimension values for the active organization, such as project labels for the project selector.",
      responses: {
        200: jsonResponse("Telemetry dimensions returned.", telemetryDimensionListResponseSchema),
        400: jsonResponse("Invalid dimension query.", invalidRequestSchema),
        401: jsonResponse("Caller must be signed in.", unauthorizedSchema),
      },
    }),
    orgMemberRoute(),
    queryValidator(telemetryDimensionsQuerySchema),
    async (c) => {
      const orgId = c.get("activeOrganizationId")
      if (!orgId) return c.json({ items: [] })

      const query = c.req.valid("query")
      const rows = await db
        .select({
          type: TelemetrySessionDimensionTable.dimension_type,
          value: TelemetrySessionDimensionTable.dimension_value,
          label: sql<string>`max(${TelemetrySessionDimensionTable.dimension_label})`,
          sessionCount: sql<number>`count(distinct ${TelemetrySessionDimensionTable.session_id})`,
          lastSeenAt: sql<Date>`max(${TelemetrySessionDimensionTable.last_seen_at})`,
        })
        .from(TelemetrySessionDimensionTable)
        .where(and(
          eq(TelemetrySessionDimensionTable.org_id, orgId),
          eq(TelemetrySessionDimensionTable.dimension_type, query.type),
        ))
        .groupBy(
          TelemetrySessionDimensionTable.dimension_type,
          TelemetrySessionDimensionTable.dimension_value,
        )
        .orderBy(desc(sql`max(${TelemetrySessionDimensionTable.last_seen_at})`))

      return c.json({
        items: rows.map((row) => ({
          type: row.type,
          value: row.value,
          label: row.label,
          sessionCount: Number(row.sessionCount ?? 0),
          lastSeenAt: row.lastSeenAt instanceof Date ? row.lastSeenAt.toISOString() : new Date(row.lastSeenAt).toISOString(),
        })),
      })
    },
  )

  // ── GET /v1/telemetry/adoption ────────────────────────────────────────────
  app.get(
    "/v1/telemetry/adoption",
    describeRoute({
      tags: ["Telemetry"],
      summary: "Get adoption metrics",
      description: "Returns org adoption metrics: member count, pending invites, active members in 7d and 30d windows, and a 12-week weekly active member trend.",
      responses: {
        200: jsonResponse("Adoption metrics returned.", telemetryAdoptionResponseSchema),
        401: jsonResponse("Caller must be signed in.", unauthorizedSchema),
      },
    }),
    orgMemberRoute({ useUserOrganizations: true }),
    async (c) => {
      const orgId = c.get("activeOrganizationId")
      if (!orgId) {
        return c.json({ members: 0, pendingInvites: 0, activeMembers7d: 0, activeMembers30d: 0, weeklyTrend: [] })
      }

      const now = Date.now()
      const sevenDaysAgo = new Date(now - 7 * DAY_MS)
      const thirtyDaysAgo = new Date(now - 30 * DAY_MS)
      const trendStart = new Date(now - ANALYTICS_TREND_WEEKS * 7 * DAY_MS)
      const weekIndex = weekIndexExpression(trendStart)

      const [memberRows, inviteRows, active7d, active30d, weeklyRows] = await Promise.all([
        db
          .select({ count: sql<number>`count(*)` })
          .from(MemberTable)
          .where(and(eq(MemberTable.organizationId, orgId), isNull(MemberTable.removedAt))),
        db
          .select({ count: sql<number>`count(*)` })
          .from(InvitationTable)
          .where(and(eq(InvitationTable.organizationId, orgId), eq(InvitationTable.status, "pending"))),
        queryWindowMetrics(orgId, sevenDaysAgo, null),
        queryWindowMetrics(orgId, thirtyDaysAgo, null),
        db
          .select({
            week: weekIndex,
            count: sql<number>`count(distinct ${TelemetryEventTable.member_id})`,
          })
          .from(TelemetryEventTable)
          .where(and(...telemetryWindowConditions(orgId, trendStart, null)))
          .groupBy(weekIndex)
          .orderBy(weekIndex),
      ])

      const weeklyTrend = Array.from({ length: ANALYTICS_TREND_WEEKS }, (_, i) => {
        const row = weeklyRows.find((r) => Number(r.week) === i)
        return row ? Number(row.count) : 0
      })

      return c.json({
        members: Number(memberRows[0]?.count ?? 0),
        pendingInvites: Number(inviteRows[0]?.count ?? 0),
        activeMembers7d: active7d.activeMembers,
        activeMembers30d: active30d.activeMembers,
        weeklyTrend,
      })
    },
  )

  // ── GET /v1/telemetry/analytics ───────────────────────────────────────────
  app.get(
    "/v1/telemetry/analytics",
    describeRoute({
      tags: ["Telemetry"],
      summary: "Get usage analytics",
      description: "Returns Layer 1 (who is using AI) and Layer 2 (how often) analytics for the active org: member counts, active members, session and task volume in 7d/30d windows, average task duration, model usage and selection in 30d, and a 12-week trend of active members, sessions, and tasks.",
      responses: {
        200: jsonResponse("Analytics returned.", telemetryAnalyticsResponseSchema),
        400: jsonResponse("Invalid analytics query.", invalidRequestSchema),
        401: jsonResponse("Caller must be signed in.", unauthorizedSchema),
        402: jsonResponse("Usage analytics requires an Enterprise plan.", enterprisePlanRequiredSchema),
      },
    }),
    orgRoleRoute(["admin"]),
    queryValidator(telemetryAnalyticsQuerySchema),
    async (c) => {
      const orgId = c.get("activeOrganizationId")
      const query = c.req.valid("query")
      const dimensionFilter: DimensionFilter | null = query.dimensionType && query.dimensionValue
        ? { type: query.dimensionType, value: query.dimensionValue }
        : null

      if (!orgId) {
        return c.json({
          members: 0,
          pendingInvites: 0,
          activeMembers7d: 0,
          activeMembers30d: 0,
          sessions7d: 0,
          sessions30d: 0,
          tasksCompleted7d: 0,
          tasksFailed7d: 0,
          tasksCompleted30d: 0,
          tasksFailed30d: 0,
          avgTaskDurationMs30d: null,
          weekly: [],
          models: { usage30d: [], selection30d: { default: 0, manual: 0 } },
        })
      }

      // Same enterprise gate as SSO / desktop policies (see entitlements.ts):
      // collection (/ingest) stays open; only the analytics view is gated.
      const orgContext = c.get("organizationContext")
      const entitlement = checkEntitlement(orgContext?.organization.metadata ?? null, "analytics")
      if (!entitlement.ok) {
        return c.json(entitlement.response, entitlement.status)
      }

      const now = Date.now()
      const sevenDaysAgo = new Date(now - 7 * DAY_MS)
      const thirtyDaysAgo = new Date(now - 30 * DAY_MS)
      const trendStart = new Date(now - ANALYTICS_TREND_WEEKS * 7 * DAY_MS)
      const weekIndex = weekIndexExpression(trendStart)

      const [memberRows, inviteRows, window7d, window30d, weeklyRows, modelDimensionRows] = await Promise.all([
        db
          .select({ count: sql<number>`count(*)` })
          .from(MemberTable)
          .where(and(eq(MemberTable.organizationId, orgId), isNull(MemberTable.removedAt))),
        db
          .select({ count: sql<number>`count(*)` })
          .from(InvitationTable)
          .where(and(eq(InvitationTable.organizationId, orgId), eq(InvitationTable.status, "pending"))),
        queryWindowMetrics(orgId, sevenDaysAgo, dimensionFilter),
        queryWindowMetrics(orgId, thirtyDaysAgo, dimensionFilter),
        db
          .select({
            week: weekIndex,
            activeMembers: sql<number>`count(distinct ${TelemetryEventTable.member_id})`,
            sessions: sql<number>`count(distinct ${TelemetryEventTable.session_id})`,
            tasksCompleted: sql<number>`coalesce(sum(${TelemetryEventTable.event_type} = 'task.completed'), 0)`,
            tasksFailed: sql<number>`coalesce(sum(${TelemetryEventTable.event_type} = 'task.failed'), 0)`,
          })
          .from(TelemetryEventTable)
          .where(and(...telemetryWindowConditions(orgId, trendStart, dimensionFilter)))
          .groupBy(weekIndex)
          .orderBy(weekIndex),
        db
          .select({
            type: TelemetrySessionDimensionTable.dimension_type,
            value: TelemetrySessionDimensionTable.dimension_value,
            label: sql<string>`max(${TelemetrySessionDimensionTable.dimension_label})`,
            sessions: sql<number>`count(distinct ${TelemetrySessionDimensionTable.session_id})`,
          })
          .from(TelemetrySessionDimensionTable)
          .innerJoin(TelemetryEventTable, and(
            eq(TelemetryEventTable.org_id, TelemetrySessionDimensionTable.org_id),
            eq(TelemetryEventTable.session_id, TelemetrySessionDimensionTable.session_id),
            sql`coalesce(${TelemetryEventTable.source}, 'unknown') = ${TelemetrySessionDimensionTable.source}`,
          ))
          .where(and(
            eq(TelemetrySessionDimensionTable.org_id, orgId),
            sql`${TelemetrySessionDimensionTable.dimension_type} in ('model', 'model_selection')`,
            ...telemetryWindowConditions(orgId, thirtyDaysAgo, dimensionFilter),
          ))
          .groupBy(
            TelemetrySessionDimensionTable.dimension_type,
            TelemetrySessionDimensionTable.dimension_value,
          )
          .orderBy(desc(sql`count(distinct ${TelemetrySessionDimensionTable.session_id})`)),
      ])

      const weekly = Array.from({ length: ANALYTICS_TREND_WEEKS }, (_, i) => {
        const row = weeklyRows.find((r) => Number(r.week) === i)
        return {
          weekStart: new Date(trendStart.getTime() + i * 7 * DAY_MS).toISOString().slice(0, 10),
          activeMembers: Number(row?.activeMembers ?? 0),
          sessions: Number(row?.sessions ?? 0),
          tasksCompleted: Number(row?.tasksCompleted ?? 0),
          tasksFailed: Number(row?.tasksFailed ?? 0),
        }
      })

      const selectionSessions = (value: "default" | "manual") => Number(
        modelDimensionRows.find((row) => row.type === "model_selection" && row.value === value)?.sessions ?? 0,
      )

      return c.json({
        members: Number(memberRows[0]?.count ?? 0),
        pendingInvites: Number(inviteRows[0]?.count ?? 0),
        activeMembers7d: window7d.activeMembers,
        activeMembers30d: window30d.activeMembers,
        sessions7d: window7d.sessions,
        sessions30d: window30d.sessions,
        tasksCompleted7d: window7d.tasksCompleted,
        tasksFailed7d: window7d.tasksFailed,
        tasksCompleted30d: window30d.tasksCompleted,
        tasksFailed30d: window30d.tasksFailed,
        avgTaskDurationMs30d: window30d.avgTaskDurationMs,
        weekly,
        models: {
          usage30d: modelDimensionRows
            .filter((row) => row.type === "model")
            .map((row) => ({ id: row.value, label: row.label, sessions: Number(row.sessions ?? 0) })),
          selection30d: {
            default: selectionSessions("default"),
            manual: selectionSessions("manual"),
          },
        },
      })
    },
  )
}
