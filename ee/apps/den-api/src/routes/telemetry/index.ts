import { and, desc, eq, gte, isNull, sql, type SQL } from "@openwork-ee/den-db/drizzle"
import {
  TelemetryEventTable,
  TelemetryEventType,
  TelemetrySessionDimensionTable,
  MemberTable,
  InvitationTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { db } from "../../db.js"
import { checkEntitlement } from "../../entitlements.js"
import { jsonValidator, orgMemberRoute, queryValidator } from "../../middleware/index.js"
import { enterprisePlanRequiredSchema, invalidRequestSchema, jsonResponse, unauthorizedSchema, emptyResponse } from "../../openapi.js"
import type { AuthContextVariables } from "../../session.js"
import type { UserOrganizationsContext, OrganizationContextVariables } from "../../middleware/index.js"
import { deriveDimensionValue } from "./dimension-value.js"

type TelemetryRouteVariables = AuthContextVariables & Partial<UserOrganizationsContext> & Partial<OrganizationContextVariables>

const allowedEventTypes = new Set<string>(TelemetryEventType)
const allowedSources = new Set(["app", "worker"])
const DIMENSION_METADATA_MAX_BYTES = 4096

const dimensionTypeSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .transform((value) => value.toLowerCase())
  .refine((value) => /^[a-z][a-z0-9_.-]{0,63}$/.test(value), {
    message: "Dimension type must start with a lowercase letter and contain only lowercase letters, numbers, dots, underscores, or hyphens.",
  })

const dimensionValueSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .refine((value) => /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value), {
    message: "Dimension value must contain only letters, numbers, dots, underscores, colons, or hyphens.",
  })

const dimensionMetadataSchema = z
  .record(z.string(), z.unknown())
  .refine((value) => Buffer.byteLength(JSON.stringify(value), "utf8") <= DIMENSION_METADATA_MAX_BYTES, {
    message: "Dimension metadata is too large.",
  })

const telemetryDimensionSchema = z.object({
  type: dimensionTypeSchema,
  value: dimensionValueSchema.optional(),
  label: z.string().trim().min(1).max(255),
  metadata: dimensionMetadataSchema.optional(),
})

const ingestBodySchema = z.object({
  type: z.string().min(1).max(64),
  timestamp: z.string().datetime(),
  source: z.string().max(32).optional(),
  sessionId: z.string().max(128).optional(),
  durationMs: z.number().int().min(0).max(86_400_000).optional(),
  success: z.boolean().optional(),
  dimensions: z.array(telemetryDimensionSchema).max(8).optional(),
})

const ingestBatchSchema = z.object({
  events: z.array(ingestBodySchema).min(1).max(50),
})

const dimensionsQuerySchema = z.object({
  type: dimensionTypeSchema,
})

const analyticsQuerySchema = z
  .object({
    dimensionType: dimensionTypeSchema.optional(),
    dimensionValue: dimensionValueSchema.optional(),
  })
  .refine((value) => {
    return Boolean(value.dimensionType) === Boolean(value.dimensionValue)
  }, {
    message: "dimensionType and dimensionValue must be supplied together.",
  })

const adoptionResponseSchema = z.object({
  members: z.number(),
  pendingInvites: z.number(),
  activeMembers7d: z.number(),
  activeMembers30d: z.number(),
  weeklyTrend: z.array(z.number()),
}).meta({ ref: "TelemetryAdoptionResponse" })

const analyticsWeekSchema = z.object({
  weekStart: z.string(),
  activeMembers: z.number(),
  sessions: z.number(),
  tasksCompleted: z.number(),
  tasksFailed: z.number(),
})

const analyticsResponseSchema = z.object({
  members: z.number(),
  pendingInvites: z.number(),
  activeMembers7d: z.number(),
  activeMembers30d: z.number(),
  sessions7d: z.number(),
  sessions30d: z.number(),
  tasksCompleted7d: z.number(),
  tasksFailed7d: z.number(),
  tasksCompleted30d: z.number(),
  tasksFailed30d: z.number(),
  avgTaskDurationMs30d: z.number().nullable(),
  weekly: z.array(analyticsWeekSchema),
}).meta({ ref: "TelemetryAnalyticsResponse" })

const telemetryDimensionListResponseSchema = z.object({
  items: z.array(z.object({
    type: z.string(),
    value: z.string(),
    label: z.string(),
    sessionCount: z.number(),
    lastSeenAt: z.string(),
  })),
}).meta({ ref: "TelemetryDimensionListResponse" })

const ANALYTICS_WEEKS = 12

type WindowMetrics = {
  activeMembers: number
  sessions: number
  tasksCompleted: number
  tasksFailed: number
  avgTaskDurationMs: number | null
}

type TelemetryOrgId = (typeof TelemetryEventTable.$inferSelect)["org_id"]

type TelemetryDimensionInput = z.infer<typeof telemetryDimensionSchema>

type DimensionFilter = {
  type: string
  value: string
}

type PendingDimensionUpsert = {
  sessionId: string
  source: string
  dimension: TelemetryDimensionInput
  seenAt: Date
}

function normalizeTelemetrySource(source: string | null | undefined) {
  return source && allowedSources.has(source) ? source : "unknown"
}

function dimensionFilterCondition(filter: DimensionFilter): SQL {
  return sql`exists (
    select 1
    from ${TelemetrySessionDimensionTable}
    where ${TelemetrySessionDimensionTable.org_id} = ${TelemetryEventTable.org_id}
      and ${TelemetrySessionDimensionTable.session_id} = ${TelemetryEventTable.session_id}
      and ${TelemetrySessionDimensionTable.source} = coalesce(${TelemetryEventTable.source}, 'unknown')
      and ${TelemetrySessionDimensionTable.dimension_type} = ${filter.type}
      and ${TelemetrySessionDimensionTable.dimension_value} = ${filter.value}
  )`
}

function telemetryWindowConditions(orgId: TelemetryOrgId, since: Date, filter: DimensionFilter | null): SQL[] {
  const conditions = [
    eq(TelemetryEventTable.org_id, orgId),
    gte(TelemetryEventTable.event_timestamp, since),
  ]
  if (filter) conditions.push(dimensionFilterCondition(filter))
  return conditions
}

async function upsertSessionDimension(params: {
  orgId: TelemetryOrgId
  sessionId: string
  source: string
  dimension: TelemetryDimensionInput
  seenAt: Date
}): Promise<void> {
  const value = params.dimension.value ?? deriveDimensionValue(params.dimension.type, params.dimension.label)
  const metadata = params.dimension.metadata ?? null

  await db
    .insert(TelemetrySessionDimensionTable)
    .values({
      id: createDenTypeId("telemetrySessionDimension"),
      org_id: params.orgId,
      session_id: params.sessionId,
      source: params.source,
      dimension_type: params.dimension.type,
      dimension_value: value,
      dimension_label: params.dimension.label,
      metadata,
      created_at: params.seenAt,
      updated_at: params.seenAt,
      last_seen_at: params.seenAt,
    })
    .onDuplicateKeyUpdate({
      set: {
        ...(params.dimension.value ? { dimension_value: params.dimension.value } : {}),
        dimension_label: params.dimension.label,
        metadata,
        updated_at: params.seenAt,
        last_seen_at: params.seenAt,
      },
    })
}

async function loadWindowMetrics(orgId: TelemetryOrgId, since: Date, filter: DimensionFilter | null): Promise<WindowMetrics> {
  const rows = await db
    .select({
      activeMembers: sql<number>`count(distinct ${TelemetryEventTable.member_id})`,
      sessions: sql<number>`count(distinct ${TelemetryEventTable.session_id})`,
      tasksCompleted: sql<number>`coalesce(sum(${TelemetryEventTable.event_type} = 'task.completed'), 0)`,
      tasksFailed: sql<number>`coalesce(sum(${TelemetryEventTable.event_type} = 'task.failed'), 0)`,
      avgTaskDurationMs: sql<number | null>`avg(case when ${TelemetryEventTable.event_type} = 'task.completed' then ${TelemetryEventTable.duration_ms} end)`,
    })
    .from(TelemetryEventTable)
    .where(and(...telemetryWindowConditions(orgId, since, filter)))

  const row = rows[0]
  return {
    activeMembers: Number(row?.activeMembers ?? 0),
    sessions: Number(row?.sessions ?? 0),
    tasksCompleted: Number(row?.tasksCompleted ?? 0),
    tasksFailed: Number(row?.tasksFailed ?? 0),
    avgTaskDurationMs: row?.avgTaskDurationMs == null ? null : Math.round(Number(row.avgTaskDurationMs)),
  }
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
    jsonValidator(ingestBatchSchema),
    async (c) => {
      const orgContext = c.get("organizationContext")
      const orgId = c.get("activeOrganizationId")

      if (!orgContext || !orgId) {
        return c.body(null, 204)
      }

      const memberId = orgContext.currentMember.id
      const body = c.req.valid("json")

      try {
        const acceptedEvents = body.events.filter((event) => allowedEventTypes.has(event.type))
        const rows = acceptedEvents.map((event) => ({
          id: createDenTypeId("telemetryEvent"),
          org_id: orgId,
          member_id: memberId,
          event_type: event.type,
          event_timestamp: new Date(event.timestamp),
          source: event.source && allowedSources.has(event.source) ? event.source : null,
          session_id: event.sessionId ?? null,
          duration_ms: event.durationMs ?? null,
          success: event.success ?? null,
        }))

        if (rows.length > 0) {
          await db.insert(TelemetryEventTable).values(rows)
        }

        const pendingDimensions = new Map<string, PendingDimensionUpsert>()
        for (const event of acceptedEvents) {
          if (!event.sessionId || !event.dimensions?.length) continue
          const source = normalizeTelemetrySource(event.source)
          const seenAt = new Date(event.timestamp)
          for (const dimension of event.dimensions) {
            pendingDimensions.set(`${source}\u0000${event.sessionId}\u0000${dimension.type}`, {
              sessionId: event.sessionId,
              source,
              dimension,
              seenAt,
            })
          }
        }
        for (const pendingDimension of pendingDimensions.values()) {
          await upsertSessionDimension({
            orgId,
            ...pendingDimension,
          })
        }
      } catch {
        // Swallow errors -- telemetry should never break the app
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
    queryValidator(dimensionsQuerySchema),
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
        200: jsonResponse("Adoption metrics returned.", adoptionResponseSchema),
        401: jsonResponse("Caller must be signed in.", unauthorizedSchema),
      },
    }),
    orgMemberRoute({ useUserOrganizations: true }),
    async (c) => {
      const orgId = c.get("activeOrganizationId")

      if (!orgId) {
        return c.json({ members: 0, pendingInvites: 0, activeMembers7d: 0, activeMembers30d: 0, weeklyTrend: [] })
      }

      const now = new Date()
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
      const twelveWeeksAgo = new Date(now.getTime() - 12 * 7 * 24 * 60 * 60 * 1000)

      const [memberRows, inviteRows, active7dRows, active30dRows, weeklyRows] = await Promise.all([
        db
          .select({ count: sql<number>`count(*)` })
          .from(MemberTable)
          .where(and(eq(MemberTable.organizationId, orgId), isNull(MemberTable.removedAt))),
        db
          .select({ count: sql<number>`count(*)` })
          .from(InvitationTable)
          .where(and(eq(InvitationTable.organizationId, orgId), eq(InvitationTable.status, "pending"))),
        db
          .select({ count: sql<number>`count(distinct ${TelemetryEventTable.member_id})` })
          .from(TelemetryEventTable)
          .where(and(
            eq(TelemetryEventTable.org_id, orgId),
            gte(TelemetryEventTable.event_timestamp, sevenDaysAgo),
          )),
        db
          .select({ count: sql<number>`count(distinct ${TelemetryEventTable.member_id})` })
          .from(TelemetryEventTable)
          .where(and(
            eq(TelemetryEventTable.org_id, orgId),
            gte(TelemetryEventTable.event_timestamp, thirtyDaysAgo),
          )),
        db
          .select({
            week: sql<number>`FLOOR(DATEDIFF(${TelemetryEventTable.event_timestamp}, ${twelveWeeksAgo}) / 7)`,
            count: sql<number>`count(distinct ${TelemetryEventTable.member_id})`,
          })
          .from(TelemetryEventTable)
          .where(and(
            eq(TelemetryEventTable.org_id, orgId),
            gte(TelemetryEventTable.event_timestamp, twelveWeeksAgo),
          ))
          .groupBy(sql`FLOOR(DATEDIFF(${TelemetryEventTable.event_timestamp}, ${twelveWeeksAgo}) / 7)`)
          .orderBy(sql`FLOOR(DATEDIFF(${TelemetryEventTable.event_timestamp}, ${twelveWeeksAgo}) / 7)`),
      ])

      const weeklyTrend = Array.from({ length: 12 }, (_, i) => {
        const row = weeklyRows.find((r) => Number(r.week) === i)
        return row ? Number(row.count) : 0
      })

      return c.json({
        members: Number(memberRows[0]?.count ?? 0),
        pendingInvites: Number(inviteRows[0]?.count ?? 0),
        activeMembers7d: Number(active7dRows[0]?.count ?? 0),
        activeMembers30d: Number(active30dRows[0]?.count ?? 0),
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
      description: "Returns Layer 1 (who is using AI) and Layer 2 (how often) analytics for the active org: member counts, active members, session and task volume in 7d/30d windows, average task duration, and a 12-week trend of active members, sessions, and tasks.",
      responses: {
        200: jsonResponse("Analytics returned.", analyticsResponseSchema),
        400: jsonResponse("Invalid analytics query.", invalidRequestSchema),
        401: jsonResponse("Caller must be signed in.", unauthorizedSchema),
        402: jsonResponse("Usage analytics requires an Enterprise plan.", enterprisePlanRequiredSchema),
      },
    }),
    orgMemberRoute(),
    queryValidator(analyticsQuerySchema),
    async (c) => {
      const orgId = c.get("activeOrganizationId")
      const query = c.req.valid("query")
      const dimensionFilter = query.dimensionType && query.dimensionValue
        ? { type: query.dimensionType, value: query.dimensionValue }
        : null

      const empty = {
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
      }

      if (!orgId) {
        return c.json(empty)
      }

      // Same enterprise gate as SSO / desktop policies (see entitlements.ts):
      // collection (/ingest) stays open; only the analytics view is gated.
      const orgContext = c.get("organizationContext")
      const entitlement = checkEntitlement(orgContext?.organization.metadata ?? null, "analytics")
      if (!entitlement.ok) {
        return c.json(entitlement.response, entitlement.status)
      }

      const now = new Date()
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
      const trendStart = new Date(now.getTime() - ANALYTICS_WEEKS * 7 * 24 * 60 * 60 * 1000)

      const [memberRows, inviteRows, window7d, window30d, weeklyRows] = await Promise.all([
        db
          .select({ count: sql<number>`count(*)` })
          .from(MemberTable)
          .where(and(eq(MemberTable.organizationId, orgId), isNull(MemberTable.removedAt))),
        db
          .select({ count: sql<number>`count(*)` })
          .from(InvitationTable)
          .where(and(eq(InvitationTable.organizationId, orgId), eq(InvitationTable.status, "pending"))),
        loadWindowMetrics(orgId, sevenDaysAgo, dimensionFilter),
        loadWindowMetrics(orgId, thirtyDaysAgo, dimensionFilter),
        db
          .select({
            week: sql<number>`FLOOR(DATEDIFF(${TelemetryEventTable.event_timestamp}, ${trendStart}) / 7)`,
            activeMembers: sql<number>`count(distinct ${TelemetryEventTable.member_id})`,
            sessions: sql<number>`count(distinct ${TelemetryEventTable.session_id})`,
            tasksCompleted: sql<number>`coalesce(sum(${TelemetryEventTable.event_type} = 'task.completed'), 0)`,
            tasksFailed: sql<number>`coalesce(sum(${TelemetryEventTable.event_type} = 'task.failed'), 0)`,
          })
          .from(TelemetryEventTable)
          .where(and(...telemetryWindowConditions(orgId, trendStart, dimensionFilter)))
          .groupBy(sql`FLOOR(DATEDIFF(${TelemetryEventTable.event_timestamp}, ${trendStart}) / 7)`)
          .orderBy(sql`FLOOR(DATEDIFF(${TelemetryEventTable.event_timestamp}, ${trendStart}) / 7)`),
      ])

      const weekly = Array.from({ length: ANALYTICS_WEEKS }, (_, i) => {
        const weekStart = new Date(trendStart.getTime() + i * 7 * 24 * 60 * 60 * 1000)
        const row = weeklyRows.find((r) => Number(r.week) === i)
        return {
          weekStart: weekStart.toISOString().slice(0, 10),
          activeMembers: Number(row?.activeMembers ?? 0),
          sessions: Number(row?.sessions ?? 0),
          tasksCompleted: Number(row?.tasksCompleted ?? 0),
          tasksFailed: Number(row?.tasksFailed ?? 0),
        }
      })

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
      })
    },
  )
}
