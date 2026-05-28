import { and, eq, gte, isNull, sql } from "@openwork-ee/den-db/drizzle"
import { TelemetryEventTable, MemberTable, InvitationTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { db } from "../../db.js"
import { requireUserMiddleware, resolveUserOrganizationsMiddleware, resolveOrganizationContextMiddleware, jsonValidator } from "../../middleware/index.js"
import { invalidRequestSchema, jsonResponse, unauthorizedSchema, emptyResponse } from "../../openapi.js"
import type { AuthContextVariables } from "../../session.js"
import type { UserOrganizationsContext, OrganizationContextVariables } from "../../middleware/index.js"

type TelemetryRouteVariables = AuthContextVariables & Partial<UserOrganizationsContext> & Partial<OrganizationContextVariables>

const ingestBodySchema = z.object({
  type: z.string().min(1).max(64),
  timestamp: z.string().datetime(),
})

const ingestBatchSchema = z.object({
  events: z.array(ingestBodySchema).min(1).max(50),
})

const adoptionResponseSchema = z.object({
  members: z.number(),
  pendingInvites: z.number(),
  activeMembers7d: z.number(),
  activeMembers30d: z.number(),
  weeklyTrend: z.array(z.number()),
}).meta({ ref: "TelemetryAdoptionResponse" })

export function registerTelemetryRoutes<T extends { Variables: TelemetryRouteVariables }>(app: Hono<T>) {
  // ── POST /v1/telemetry/ingest ─────────────────────────────────────────────
  app.post(
    "/v1/telemetry/ingest",
    describeRoute({
      tags: ["Telemetry"],
      summary: "Ingest telemetry events",
      description: "Receives a batch of telemetry events from the OpenWork app. Auth provides org and member identity. Always returns 204.",
      responses: {
        204: emptyResponse("Events accepted."),
        400: jsonResponse("Invalid event payload.", invalidRequestSchema),
        401: jsonResponse("Caller must be signed in.", unauthorizedSchema),
      },
    }),
    requireUserMiddleware,
    resolveUserOrganizationsMiddleware,
    resolveOrganizationContextMiddleware,
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
        const rows = body.events.map((event) => ({
          id: createDenTypeId("telemetryEvent"),
          org_id: orgId,
          member_id: memberId,
          event_type: event.type,
          event_timestamp: new Date(event.timestamp),
        }))

        if (rows.length > 0) {
          await db.insert(TelemetryEventTable).values(rows)
        }
      } catch {
        // Swallow errors -- telemetry should never break the app
      }

      return c.body(null, 204)
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
    requireUserMiddleware,
    resolveUserOrganizationsMiddleware,
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
}
