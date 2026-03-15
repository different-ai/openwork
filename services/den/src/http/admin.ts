import express from "express"
import { fromNodeHeaders } from "better-auth/node"
import { and, asc, desc, eq, isNotNull, isNull, sql } from "drizzle-orm"
import { ensureAdminAllowlistSeeded } from "../admin-allowlist.js"
import { auth } from "../auth.js"
import { getCloudWorkerAdminBillingStatus } from "../billing/polar.js"
import { db } from "../db/index.js"
import { AdminAllowlistTable, AuthAccountTable, AuthSessionTable, AuthUserTable, WorkerTable } from "../db/schema.js"
import { asyncRoute } from "./errors.js"

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

function parseBooleanQuery(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => parseBooleanQuery(entry))
  }

  if (typeof value !== "string") {
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

async function requireAdminSession(req: express.Request, res: express.Response) {
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  })

  if (!session?.user?.id) {
    res.status(401).json({ error: "unauthorized" })
    return null
  }

  if (session.user.emailVerified !== true) {
    res.status(403).json({ error: "email_verification_required" })
    return null
  }

  const email = normalizeEmail(session.user.email)
  if (!email) {
    res.status(403).json({ error: "admin_email_required" })
    return null
  }

  await ensureAdminAllowlistSeeded()

  const allowed = await db
    .select({ id: AdminAllowlistTable.id, userId: AdminAllowlistTable.user_id })
    .from(AdminAllowlistTable)
    .where(eq(AdminAllowlistTable.email, email))
    .limit(1)

  if (allowed.length === 0) {
    res.status(403).json({ error: "forbidden" })
    return null
  }

  const [entry] = allowed
  if (entry.userId && entry.userId !== session.user.id) {
    res.status(403).json({ error: "forbidden" })
    return null
  }

  if (!entry.userId) {
    await db
      .update(AdminAllowlistTable)
      .set({
        user_id: session.user.id,
        updated_at: sql`CURRENT_TIMESTAMP(3)`,
      })
      .where(and(eq(AdminAllowlistTable.id, entry.id), isNull(AdminAllowlistTable.user_id)))

    const rebound = await db
      .select({ userId: AdminAllowlistTable.user_id })
      .from(AdminAllowlistTable)
      .where(eq(AdminAllowlistTable.id, entry.id))
      .limit(1)

    if (rebound[0]?.userId !== session.user.id) {
      res.status(403).json({ error: "forbidden" })
      return null
    }
  }

  return session
}

export const adminRouter = express.Router()

adminRouter.get("/overview", asyncRoute(async (req, res) => {
  const session = await requireAdminSession(req, res)
  if (!session) return
  const includeBilling = parseBooleanQuery(req.query.includeBilling)

  const [admins, users, workerStatsRows, sessionStatsRows, accountRows] = await Promise.all([
    db
      .select({
        email: AdminAllowlistTable.email,
        userId: AdminAllowlistTable.user_id,
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

  const workerStatsByUser = new Map<string, {
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

  const sessionStatsByUser = new Map<string, {
    sessionCount: number
    lastSeenAt: Date | string | null
  }>()

  for (const row of sessionStatsRows) {
    sessionStatsByUser.set(row.userId, {
      sessionCount: toNumber(row.sessionCount),
      lastSeenAt: row.lastSeenAt,
    })
  }

  const providersByUser = new Map<string, Set<string>>()
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
    ? await mapWithConcurrency(users, 4, async (user) => ({
        userId: user.id,
        billing: await getCloudWorkerAdminBillingStatus({
          userId: user.id,
          email: user.email,
          name: user.name ?? user.email,
        }),
      }))
    : []

  const billingByUser = new Map(billingRows.map((row) => [row.userId, row.billing]))

  const userRows = users.map((user) => {
    const workerStats = workerStatsByUser.get(user.id) ?? {
      workerCount: 0,
      cloudWorkerCount: 0,
      localWorkerCount: 0,
      latestWorkerCreatedAt: null,
    }
    const sessionStats = sessionStatsByUser.get(user.id) ?? {
      sessionCount: 0,
      lastSeenAt: null,
    }
    const authProviders = Array.from(providersByUser.get(user.id) ?? []).sort()

    return {
      id: user.id,
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerified,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      lastSeenAt: sessionStats.lastSeenAt,
      sessionCount: sessionStats.sessionCount,
      authProviders,
      workerCount: workerStats.workerCount,
      cloudWorkerCount: workerStats.cloudWorkerCount,
      localWorkerCount: workerStats.localWorkerCount,
      latestWorkerCreatedAt: workerStats.latestWorkerCreatedAt,
      billing: includeBilling ? billingByUser.get(user.id) ?? defaultBilling : null,
    }
  })

  const summary = userRows.reduce(
    (accumulator, user) => {
      accumulator.totalUsers += 1
      accumulator.totalWorkers += user.workerCount
      accumulator.cloudWorkers += user.cloudWorkerCount
      accumulator.localWorkers += user.localWorkerCount

      if (user.emailVerified) {
        accumulator.verifiedUsers += 1
      }

      if (user.workerCount > 0) {
        accumulator.usersWithWorkers += 1
      }

      if (includeBilling && user.billing) {
        if (user.billing.status === "paid") {
          accumulator.paidUsers += 1
        } else if (user.billing.status === "unpaid") {
          accumulator.unpaidUsers += 1
        } else {
          accumulator.billingUnavailableUsers += 1
        }
      }

      if (isWithinDays(user.createdAt, 7)) {
        accumulator.recentUsers7d += 1
      }

      if (isWithinDays(user.createdAt, 30)) {
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

  res.json({
    viewer: {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
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
}))
