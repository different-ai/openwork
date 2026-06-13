import { and, asc, desc, eq, gte, inArray, isNotNull, sql } from "@openwork-ee/den-db/drizzle"
import {
  AuthAccountTable,
  AuthSessionTable,
  AuthUserTable,
  InvitationTable,
  MemberTable,
  TelemetryEventTable,
  WorkerTable,
  AdminAllowlistTable,
} from "@openwork-ee/den-db/schema"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { getCloudWorkerAdminBillingStatus } from "../../billing/polar.js"
import { db } from "../../db.js"
import { queryValidator, requireAdminMiddleware } from "../../middleware/index.js"
import { denTypeIdSchema, invalidRequestSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import type { AuthContextVariables } from "../../session.js"

type UserId = typeof AuthUserTable.$inferSelect.id

const overviewQuerySchema = z.object({
  includeBilling: z.string().optional(),
})

const adminOverviewResponseSchema = z.object({
  viewer: z.object({
    id: denTypeIdSchema("user"),
    email: z.string(),
    name: z.string().nullable(),
  }),
  admins: z.array(z.object({}).passthrough()),
  summary: z.object({}).passthrough(),
  users: z.array(z.object({}).passthrough()),
  generatedAt: z.string().datetime(),
}).meta({ ref: "AdminOverviewResponse" })

function normalizeEmail(value: string | null | undefined) {
  return value?.trim().toLowerCase() ?? ""
}

function toNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }

  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function isWithinDays(value: Date | string | null, days: number) {
  if (!value) {
    return false
  }

  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) {
    return false
  }

  const windowMs = days * 24 * 60 * 60 * 1000
  return Date.now() - date.getTime() <= windowMs
}

function normalizeProvider(providerId: string) {
  const normalized = providerId.trim().toLowerCase()
  if (!normalized) {
    return "unknown"
  }

  if (normalized === "credential" || normalized === "email-password") {
    return "email"
  }

  return normalized
}

function toDayKey(value: Date | string | null): string | null {
  if (!value) {
    return null
  }

  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) {
    return null
  }

  return date.toISOString().slice(0, 10)
}

function toTimestamp(value: Date | string | null): number | null {
  if (!value) {
    return null
  }

  const date = value instanceof Date ? value : new Date(value)
  const time = date.getTime()
  return Number.isNaN(time) ? null : time
}

function median(values: number[]): number | null {
  if (values.length === 0) {
    return null
  }

  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function parseBooleanQuery(value: string | undefined): boolean {
  if (!value) {
    return false
  }

  const normalized = value.trim().toLowerCase()
  return normalized === "1" || normalized === "true" || normalized === "yes"
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, mapper: (item: T) => Promise<R>) {
  if (items.length === 0) {
    return [] as R[]
  }

  const results = new Array<R>(items.length)
  let nextIndex = 0

  async function runWorker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex
      nextIndex += 1
      results[currentIndex] = await mapper(items[currentIndex])
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length))
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()))
  return results
}

export function registerAdminRoutes<T extends { Variables: AuthContextVariables }>(app: Hono<T>) {
  app.get(
    "/v1/admin/overview",
    describeRoute({
      tags: ["Admin"],
      summary: "Get admin overview",
      description: "Returns a high-level administrative overview of users, sessions, workers, admins, and optional billing data for Den operations.",
      responses: {
        200: jsonResponse("Administrative overview returned successfully.", adminOverviewResponseSchema),
        400: jsonResponse("The admin overview query parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be an authenticated admin.", unauthorizedSchema),
      },
    }),
    requireAdminMiddleware,
    queryValidator(overviewQuerySchema),
    async (c) => {
    const user = c.get("user")
    const query = c.req.valid("query")
    const includeBilling = parseBooleanQuery(query.includeBilling)

    const activityWindowDays = 90
    const seriesWindowDays = 30
    const activityWindowStart = new Date(Date.now() - activityWindowDays * 24 * 60 * 60 * 1000)

    const sessionDayExpr = sql<string>`date_format(${AuthSessionTable.createdAt}, '%Y-%m-%d')`
    const telemetryDayExpr = sql<string>`date_format(${TelemetryEventTable.event_timestamp}, '%Y-%m-%d')`

    const [admins, users, workerStatsRows, sessionStatsRows, accountRows, sessionDayRows, telemetryDayRows, taskDayRows, inviteStatsRows] = await Promise.all([
      db
        .select({
          email: AdminAllowlistTable.email,
          note: AdminAllowlistTable.note,
          createdAt: AdminAllowlistTable.created_at,
        })
        .from(AdminAllowlistTable)
        .orderBy(asc(AdminAllowlistTable.email)),
      db.select().from(AuthUserTable).orderBy(desc(AuthUserTable.createdAt)),
      db
        .select({
          userId: WorkerTable.created_by_user_id,
          workerCount: sql<number>`count(*)`,
          cloudWorkerCount: sql<number>`sum(case when ${WorkerTable.destination} = 'cloud' then 1 else 0 end)`,
          localWorkerCount: sql<number>`sum(case when ${WorkerTable.destination} = 'local' then 1 else 0 end)`,
          latestWorkerCreatedAt: sql<Date | null>`max(${WorkerTable.created_at})`,
        })
        .from(WorkerTable)
        .where(isNotNull(WorkerTable.created_by_user_id))
        .groupBy(WorkerTable.created_by_user_id),
      db
        .select({
          userId: AuthSessionTable.userId,
          sessionCount: sql<number>`count(*)`,
          lastSeenAt: sql<Date | null>`max(${AuthSessionTable.updatedAt})`,
        })
        .from(AuthSessionTable)
        .groupBy(AuthSessionTable.userId),
      db
        .select({
          userId: AuthAccountTable.userId,
          providerId: AuthAccountTable.providerId,
        })
        .from(AuthAccountTable),
      db
        .select({
          userId: AuthSessionTable.userId,
          day: sessionDayExpr,
        })
        .from(AuthSessionTable)
        .groupBy(AuthSessionTable.userId, sessionDayExpr),
      // Non-fatal: telemetry_event may be missing in environments that never
      // ran its migration; activity then degrades to sign-in days only.
      db
        .select({
          userId: MemberTable.userId,
          day: telemetryDayExpr,
          lastEventAt: sql<Date | null>`max(${TelemetryEventTable.event_timestamp})`,
        })
        .from(TelemetryEventTable)
        .innerJoin(MemberTable, eq(TelemetryEventTable.member_id, MemberTable.id))
        .where(gte(TelemetryEventTable.event_timestamp, activityWindowStart))
        .groupBy(MemberTable.userId, telemetryDayExpr)
        .catch(() => []),
      // "Real" activity: the user executed at least one task in a session
      // that day — not just a sign-in or a heartbeat ping.
      db
        .select({
          userId: MemberTable.userId,
          day: telemetryDayExpr,
        })
        .from(TelemetryEventTable)
        .innerJoin(MemberTable, eq(TelemetryEventTable.member_id, MemberTable.id))
        .where(and(
          gte(TelemetryEventTable.event_timestamp, activityWindowStart),
          inArray(TelemetryEventTable.event_type, ["task.started", "task.completed", "task.failed"]),
          isNotNull(TelemetryEventTable.session_id),
        ))
        .groupBy(MemberTable.userId, telemetryDayExpr)
        .catch(() => []),
      db
        .select({
          inviterId: InvitationTable.inviterId,
          invitesSent: sql<number>`count(*)`,
          firstInviteAt: sql<Date | null>`min(${InvitationTable.createdAt})`,
        })
        .from(InvitationTable)
        .groupBy(InvitationTable.inviterId),
    ])

    const workerStatsByUser = new Map<UserId, {
      workerCount: number
      cloudWorkerCount: number
      localWorkerCount: number
      latestWorkerCreatedAt: Date | string | null
    }>()

    for (const row of workerStatsRows) {
      if (!row.userId) {
        continue
      }

      workerStatsByUser.set(row.userId, {
        workerCount: toNumber(row.workerCount),
        cloudWorkerCount: toNumber(row.cloudWorkerCount),
        localWorkerCount: toNumber(row.localWorkerCount),
        latestWorkerCreatedAt: row.latestWorkerCreatedAt,
      })
    }

    const sessionStatsByUser = new Map<UserId, {
      sessionCount: number
      lastSeenAt: Date | string | null
    }>()

    for (const row of sessionStatsRows) {
      sessionStatsByUser.set(row.userId, {
        sessionCount: toNumber(row.sessionCount),
        lastSeenAt: row.lastSeenAt,
      })
    }

    const providersByUser = new Map<UserId, Set<string>>()
    for (const row of accountRows) {
      const providerId = normalizeProvider(row.providerId)
      const existing = providersByUser.get(row.userId) ?? new Set<string>()
      existing.add(providerId)
      providersByUser.set(row.userId, existing)
    }

    type ActivityStats = {
      days: Set<string>
      lastTelemetryAt: number | null
    }

    const activityByUser = new Map<UserId, ActivityStats>()
    const getActivity = (userId: UserId): ActivityStats => {
      let stats = activityByUser.get(userId)
      if (!stats) {
        stats = { days: new Set(), lastTelemetryAt: null }
        activityByUser.set(userId, stats)
      }
      return stats
    }

    const seriesStartKey = toDayKey(new Date(Date.now() - (seriesWindowDays - 1) * 24 * 60 * 60 * 1000)) ?? ""
    const activeUsersByDay = new Map<string, Set<UserId>>()
    const realActiveUsersByDay = new Map<string, Set<UserId>>()
    const markDay = (target: Map<string, Set<UserId>>, day: string, userId: UserId) => {
      if (day < seriesStartKey) {
        return
      }

      const set = target.get(day) ?? new Set<UserId>()
      set.add(userId)
      target.set(day, set)
    }
    const markActiveDay = (day: string, userId: UserId) => markDay(activeUsersByDay, day, userId)

    for (const row of sessionDayRows) {
      if (!row.day) {
        continue
      }

      getActivity(row.userId).days.add(row.day)
      markActiveDay(row.day, row.userId)
    }

    for (const row of telemetryDayRows) {
      if (!row.userId) {
        continue
      }

      const stats = getActivity(row.userId)
      if (row.day) {
        stats.days.add(row.day)
        markActiveDay(row.day, row.userId)
      }

      const eventTime = toTimestamp(row.lastEventAt)
      if (eventTime !== null && (stats.lastTelemetryAt === null || eventTime > stats.lastTelemetryAt)) {
        stats.lastTelemetryAt = eventTime
      }
    }

    for (const row of taskDayRows) {
      if (!row.userId || !row.day) {
        continue
      }

      markDay(realActiveUsersByDay, row.day, row.userId)
    }

    const inviteStatsByUser = new Map<UserId, { invitesSent: number; firstInviteAt: Date | string | null }>()
    for (const row of inviteStatsRows) {
      inviteStatsByUser.set(row.inviterId, {
        invitesSent: toNumber(row.invitesSent),
        firstInviteAt: row.firstInviteAt,
      })
    }

    const signupsByDay = new Map<string, number>()
    for (const entry of users) {
      const day = toDayKey(entry.createdAt)
      if (day) {
        signupsByDay.set(day, (signupsByDay.get(day) ?? 0) + 1)
      }
    }

    const todayKey = toDayKey(new Date())
    const activitySeries: Array<{ day: string; activeUsers: number; realActiveUsers: number; signups: number }> = []
    const active7d = new Set<UserId>()
    const active30d = new Set<UserId>()
    const realActive7d = new Set<UserId>()
    const realActive30d = new Set<UserId>()
    for (let offset = seriesWindowDays - 1; offset >= 0; offset -= 1) {
      const day = toDayKey(new Date(Date.now() - offset * 24 * 60 * 60 * 1000))
      if (!day) {
        continue
      }

      const activeSet = activeUsersByDay.get(day)
      const realActiveSet = realActiveUsersByDay.get(day)
      activitySeries.push({
        day,
        activeUsers: activeSet?.size ?? 0,
        realActiveUsers: realActiveSet?.size ?? 0,
        signups: signupsByDay.get(day) ?? 0,
      })
      if (activeSet) {
        for (const id of activeSet) {
          active30d.add(id)
          if (offset <= 6) {
            active7d.add(id)
          }
        }
      }
      if (realActiveSet) {
        for (const id of realActiveSet) {
          realActive30d.add(id)
          if (offset <= 6) {
            realActive7d.add(id)
          }
        }
      }
    }
    const activeUsers1d = todayKey ? (activeUsersByDay.get(todayKey)?.size ?? 0) : 0
    const realActiveUsers1d = todayKey ? (realActiveUsersByDay.get(todayKey)?.size ?? 0) : 0

    const defaultBilling = {
      status: "unavailable" as const,
      featureGateEnabled: false,
      subscriptionId: null,
      subscriptionStatus: null,
      currentPeriodEnd: null,
      source: "unavailable" as const,
      note: "Billing lookup unavailable.",
    }

    const billingRows = includeBilling
      ? await mapWithConcurrency(users, 4, async (entry) => ({
          userId: entry.id,
          billing: await getCloudWorkerAdminBillingStatus({
            userId: entry.id,
            email: entry.email,
            name: entry.name ?? entry.email,
          }),
        }))
      : []

    const billingByUser = new Map(billingRows.map((row) => [row.userId, row.billing]))

    const userRows = users.map((entry) => {
      const workerStats = workerStatsByUser.get(entry.id) ?? {
        workerCount: 0,
        cloudWorkerCount: 0,
        localWorkerCount: 0,
        latestWorkerCreatedAt: null,
      }
      const sessionStats = sessionStatsByUser.get(entry.id) ?? {
        sessionCount: 0,
        lastSeenAt: null,
      }
      const authProviders = Array.from(providersByUser.get(entry.id) ?? []).sort()

      const activity = activityByUser.get(entry.id)
      const activeDayCount = activity ? activity.days.size : 0

      const lastSeenTime = toTimestamp(sessionStats.lastSeenAt)
      const lastTelemetryAt = activity ? activity.lastTelemetryAt : null
      const lastActiveTime = lastTelemetryAt === null
        ? lastSeenTime
        : lastSeenTime === null
          ? lastTelemetryAt
          : Math.max(lastSeenTime, lastTelemetryAt)

      const inviteStats = inviteStatsByUser.get(entry.id)
      const signupTime = toTimestamp(entry.createdAt)
      const firstInviteTime = toTimestamp(inviteStats ? inviteStats.firstInviteAt : null)
      const hoursToFirstInvite = signupTime !== null && firstInviteTime !== null
        ? Math.max(0, Math.round(((firstInviteTime - signupTime) / (60 * 60 * 1000)) * 10) / 10)
        : null

      return {
        id: entry.id,
        name: entry.name,
        email: entry.email,
        emailVerified: entry.emailVerified,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        lastSeenAt: sessionStats.lastSeenAt,
        sessionCount: sessionStats.sessionCount,
        activeDayCount,
        isRecurring: activeDayCount >= 2,
        lastActiveAt: lastActiveTime === null ? null : new Date(lastActiveTime),
        invitesSent: inviteStats ? inviteStats.invitesSent : 0,
        firstInviteAt: inviteStats ? inviteStats.firstInviteAt : null,
        hoursToFirstInvite,
        authProviders,
        workerCount: workerStats.workerCount,
        cloudWorkerCount: workerStats.cloudWorkerCount,
        localWorkerCount: workerStats.localWorkerCount,
        latestWorkerCreatedAt: workerStats.latestWorkerCreatedAt,
        billing: includeBilling ? billingByUser.get(entry.id) ?? defaultBilling : null,
      }
    })

    const summary = userRows.reduce(
      (accumulator, entry) => {
        accumulator.totalUsers += 1
        accumulator.totalWorkers += entry.workerCount
        accumulator.cloudWorkers += entry.cloudWorkerCount
        accumulator.localWorkers += entry.localWorkerCount

        if (entry.emailVerified) {
          accumulator.verifiedUsers += 1
        }

        if (entry.workerCount > 0) {
          accumulator.usersWithWorkers += 1
        }

        if (includeBilling && entry.billing) {
          if (entry.billing.status === "paid") {
            accumulator.paidUsers += 1
          } else if (entry.billing.status === "unpaid") {
            accumulator.unpaidUsers += 1
          } else {
            accumulator.billingUnavailableUsers += 1
          }
        }

        if (isWithinDays(entry.createdAt, 7)) {
          accumulator.recentUsers7d += 1
        }

        if (isWithinDays(entry.createdAt, 30)) {
          accumulator.recentUsers30d += 1
        }

        if (entry.isRecurring) {
          accumulator.recurringUsers += 1
        }

        if (entry.invitesSent > 0) {
          accumulator.inviters += 1
        }

        return accumulator
      },
      {
        totalUsers: 0,
        verifiedUsers: 0,
        recentUsers7d: 0,
        recentUsers30d: 0,
        totalWorkers: 0,
        cloudWorkers: 0,
        localWorkers: 0,
        usersWithWorkers: 0,
        paidUsers: 0,
        unpaidUsers: 0,
        billingUnavailableUsers: 0,
        recurringUsers: 0,
        inviters: 0,
      },
    )

    const inviteHours: number[] = []
    for (const row of userRows) {
      if (row.hoursToFirstInvite !== null) {
        inviteHours.push(row.hoursToFirstInvite)
      }
    }

    return c.json({
      viewer: {
        id: user.id,
        email: normalizeEmail(user.email),
        name: user.name,
      },
      admins,
      summary: {
        ...summary,
        adminCount: admins.length,
        billingLoaded: includeBilling,
        paidUsers: includeBilling ? summary.paidUsers : null,
        unpaidUsers: includeBilling ? summary.unpaidUsers : null,
        billingUnavailableUsers: includeBilling ? summary.billingUnavailableUsers : null,
        usersWithoutWorkers: summary.totalUsers - summary.usersWithWorkers,
        activeUsers1d,
        activeUsers7d: active7d.size,
        activeUsers30d: active30d.size,
        // "Real" DAU/WAU/MAU: users who executed at least one task in a
        // session that day (task.* telemetry with a session id), vs the
        // looser activeUsers* which counts any sign-in or telemetry ping.
        realActiveUsers1d,
        realActiveUsers7d: realActive7d.size,
        realActiveUsers30d: realActive30d.size,
        medianHoursToFirstInvite: median(inviteHours),
        activitySeries,
      },
      users: userRows,
      generatedAt: new Date().toISOString(),
    })
    },
  )
}
