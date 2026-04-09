import { asc, desc, eq, isNotNull, sql } from "@openwork-ee/den-db/drizzle"
import { AuthAccountTable, AuthSessionTable, AuthUserTable, WorkerTable, AdminAllowlistTable } from "@openwork-ee/den-db/schema"
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

    const [admins, users, workerStatsRows, sessionStatsRows, accountRows] = await Promise.all([
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

      return {
        id: entry.id,
        name: entry.name,
        email: entry.email,
        emailVerified: entry.emailVerified,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        lastSeenAt: sessionStats.lastSeenAt,
        sessionCount: sessionStats.sessionCount,
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
      },
    )

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
      },
      users: userRows,
      generatedAt: new Date().toISOString(),
    })
    },
  )
}
