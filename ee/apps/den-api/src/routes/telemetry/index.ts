import { and, eq, gte, sql } from "@openwork-ee/den-db/drizzle"
import { TelemetryEventTable } from "@openwork-ee/den-db/schema"
import { MemberTable } from "@openwork-ee/den-db/schema"
import { InvitationTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { db } from "../../db.js"
import { requireUserMiddleware, resolveUserOrganizationsMiddleware, jsonValidator } from "../../middleware/index.js"
import { invalidRequestSchema, jsonResponse, unauthorizedSchema, emptyResponse } from "../../openapi.js"
import type { AuthContextVariables } from "../../session.js"
import type { UserOrganizationsContext } from "../../middleware/index.js"

type TelemetryRouteVariables = AuthContextVariables & Partial<UserOrganizationsContext>

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
  activeUsers7d: z.number(),
  activeUsers30d: z.number(),
  weeklyTrend: z.array(z.number()),
}).meta({ ref: "TelemetryAdoptionResponse" })

export function registerTelemetryRoutes<T extends { Variables: TelemetryRouteVariables }>(app: Hono<T>) {
  // ── POST /v1/telemetry/ingest ─────────────────────────────────────────────
  app.post(
    "/v1/telemetry/ingest",
    describeRoute({
      tags: ["Telemetry"],
      summary: "Ingest telemetry events",
      description: "Receives a batch of telemetry events from the OpenWork app. Auth provides org and user identity. Always returns 204.",
      responses: {
        204: emptyResponse("Events accepted."),
        400: jsonResponse("Invalid event payload.", invalidRequestSchema),
        401: jsonResponse("Caller must be signed in.", unauthorizedSchema),
      },
    }),
    requireUserMiddleware,
    resolveUserOrganizationsMiddleware,
    jsonValidator(ingestBatchSchema),
    async (c) => {
      const user = c.get("user")
      const orgId = c.get("activeOrganizationId")

      if (!user?.id || !orgId) {
        return c.body(null, 204)
      }

      const body = c.req.valid("json")

      try {
        const rows = body.events.map((event) => ({
          id: createDenTypeId("telemetryEvent"),
          org_id: orgId,
          user_id: user.id,
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
      description: "Returns org adoption metrics: member count, pending invites, active users in 7d and 30d windows, and a 12-week weekly active user trend.",
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
        return c.json({ members: 0, pendingInvites: 0, activeUsers7d: 0, activeUsers30d: 0, weeklyTrend: [] })
      }

      const now = new Date()
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
      const twelveWeeksAgo = new Date(now.getTime() - 12 * 7 * 24 * 60 * 60 * 1000)

      const [memberRows, inviteRows, active7dRows, active30dRows, weeklyRows] = await Promise.all([
        db
          .select({ count: sql<number>`count(*)` })
          .from(MemberTable)
          .where(eq(MemberTable.organizationId, orgId)),
        db
          .select({ count: sql<number>`count(*)` })
          .from(InvitationTable)
          .where(and(eq(InvitationTable.organizationId, orgId), eq(InvitationTable.status, "pending"))),
        db
          .select({ count: sql<number>`count(distinct ${TelemetryEventTable.user_id})` })
          .from(TelemetryEventTable)
          .where(and(
            eq(TelemetryEventTable.org_id, orgId),
            gte(TelemetryEventTable.event_timestamp, sevenDaysAgo),
          )),
        db
          .select({ count: sql<number>`count(distinct ${TelemetryEventTable.user_id})` })
          .from(TelemetryEventTable)
          .where(and(
            eq(TelemetryEventTable.org_id, orgId),
            gte(TelemetryEventTable.event_timestamp, thirtyDaysAgo),
          )),
        db
          .select({
            week: sql<number>`FLOOR(DATEDIFF(${TelemetryEventTable.event_timestamp}, ${twelveWeeksAgo}) / 7)`,
            count: sql<number>`count(distinct ${TelemetryEventTable.user_id})`,
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
        activeUsers7d: Number(active7dRows[0]?.count ?? 0),
        activeUsers30d: Number(active30dRows[0]?.count ?? 0),
        weeklyTrend,
      })
    },
  )
}
