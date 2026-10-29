import { and, eq, gte, isNotNull, lt, sql } from "@openwork-ee/den-db/drizzle"
import { AuthSessionTable, MemberTable, TelemetryEventTable } from "@openwork-ee/den-db/schema"
import { adminActiveUsersSchema, adminDashboardSchema } from "@openwork/types/den/admin-organization"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { db } from "../../db.js"
import { adminRoute } from "../../middleware/index.js"
import { forbiddenSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import type { AuthContextVariables } from "../../session.js"
import { readAdminGatewayDashboard } from "../org/gateway-usage.js"

const DAY = 86_400_000
async function activeUsers(now: Date) {
  const today = Math.floor(now.getTime() / DAY) * DAY
  const from = new Date(today - 29 * DAY)
  const end = new Date(today + DAY)
  // Count identities in SQL rather than transferring all user/day pairs. As in
  // existing admin analytics, activity means a sign-in or a telemetry event.
  const activity = db.$with("dashboard_activity").as(db.select({
    userId: sql<string>`${AuthSessionTable.userId}`.as("user_id"), at: sql<Date>`${AuthSessionTable.createdAt}`.as("at"),
  }).from(AuthSessionTable).where(and(gte(AuthSessionTable.createdAt, from), lt(AuthSessionTable.createdAt, end)))
    .unionAll(db.select({ userId: sql<string>`${MemberTable.userId}`.as("user_id"), at: sql<Date>`${TelemetryEventTable.event_timestamp}`.as("at") })
      .from(TelemetryEventTable).innerJoin(MemberTable, eq(TelemetryEventTable.member_id, MemberTable.id))
      .where(and(isNotNull(MemberTable.userId), gte(TelemetryEventTable.event_timestamp, from), lt(TelemetryEventTable.event_timestamp, end)))))
  const [row] = await db.with(activity).select({
    today: sql<number>`count(distinct case when ${activity.at} >= ${new Date(today)} then ${activity.userId} end)`,
    days7: sql<number>`count(distinct case when ${activity.at} >= ${new Date(today - 6 * DAY)} then ${activity.userId} end)`,
    days30: sql<number>`count(distinct ${activity.userId})`,
  }).from(activity)
  return { today: Number(row?.today ?? 0), days7: Number(row?.days7 ?? 0), days30: Number(row?.days30 ?? 0) }
}

export function registerAdminDashboardRoute<T extends { Variables: AuthContextVariables }>(app: Hono<T>) {
  app.get("/v1/admin/dashboard", describeRoute({
    tags: ["Admin"], summary: "Get bounded platform AI usage",
    description: "Returns 30 UTC calendar days of completed gateway usage across organizations, using the same raw and retained accounting as organization reports. Includes accounting coverage, 30 daily totals and at most eight organizations ranked by requests. Platform active users are a separate on-demand read (GET /v1/admin/dashboard/active-users). Does not hydrate features, billing or members.",
    responses: {
      200: jsonResponse("Platform dashboard returned.", adminDashboardSchema),
      401: jsonResponse("Authentication required.", unauthorizedSchema),
      403: jsonResponse("Platform admin access required.", forbiddenSchema),
    },
  }), adminRoute(), async (c) => {
    c.header("Cache-Control", "no-store")
    const usage = await readAdminGatewayDashboard(new Date())
    return c.json({ ...usage, generatedAt: new Date().toISOString() })
  })

  app.get("/v1/admin/dashboard/active-users", describeRoute({
    tags: ["Admin"], summary: "Count platform active users",
    description: "Counts distinct users with a sign-in or telemetry event today, in the last 7 and in the last 30 UTC calendar days, across every organization. This scans 30 days of platform activity, so clients request it explicitly rather than on every dashboard load.",
    responses: {
      200: jsonResponse("Platform active users returned.", adminActiveUsersSchema),
      401: jsonResponse("Authentication required.", unauthorizedSchema),
      403: jsonResponse("Platform admin access required.", forbiddenSchema),
    },
  }), adminRoute(), async (c) => {
    c.header("Cache-Control", "no-store")
    return c.json({ ...await activeUsers(new Date()), generatedAt: new Date().toISOString() })
  })
}
