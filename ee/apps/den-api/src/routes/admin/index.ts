import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, sql } from "@openwork-ee/den-db/drizzle"
import type { SQL } from "@openwork-ee/den-db/drizzle"
import {
  AuthAccountTable,
  AuthApiKeyTable,
  AuthSessionTable,
  AuthUserTable,
  ConnectedAccountTable,
  DesktopHandoffGrantTable,
  ExternalIdentityTable,
  InvitationTable,
  MemberTable,
  OAuthAccessTokenTable,
  OAuthClientTable,
  OAuthConsentTable,
  OAuthRefreshTokenTable,
  OrganizationTable,
  OrgSubscriptionTable,
  ScimSyncEventTable,
  TelemetryEventTable,
  WorkerTable,
  AdminAllowlistTable,
} from "@openwork-ee/den-db/schema"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { db } from "../../db.js"
import { parseOrganizationPlan, type PlanTier } from "../../entitlements.js"
import { adminRoute, queryValidator } from "../../middleware/index.js"
import { denTypeIdSchema, forbiddenSchema, invalidRequestSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import { appLogger } from "../../observability/logger.js"
import { memberFacingMcpConnectionsEnabled } from "../../capability-sources/external-mcp-rollout.js"
import { organizationInstallLinksEnabled } from "../../capability-sources/install-links-rollout.js"
import { normalizeOrganizationCapabilities, readOrganizationCapabilityOverrides } from "../../organization-capabilities.js"
import { DEFAULT_ORGANIZATION_LIMITS, normalizeOrganizationMetadata } from "../../organization-limits.js"
import type { AuthContextVariables } from "../../session.js"
import { calculateOrganizationSeatBillingCounts, getOrganizationSeatBillingCounts, refreshOrgSubscriptionFromStripe, syncSeatSubscriptionQuantityAfterMemberChange } from "../../stripe-billing.js"
import { buildAdminPageInfo, normalizeAdminPageRequest, sanitizeAdminSearchForLike, type AdminPageRequest } from "./scale-performance.js"

type UserId = typeof AuthUserTable.$inferSelect.id
type OrganizationId = typeof OrganizationTable.$inferSelect.id

type AdminBillingStatus = {
  status: "paid" | "unpaid" | "unavailable"
  featureGateEnabled: boolean
  subscriptionId: string | null
  subscriptionStatus: string | null
  currentPeriodEnd: Date | string | null
  source: "benefit" | "subscription" | "unavailable"
  note: string | null
}

const DEFAULT_ORGANIZATION_FREE_SEAT_COUNT = calculateOrganizationSeatBillingCounts({ memberCount: 0 }).includedFree
const logger = appLogger.child({ component: "admin_routes" })

const overviewQuerySchema = z.object({
  includeBilling: z.string().optional(),
  limit: z.string().optional(),
  offset: z.string().optional(),
  search: z.string().optional(),
})

const adminPageQuerySchema = z.object({
  includeBilling: z.string().optional(),
  limit: z.string().optional(),
  offset: z.string().optional(),
  search: z.string().optional(),
})

const updateOrganizationPlanSchema = z.object({
  tier: z.enum(["free", "team", "enterprise"]),
  seatLimit: z.number().int().min(1).max(100000),
})

const updateOrganizationFreeSeatsSchema = z.object({
  totalFreeSeats: z.number().int().min(DEFAULT_ORGANIZATION_FREE_SEAT_COUNT).max(100000),
})

const updateOrganizationCapabilitiesSchema = z.object({
  capabilities: z.object({
    installLinks: z.boolean().nullable().optional(),
    mcpConnections: z.boolean().nullable().optional(),
  }),
})

const adminActivityPointSchema = z.object({
  day: z.string(),
  activeUsers: z.number(),
  realActiveUsers: z.number(),
  signups: z.number(),
})

const nullableNumberSchema = z.number().nullable()

const adminSummarySchema = z.object({
  totalUsers: z.number(),
  totalOrganizations: z.number(),
  verifiedUsers: nullableNumberSchema,
  recentUsers7d: nullableNumberSchema,
  recentUsers30d: nullableNumberSchema,
  totalWorkers: nullableNumberSchema,
  cloudWorkers: nullableNumberSchema,
  localWorkers: nullableNumberSchema,
  usersWithWorkers: nullableNumberSchema,
  usersWithoutWorkers: nullableNumberSchema,
  paidUsers: nullableNumberSchema,
  unpaidUsers: nullableNumberSchema,
  billingUnavailableUsers: nullableNumberSchema,
  adminCount: z.number(),
  billingLoaded: z.boolean(),
  activeUsers1d: nullableNumberSchema,
  activeUsers7d: nullableNumberSchema,
  activeUsers30d: nullableNumberSchema,
  realActiveUsers1d: nullableNumberSchema,
  realActiveUsers7d: nullableNumberSchema,
  realActiveUsers30d: nullableNumberSchema,
  recurringUsers: nullableNumberSchema,
  inviters: nullableNumberSchema,
  medianHoursToFirstInvite: nullableNumberSchema,
  activitySeries: z.array(adminActivityPointSchema),
}).meta({ ref: "AdminSummary" })

const adminPageInfoSchema = z.object({
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
  returned: z.number(),
  hasMore: z.boolean(),
  search: z.string(),
  durationMs: z.number(),
}).meta({ ref: "AdminPageInfo" })

const adminBillingPageSchema = z.object({
  loaded: z.boolean(),
  paidUsers: nullableNumberSchema,
  unpaidUsers: nullableNumberSchema,
  billingUnavailableUsers: nullableNumberSchema,
})

const adminOverviewResponseSchema = z.object({
  viewer: z.object({
    id: denTypeIdSchema("user"),
    email: z.string(),
    name: z.string().nullable(),
  }),
  admins: z.array(z.object({}).passthrough()),
  summary: adminSummarySchema,
  users: z.array(z.object({}).passthrough()),
  organizations: z.array(z.object({}).passthrough()),
  userPage: adminPageInfoSchema,
  organizationPage: adminPageInfoSchema,
  generatedAt: z.string().datetime(),
}).meta({ ref: "AdminOverviewResponse" })

const adminUsersPageResponseSchema = z.object({
  users: z.array(z.object({}).passthrough()),
  page: adminPageInfoSchema,
  billing: adminBillingPageSchema,
  generatedAt: z.string().datetime(),
}).meta({ ref: "AdminUsersPageResponse" })

const adminOrganizationsPageResponseSchema = z.object({
  organizations: z.array(z.object({}).passthrough()),
  page: adminPageInfoSchema,
  generatedAt: z.string().datetime(),
}).meta({ ref: "AdminOrganizationsPageResponse" })

const adminMetricsResponseSchema = z.object({
  summary: adminSummarySchema,
  generatedAt: z.string().datetime(),
}).meta({ ref: "AdminMetricsResponse" })

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function normalizeMetadata(input: Record<string, unknown> | string | null | undefined): Record<string, unknown> {
  if (!input) {
    return {}
  }

  if (typeof input === "string") {
    try {
      const parsed: unknown = JSON.parse(input)
      return isRecord(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }

  return isRecord(input) ? input : {}
}

function readAdminVisibleOrganizationCapabilities(metadata: Record<string, unknown> | string | null | undefined): ReturnType<typeof normalizeOrganizationCapabilities> {
  return {
    installLinks: organizationInstallLinksEnabled(metadata, { gatingEnabled: false }),
    mcpConnections: memberFacingMcpConnectionsEnabled(metadata, { gatingEnabled: false }),
  }
}

function readUnmanagedCapabilityMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const raw = isRecord(metadata.capabilities) ? metadata.capabilities : {}
  const capabilities: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(raw)) {
    if (key !== "installLinks" && key !== "mcpConnections") {
      capabilities[key] = value
    }
  }

  return capabilities
}

function getManualPlanMetadata(tier: PlanTier): { tier: PlanTier; source: "manual"; grantedAt?: string } {
  return {
    tier,
    source: "manual",
    ...(tier === "enterprise" ? { grantedAt: new Date().toISOString() } : {}),
  }
}

function isOrganizationId(value: string): value is OrganizationId {
  return value.startsWith("org_")
}

function isUserId(value: string): value is UserId {
  return value.startsWith("user_")
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  if (items.length === 0) {
    return []
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

function isPaidSubscriptionStatus(value: string | null) {
  return value === "active" || value === "trialing"
}

function billingTime(value: Date | string | null) {
  if (!value) {
    return 0
  }

  return value instanceof Date ? value.getTime() : new Date(value).getTime()
}

function shouldReplaceBillingStatus(current: AdminBillingStatus, candidate: AdminBillingStatus) {
  if (candidate.status === "paid" && current.status !== "paid") {
    return true
  }

  if (candidate.status !== current.status) {
    return false
  }

  return billingTime(candidate.currentPeriodEnd) > billingTime(current.currentPeriodEnd)
}

type AdminUserBaseRow = Pick<typeof AuthUserTable.$inferSelect, "id" | "name" | "email" | "emailVerified" | "createdAt" | "updatedAt">

type AdminUserRow = AdminUserBaseRow & {
  lastSeenAt: Date | string | null
  sessionCount: number
  activeDayCount: number
  isRecurring: boolean
  lastActiveAt: Date | string | null
  invitesSent: number
  firstInviteAt: Date | string | null
  hoursToFirstInvite: number | null
  authProviders: string[]
  workerCount: number
  cloudWorkerCount: number
  localWorkerCount: number
  latestWorkerCreatedAt: Date | string | null
  billing: AdminBillingStatus | null
  organizations: Array<{
    id: OrganizationId
    name: string
    role: string
    memberCount: number
    joinedAt: Date | string | null
  }>
}

type AdminOrganizationRow = {
  id: OrganizationId
  name: string
  slug: string
  createdAt: Date | string | null
  updatedAt: Date | string | null
  memberCount: number
  plan: ReturnType<typeof parseOrganizationPlan>
  seatLimit: number
  freeSeatCount: number
  seatsFreeAdditional: number
  billableSeatCount: number
  capabilities: ReturnType<typeof normalizeOrganizationCapabilities>
}

type AdminSummary = {
  totalUsers: number
  totalOrganizations: number
  verifiedUsers: number | null
  recentUsers7d: number | null
  recentUsers30d: number | null
  totalWorkers: number | null
  cloudWorkers: number | null
  localWorkers: number | null
  usersWithWorkers: number | null
  usersWithoutWorkers: number | null
  paidUsers: number | null
  unpaidUsers: number | null
  billingUnavailableUsers: number | null
  adminCount: number
  billingLoaded: boolean
  activeUsers1d: number | null
  activeUsers7d: number | null
  activeUsers30d: number | null
  realActiveUsers1d: number | null
  realActiveUsers7d: number | null
  realActiveUsers30d: number | null
  recurringUsers: number | null
  inviters: number | null
  medianHoursToFirstInvite: number | null
  activitySeries: Array<{ day: string; activeUsers: number; realActiveUsers: number; signups: number }>
}

function elapsedMs(startedAt: number) {
  return Math.max(0, Math.round(Date.now() - startedAt))
}

function userSearchCondition(search: string): SQL | undefined {
  if (!search) {
    return undefined
  }

  const normalized = search.toLowerCase()
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) {
    return eq(AuthUserTable.email, normalized)
  }

  const pattern = `%${sanitizeAdminSearchForLike(search)}%`
  return sql`(
    lower(${AuthUserTable.name}) like ${pattern} escape '|'
    or lower(${AuthUserTable.email}) like ${pattern} escape '|'
    or lower(${AuthUserTable.id}) like ${pattern} escape '|'
    or exists (
      select 1 from ${AuthAccountTable}
      where ${AuthAccountTable.userId} = ${AuthUserTable.id}
        and lower(${AuthAccountTable.providerId}) like ${pattern} escape '|'
    )
    or exists (
      select 1 from ${MemberTable}
      inner join ${OrganizationTable} on ${MemberTable.organizationId} = ${OrganizationTable.id}
      where ${MemberTable.userId} = ${AuthUserTable.id}
        and ${MemberTable.removedAt} is null
        and (
          lower(${OrganizationTable.name}) like ${pattern} escape '|'
          or lower(${OrganizationTable.id}) like ${pattern} escape '|'
          or lower(${MemberTable.role}) like ${pattern} escape '|'
        )
    )
  )`
}

function organizationSearchCondition(search: string): SQL | undefined {
  if (!search) {
    return undefined
  }

  const pattern = `%${sanitizeAdminSearchForLike(search)}%`
  return sql`(
    lower(${OrganizationTable.name}) like ${pattern} escape '|'
    or lower(${OrganizationTable.slug}) like ${pattern} escape '|'
    or lower(${OrganizationTable.id}) like ${pattern} escape '|'
  )`
}

async function selectUserCount(condition: SQL | undefined) {
  const query = db.select({ total: sql<number>`count(*)` }).from(AuthUserTable)
  const rows = condition ? await query.where(condition) : await query
  return toNumber(rows[0]?.total)
}

async function selectUserPage(request: AdminPageRequest) {
  const condition = userSearchCondition(request.search)
  const query = db
    .select({
      id: AuthUserTable.id,
      name: AuthUserTable.name,
      email: AuthUserTable.email,
      emailVerified: AuthUserTable.emailVerified,
      createdAt: AuthUserTable.createdAt,
      updatedAt: AuthUserTable.updatedAt,
    })
    .from(AuthUserTable)
  const pageQuery = condition ? query.where(condition) : query
  const [total, rows] = await Promise.all([
    selectUserCount(condition),
    pageQuery.orderBy(desc(AuthUserTable.createdAt), desc(AuthUserTable.id)).limit(request.limit).offset(request.offset),
  ])

  return { total, rows }
}

async function selectOrganizationCount(condition: SQL | undefined) {
  const query = db.select({ total: sql<number>`count(*)` }).from(OrganizationTable)
  const rows = condition ? await query.where(condition) : await query
  return toNumber(rows[0]?.total)
}

async function selectOrganizationPage(request: AdminPageRequest) {
  const condition = organizationSearchCondition(request.search)
  const query = db
    .select({
      id: OrganizationTable.id,
      name: OrganizationTable.name,
      slug: OrganizationTable.slug,
      metadata: OrganizationTable.metadata,
      createdAt: OrganizationTable.createdAt,
      updatedAt: OrganizationTable.updatedAt,
    })
    .from(OrganizationTable)
  const pageQuery = condition ? query.where(condition) : query
  const [total, rows] = await Promise.all([
    selectOrganizationCount(condition),
    pageQuery.orderBy(desc(OrganizationTable.createdAt), desc(OrganizationTable.id)).limit(request.limit).offset(request.offset),
  ])

  return { total, rows }
}

export async function loadAdminUsersPage(request: AdminPageRequest, includeBilling: boolean) {
  const startedAt = Date.now()
  const { total, rows } = await selectUserPage(request)
  const users = await shapeAdminUserRows(rows, includeBilling)
  const billingCounts = users.reduce(
    (accumulator, user) => {
      if (!user.billing) {
        return accumulator
      }
      if (user.billing.status === "paid") {
        accumulator.paidUsers += 1
      } else if (user.billing.status === "unpaid") {
        accumulator.unpaidUsers += 1
      } else {
        accumulator.billingUnavailableUsers += 1
      }
      return accumulator
    },
    { paidUsers: 0, unpaidUsers: 0, billingUnavailableUsers: 0 },
  )

  return {
    users,
    page: buildAdminPageInfo(request, total, users.length, elapsedMs(startedAt)),
    billing: includeBilling
      ? { loaded: true, ...billingCounts }
      : { loaded: false, paidUsers: null, unpaidUsers: null, billingUnavailableUsers: null },
  }
}

async function shapeAdminUserRows(users: AdminUserBaseRow[], includeBilling: boolean): Promise<AdminUserRow[]> {
  if (users.length === 0) {
    return []
  }

  const userIds = users.map((user) => user.id)
  const activityWindowStart = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
  const sessionDayExpr = sql<string>`date_format(${AuthSessionTable.createdAt}, '%Y-%m-%d')`
  const telemetryDayExpr = sql<string>`date_format(${TelemetryEventTable.event_timestamp}, '%Y-%m-%d')`

  const [workerStatsRows, sessionStatsRows, accountRows, orgMembershipRows, sessionDayRows, telemetryDayRows, taskDayRows, inviteStatsRows] = await Promise.all([
    db
      .select({
        userId: WorkerTable.created_by_user_id,
        workerCount: sql<number>`count(*)`,
        cloudWorkerCount: sql<number>`sum(case when ${WorkerTable.destination} = 'cloud' then 1 else 0 end)`,
        localWorkerCount: sql<number>`sum(case when ${WorkerTable.destination} = 'local' then 1 else 0 end)`,
        latestWorkerCreatedAt: sql<Date | null>`max(${WorkerTable.created_at})`,
      })
      .from(WorkerTable)
      .where(inArray(WorkerTable.created_by_user_id, userIds))
      .groupBy(WorkerTable.created_by_user_id),
    db
      .select({
        userId: AuthSessionTable.userId,
        sessionCount: sql<number>`count(*)`,
        lastSeenAt: sql<Date | null>`max(${AuthSessionTable.updatedAt})`,
      })
      .from(AuthSessionTable)
      .where(inArray(AuthSessionTable.userId, userIds))
      .groupBy(AuthSessionTable.userId),
    db
      .select({
        userId: AuthAccountTable.userId,
        providerId: AuthAccountTable.providerId,
      })
      .from(AuthAccountTable)
      .where(inArray(AuthAccountTable.userId, userIds))
      .groupBy(AuthAccountTable.userId, AuthAccountTable.providerId),
    db
      .select({
        userId: MemberTable.userId,
        organizationId: MemberTable.organizationId,
        organizationName: OrganizationTable.name,
        role: MemberTable.role,
        joinedAt: MemberTable.joinedAt,
      })
      .from(MemberTable)
      .innerJoin(OrganizationTable, eq(MemberTable.organizationId, OrganizationTable.id))
      .where(and(inArray(MemberTable.userId, userIds), isNull(MemberTable.removedAt))),
    db
      .select({ userId: AuthSessionTable.userId, day: sessionDayExpr })
      .from(AuthSessionTable)
      .where(and(inArray(AuthSessionTable.userId, userIds), gte(AuthSessionTable.createdAt, activityWindowStart)))
      .groupBy(AuthSessionTable.userId, sessionDayExpr),
    db
      .select({
        userId: MemberTable.userId,
        day: telemetryDayExpr,
        lastEventAt: sql<Date | null>`max(${TelemetryEventTable.event_timestamp})`,
      })
      .from(TelemetryEventTable)
      .innerJoin(MemberTable, eq(TelemetryEventTable.member_id, MemberTable.id))
      .where(and(inArray(MemberTable.userId, userIds), gte(TelemetryEventTable.event_timestamp, activityWindowStart)))
      .groupBy(MemberTable.userId, telemetryDayExpr)
      .catch(() => []),
    db
      .select({ userId: MemberTable.userId, day: telemetryDayExpr })
      .from(TelemetryEventTable)
      .innerJoin(MemberTable, eq(TelemetryEventTable.member_id, MemberTable.id))
      .where(and(
        inArray(MemberTable.userId, userIds),
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
      .where(inArray(InvitationTable.inviterId, userIds))
      .groupBy(InvitationTable.inviterId),
  ])

  const organizationIds = Array.from(new Set(orgMembershipRows.map((row) => row.organizationId).filter(isOrganizationId)))
  const orgMemberStatsRows = organizationIds.length > 0
    ? await db
      .select({ organizationId: MemberTable.organizationId, memberCount: sql<number>`count(*)` })
      .from(MemberTable)
      .where(and(inArray(MemberTable.organizationId, organizationIds), isNull(MemberTable.removedAt)))
      .groupBy(MemberTable.organizationId)
    : []
  const memberCountByOrg = new Map<string, number>()
  for (const row of orgMemberStatsRows) {
    memberCountByOrg.set(row.organizationId, toNumber(row.memberCount))
  }

  const workerStatsByUser = new Map<UserId, { workerCount: number; cloudWorkerCount: number; localWorkerCount: number; latestWorkerCreatedAt: Date | string | null }>()
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

  const sessionStatsByUser = new Map<UserId, { sessionCount: number; lastSeenAt: Date | string | null }>()
  for (const row of sessionStatsRows) {
    sessionStatsByUser.set(row.userId, { sessionCount: toNumber(row.sessionCount), lastSeenAt: row.lastSeenAt })
  }

  const providersByUser = new Map<UserId, Set<string>>()
  for (const row of accountRows) {
    const existing = providersByUser.get(row.userId) ?? new Set<string>()
    existing.add(normalizeProvider(row.providerId))
    providersByUser.set(row.userId, existing)
  }

  const membershipsByUser = new Map<UserId, AdminUserRow["organizations"]>()
  for (const row of orgMembershipRows) {
    if (!row.userId || !isOrganizationId(row.organizationId)) {
      continue
    }
    const memberships = membershipsByUser.get(row.userId) ?? []
    memberships.push({
      id: row.organizationId,
      name: row.organizationName,
      role: row.role,
      memberCount: memberCountByOrg.get(row.organizationId) ?? 0,
      joinedAt: row.joinedAt,
    })
    membershipsByUser.set(row.userId, memberships)
  }
  for (const memberships of membershipsByUser.values()) {
    memberships.sort((a, b) => a.name.localeCompare(b.name))
  }

  type ActivityStats = { days: Set<string>; lastTelemetryAt: number | null }
  const activityByUser = new Map<UserId, ActivityStats>()
  const getActivity = (userId: UserId): ActivityStats => {
    let stats = activityByUser.get(userId)
    if (!stats) {
      stats = { days: new Set(), lastTelemetryAt: null }
      activityByUser.set(userId, stats)
    }
    return stats
  }
  for (const row of sessionDayRows) {
    if (row.day) {
      getActivity(row.userId).days.add(row.day)
    }
  }
  for (const row of telemetryDayRows) {
    if (!row.userId) {
      continue
    }
    const stats = getActivity(row.userId)
    if (row.day) {
      stats.days.add(row.day)
    }
    const eventTime = toTimestamp(row.lastEventAt)
    if (eventTime !== null && (stats.lastTelemetryAt === null || eventTime > stats.lastTelemetryAt)) {
      stats.lastTelemetryAt = eventTime
    }
  }
  for (const row of taskDayRows) {
    if (row.userId && row.day) {
      getActivity(row.userId).days.add(row.day)
    }
  }

  const inviteStatsByUser = new Map<UserId, { invitesSent: number; firstInviteAt: Date | string | null }>()
  for (const row of inviteStatsRows) {
    inviteStatsByUser.set(row.inviterId, { invitesSent: toNumber(row.invitesSent), firstInviteAt: row.firstInviteAt })
  }

  const billingByUser = includeBilling ? await loadBillingForUsers(userIds) : new Map<UserId, AdminBillingStatus>()

  return users.map((entry) => {
    const workerStats = workerStatsByUser.get(entry.id) ?? { workerCount: 0, cloudWorkerCount: 0, localWorkerCount: 0, latestWorkerCreatedAt: null }
    const sessionStats = sessionStatsByUser.get(entry.id) ?? { sessionCount: 0, lastSeenAt: null }
    const activity = activityByUser.get(entry.id)
    const activeDayCount = activity ? activity.days.size : 0
    const lastSeenTime = toTimestamp(sessionStats.lastSeenAt)
    const lastTelemetryAt = activity ? activity.lastTelemetryAt : null
    const lastActiveTime = lastTelemetryAt === null ? lastSeenTime : lastSeenTime === null ? lastTelemetryAt : Math.max(lastSeenTime, lastTelemetryAt)
    const inviteStats = inviteStatsByUser.get(entry.id)
    const signupTime = toTimestamp(entry.createdAt)
    const firstInviteTime = toTimestamp(inviteStats ? inviteStats.firstInviteAt : null)
    const hoursToFirstInvite = signupTime !== null && firstInviteTime !== null
      ? Math.max(0, Math.round(((firstInviteTime - signupTime) / (60 * 60 * 1000)) * 10) / 10)
      : null

    return {
      ...entry,
      lastSeenAt: sessionStats.lastSeenAt,
      sessionCount: sessionStats.sessionCount,
      activeDayCount,
      isRecurring: activeDayCount >= 2,
      lastActiveAt: lastActiveTime === null ? null : new Date(lastActiveTime),
      invitesSent: inviteStats ? inviteStats.invitesSent : 0,
      firstInviteAt: inviteStats ? inviteStats.firstInviteAt : null,
      hoursToFirstInvite,
      authProviders: Array.from(providersByUser.get(entry.id) ?? []).sort(),
      workerCount: workerStats.workerCount,
      cloudWorkerCount: workerStats.cloudWorkerCount,
      localWorkerCount: workerStats.localWorkerCount,
      latestWorkerCreatedAt: workerStats.latestWorkerCreatedAt,
      billing: includeBilling ? billingByUser.get(entry.id) ?? {
        status: "unpaid",
        featureGateEnabled: false,
        subscriptionId: null,
        subscriptionStatus: null,
        currentPeriodEnd: null,
        source: "subscription",
        note: "No cached Stripe organization subscription covers this user.",
      } : null,
      organizations: membershipsByUser.get(entry.id) ?? [],
    }
  })
}

async function loadBillingForUsers(userIds: UserId[]) {
  const subscriptionRows = await db
    .select({
      userId: MemberTable.userId,
      subscriptionId: OrgSubscriptionTable.stripe_subscription_id,
      subscriptionStatus: OrgSubscriptionTable.status,
      currentPeriodEnd: OrgSubscriptionTable.current_period_end,
    })
    .from(OrgSubscriptionTable)
    .innerJoin(MemberTable, eq(OrgSubscriptionTable.organization_id, MemberTable.organizationId))
    .where(and(inArray(MemberTable.userId, userIds), isNull(MemberTable.removedAt), eq(OrgSubscriptionTable.type, "inference")))

  const subscriptionIds = Array.from(new Set(subscriptionRows.map((row) => row.subscriptionId)))
  const refreshedRows = await mapWithConcurrency(subscriptionIds, 4, async (subscriptionId) => {
    try {
      return await refreshOrgSubscriptionFromStripe(subscriptionId)
    } catch (error) {
      logger.warn("failed to refresh Stripe subscription", { stripe_subscription_id: subscriptionId, error })
      return null
    }
  })
  const refreshedBySubscriptionId = new Map<string, NonNullable<(typeof refreshedRows)[number]>>()
  for (const row of refreshedRows) {
    if (row) {
      refreshedBySubscriptionId.set(row.stripe_subscription_id, row)
    }
  }

  const billingByUser = new Map<UserId, AdminBillingStatus>()
  for (const row of subscriptionRows) {
    if (!row.userId) {
      continue
    }
    const refreshed = refreshedBySubscriptionId.get(row.subscriptionId)
    const subscriptionStatus = refreshed?.status ?? row.subscriptionStatus
    const subscriptionId = refreshed?.stripe_subscription_id ?? row.subscriptionId
    const currentPeriodEnd = refreshed?.current_period_end ?? row.currentPeriodEnd
    const paid = isPaidSubscriptionStatus(subscriptionStatus)
    const billing: AdminBillingStatus = {
      status: paid ? "paid" : "unpaid",
      featureGateEnabled: false,
      subscriptionId,
      subscriptionStatus,
      currentPeriodEnd,
      source: "subscription",
      note: paid ? "Covered by an active Stripe organization subscription." : "Stripe organization subscription is not active.",
    }
    const current = billingByUser.get(row.userId)
    if (!current || shouldReplaceBillingStatus(current, billing)) {
      billingByUser.set(row.userId, billing)
    }
  }

  return billingByUser
}

export async function loadAdminOrganizationsPage(request: AdminPageRequest) {
  const startedAt = Date.now()
  const { total, rows } = await selectOrganizationPage(request)
  const organizations = await shapeAdminOrganizationRows(rows)
  return {
    organizations,
    page: buildAdminPageInfo(request, total, organizations.length, elapsedMs(startedAt)),
    generatedAt: new Date().toISOString(),
  }
}

async function shapeAdminOrganizationRows(rows: Array<Pick<typeof OrganizationTable.$inferSelect, "id" | "name" | "slug" | "metadata" | "createdAt" | "updatedAt">>): Promise<AdminOrganizationRow[]> {
  if (rows.length === 0) {
    return []
  }

  const organizationIds = rows.map((row) => row.id)
  const memberRows = await db
    .select({ organizationId: MemberTable.organizationId, memberCount: sql<number>`count(*)` })
    .from(MemberTable)
    .where(and(inArray(MemberTable.organizationId, organizationIds), isNull(MemberTable.removedAt)))
    .groupBy(MemberTable.organizationId)
  const memberCountByOrg = new Map<string, number>()
  for (const row of memberRows) {
    memberCountByOrg.set(row.organizationId, toNumber(row.memberCount))
  }

  return rows.map((entry) => {
    const metadata = normalizeOrganizationMetadata(entry.metadata).metadata
    const seatLimit = metadata.limits.members ?? DEFAULT_ORGANIZATION_LIMITS.members
    const seatCounts = calculateOrganizationSeatBillingCounts({ memberCount: memberCountByOrg.get(entry.id) ?? 0, metadata })
    return {
      id: entry.id,
      name: entry.name,
      slug: entry.slug,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      memberCount: seatCounts.total,
      plan: parseOrganizationPlan(metadata),
      seatLimit,
      freeSeatCount: seatCounts.free,
      seatsFreeAdditional: seatCounts.additionalFree,
      billableSeatCount: seatCounts.chargeable,
      capabilities: readAdminVisibleOrganizationCapabilities(metadata),
    }
  })
}

function buildDeferredOverviewSummary(adminCount: number, totalUsers: number, totalOrganizations: number): AdminSummary {
  return {
    totalUsers,
    totalOrganizations,
    verifiedUsers: null,
    recentUsers7d: null,
    recentUsers30d: null,
    totalWorkers: null,
    cloudWorkers: null,
    localWorkers: null,
    usersWithWorkers: null,
    usersWithoutWorkers: null,
    paidUsers: null,
    unpaidUsers: null,
    billingUnavailableUsers: null,
    adminCount,
    billingLoaded: false,
    activeUsers1d: null,
    activeUsers7d: null,
    activeUsers30d: null,
    realActiveUsers1d: null,
    realActiveUsers7d: null,
    realActiveUsers30d: null,
    recurringUsers: null,
    inviters: null,
    medianHoursToFirstInvite: null,
    activitySeries: [],
  }
}

export async function loadAdminMetricsSummary(): Promise<AdminSummary> {
  const activityWindowDays = 90
  const seriesWindowDays = 30
  const now = Date.now()
  const activityWindowStart = new Date(now - activityWindowDays * 24 * 60 * 60 * 1000)
  const seriesWindowStart = new Date(now - (seriesWindowDays - 1) * 24 * 60 * 60 * 1000)
  const recent7dStart = new Date(now - 7 * 24 * 60 * 60 * 1000)
  const recent30dStart = new Date(now - 30 * 24 * 60 * 60 * 1000)
  const sessionDayExpr = sql<string>`date_format(${AuthSessionTable.createdAt}, '%Y-%m-%d')`
  const telemetryDayExpr = sql<string>`date_format(${TelemetryEventTable.event_timestamp}, '%Y-%m-%d')`
  const signupDayExpr = sql<string>`date_format(${AuthUserTable.createdAt}, '%Y-%m-%d')`

  const [userSummaryRows, organizationTotal, adminRows, workerRows, sessionDayRows, telemetryDayRows, taskDayRows, signupRows, inviteRows] = await Promise.all([
    db
      .select({
        totalUsers: sql<number>`count(*)`,
        verifiedUsers: sql<number>`sum(case when ${AuthUserTable.emailVerified} then 1 else 0 end)`,
        recentUsers7d: sql<number>`sum(case when ${AuthUserTable.createdAt} >= ${recent7dStart} then 1 else 0 end)`,
        recentUsers30d: sql<number>`sum(case when ${AuthUserTable.createdAt} >= ${recent30dStart} then 1 else 0 end)`,
      })
      .from(AuthUserTable),
    selectOrganizationCount(undefined),
    db.select({ adminCount: sql<number>`count(*)` }).from(AdminAllowlistTable),
    db
      .select({
        totalWorkers: sql<number>`count(*)`,
        cloudWorkers: sql<number>`sum(case when ${WorkerTable.destination} = 'cloud' then 1 else 0 end)`,
        localWorkers: sql<number>`sum(case when ${WorkerTable.destination} = 'local' then 1 else 0 end)`,
        usersWithWorkers: sql<number>`count(distinct ${WorkerTable.created_by_user_id})`,
      })
      .from(WorkerTable),
    db
      .select({ userId: AuthSessionTable.userId, day: sessionDayExpr })
      .from(AuthSessionTable)
      .where(gte(AuthSessionTable.createdAt, activityWindowStart))
      .groupBy(AuthSessionTable.userId, sessionDayExpr),
    db
      .select({ userId: MemberTable.userId, day: telemetryDayExpr })
      .from(TelemetryEventTable)
      .innerJoin(MemberTable, eq(TelemetryEventTable.member_id, MemberTable.id))
      .where(and(isNotNull(MemberTable.userId), gte(TelemetryEventTable.event_timestamp, activityWindowStart)))
      .groupBy(MemberTable.userId, telemetryDayExpr)
      .catch(() => []),
    db
      .select({ userId: MemberTable.userId, day: telemetryDayExpr })
      .from(TelemetryEventTable)
      .innerJoin(MemberTable, eq(TelemetryEventTable.member_id, MemberTable.id))
      .where(and(
        isNotNull(MemberTable.userId),
        gte(TelemetryEventTable.event_timestamp, activityWindowStart),
        inArray(TelemetryEventTable.event_type, ["task.started", "task.completed", "task.failed"]),
        isNotNull(TelemetryEventTable.session_id),
      ))
      .groupBy(MemberTable.userId, telemetryDayExpr)
      .catch(() => []),
    db
      .select({ day: signupDayExpr, signups: sql<number>`count(*)` })
      .from(AuthUserTable)
      .where(gte(AuthUserTable.createdAt, seriesWindowStart))
      .groupBy(signupDayExpr),
    db
      .select({
        inviterId: InvitationTable.inviterId,
        signupAt: AuthUserTable.createdAt,
        firstInviteAt: sql<Date | null>`min(${InvitationTable.createdAt})`,
      })
      .from(InvitationTable)
      .innerJoin(AuthUserTable, eq(InvitationTable.inviterId, AuthUserTable.id))
      .groupBy(InvitationTable.inviterId, AuthUserTable.createdAt),
  ])

  const userSummary = userSummaryRows[0]
  const totalUsers = toNumber(userSummary?.totalUsers)
  const workerSummary = workerRows[0]
  const totalWorkers = toNumber(workerSummary?.totalWorkers)
  const cloudWorkers = toNumber(workerSummary?.cloudWorkers)
  const localWorkers = toNumber(workerSummary?.localWorkers)
  const usersWithWorkers = toNumber(workerSummary?.usersWithWorkers)
  const seriesStartKey = toDayKey(seriesWindowStart) ?? ""
  const activeUsersByDay = new Map<string, Set<UserId>>()
  const realActiveUsersByDay = new Map<string, Set<UserId>>()
  const activityDaysByUser = new Map<UserId, Set<string>>()

  const rememberActivityDay = (userId: UserId, day: string) => {
    const days = activityDaysByUser.get(userId) ?? new Set<string>()
    days.add(day)
    activityDaysByUser.set(userId, days)
  }
  const markDay = (target: Map<string, Set<UserId>>, day: string, userId: UserId) => {
    if (day < seriesStartKey) {
      return
    }

    const users = target.get(day) ?? new Set<UserId>()
    users.add(userId)
    target.set(day, users)
  }

  for (const row of sessionDayRows) {
    if (!row.day) {
      continue
    }
    rememberActivityDay(row.userId, row.day)
    markDay(activeUsersByDay, row.day, row.userId)
  }
  for (const row of telemetryDayRows) {
    if (!row.userId || !row.day) {
      continue
    }
    rememberActivityDay(row.userId, row.day)
    markDay(activeUsersByDay, row.day, row.userId)
  }
  for (const row of taskDayRows) {
    if (!row.userId || !row.day) {
      continue
    }
    rememberActivityDay(row.userId, row.day)
    markDay(realActiveUsersByDay, row.day, row.userId)
  }

  const signupsByDay = new Map<string, number>()
  for (const row of signupRows) {
    if (row.day) {
      signupsByDay.set(row.day, toNumber(row.signups))
    }
  }

  const todayKey = toDayKey(new Date(now))
  const active7d = new Set<UserId>()
  const active30d = new Set<UserId>()
  const realActive7d = new Set<UserId>()
  const realActive30d = new Set<UserId>()
  const activitySeries: AdminSummary["activitySeries"] = []
  for (let offset = seriesWindowDays - 1; offset >= 0; offset -= 1) {
    const day = toDayKey(new Date(now - offset * 24 * 60 * 60 * 1000))
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

  const inviteHours: number[] = []
  for (const row of inviteRows) {
    const signupTime = toTimestamp(row.signupAt)
    const firstInviteTime = toTimestamp(row.firstInviteAt)
    if (signupTime !== null && firstInviteTime !== null) {
      inviteHours.push(Math.max(0, Math.round(((firstInviteTime - signupTime) / (60 * 60 * 1000)) * 10) / 10))
    }
  }

  let recurringUsers = 0
  for (const days of activityDaysByUser.values()) {
    if (days.size >= 2) {
      recurringUsers += 1
    }
  }

  return {
    totalUsers,
    totalOrganizations: organizationTotal,
    verifiedUsers: toNumber(userSummary?.verifiedUsers),
    recentUsers7d: toNumber(userSummary?.recentUsers7d),
    recentUsers30d: toNumber(userSummary?.recentUsers30d),
    totalWorkers,
    cloudWorkers,
    localWorkers,
    usersWithWorkers,
    usersWithoutWorkers: Math.max(0, totalUsers - usersWithWorkers),
    paidUsers: null,
    unpaidUsers: null,
    billingUnavailableUsers: null,
    adminCount: toNumber(adminRows[0]?.adminCount),
    billingLoaded: false,
    activeUsers1d: todayKey ? activeUsersByDay.get(todayKey)?.size ?? 0 : 0,
    activeUsers7d: active7d.size,
    activeUsers30d: active30d.size,
    realActiveUsers1d: todayKey ? realActiveUsersByDay.get(todayKey)?.size ?? 0 : 0,
    realActiveUsers7d: realActive7d.size,
    realActiveUsers30d: realActive30d.size,
    recurringUsers,
    inviters: inviteRows.length,
    medianHoursToFirstInvite: median(inviteHours),
    activitySeries,
  }
}

type AdminOverviewViewer = {
  id: UserId
  email: string | null
  name: string | null
}

export async function loadAdminInitialOverviewPayload(user: AdminOverviewViewer, pageRequest: AdminPageRequest) {
  const [admins, userPage, organizationTotal] = await Promise.all([
    db
      .select({
        email: AdminAllowlistTable.email,
        note: AdminAllowlistTable.note,
        createdAt: AdminAllowlistTable.created_at,
      })
      .from(AdminAllowlistTable)
      .orderBy(asc(AdminAllowlistTable.email)),
    loadAdminUsersPage(pageRequest, false),
    selectOrganizationCount(undefined),
  ])
  const summary = buildDeferredOverviewSummary(admins.length, userPage.page.total, organizationTotal)

  return {
    viewer: {
      id: user.id,
      email: normalizeEmail(user.email),
      name: user.name,
    },
    admins,
    organizations: [],
    organizationPage: buildAdminPageInfo({ limit: pageRequest.limit, offset: 0, search: "" }, organizationTotal, 0, 0),
    summary,
    users: userPage.users,
    userPage: userPage.page,
    generatedAt: new Date().toISOString(),
  }
}


export function registerAdminRoutes<T extends { Variables: AuthContextVariables }>(app: Hono<T>) {
  app.delete(
    "/v1/admin/users/:userId",
    adminRoute(),
    async (c) => {
      const currentUser = c.get("user")
      const userId = c.req.param("userId")
      if (!isUserId(userId)) {
        return c.json({ error: "invalid_request", message: "Invalid user id." }, 400)
      }

      if (userId === currentUser.id) {
        return c.json({ error: "invalid_request", message: "You cannot delete your own admin user." }, 400)
      }

      const rows = await db
        .select({ id: AuthUserTable.id, email: AuthUserTable.email })
        .from(AuthUserTable)
        .where(eq(AuthUserTable.id, userId))
        .limit(1)

      const targetUser = rows[0]
      if (!targetUser) {
        return c.json({ error: "not_found", message: "User not found." }, 404)
      }

      const membershipRows = await db
        .select({ id: MemberTable.id, organizationId: MemberTable.organizationId, removedAt: MemberTable.removedAt })
        .from(MemberTable)
        .where(eq(MemberTable.userId, userId))
      const activeMembershipRows = membershipRows.filter((member) => !member.removedAt)

      await db.transaction(async (tx) => {
        const removedAt = new Date()

        await tx.delete(OAuthAccessTokenTable).where(eq(OAuthAccessTokenTable.userId, userId))
        await tx.delete(OAuthRefreshTokenTable).where(eq(OAuthRefreshTokenTable.userId, userId))
        await tx.delete(OAuthConsentTable).where(eq(OAuthConsentTable.userId, userId))
        await tx.update(OAuthClientTable).set({ userId: null }).where(eq(OAuthClientTable.userId, userId))
        await tx.delete(AuthApiKeyTable).where(eq(AuthApiKeyTable.referenceId, userId))
        await tx.delete(AuthSessionTable).where(eq(AuthSessionTable.userId, userId))
        await tx.delete(AuthAccountTable).where(eq(AuthAccountTable.userId, userId))
        await tx.delete(DesktopHandoffGrantTable).where(eq(DesktopHandoffGrantTable.user_id, userId))
        await tx.delete(ExternalIdentityTable).where(eq(ExternalIdentityTable.userId, userId))
        await tx.delete(ScimSyncEventTable).where(eq(ScimSyncEventTable.userId, userId))
        if (membershipRows.length > 0) {
          await tx.delete(ConnectedAccountTable).where(inArray(
            ConnectedAccountTable.orgMembershipId,
            membershipRows.map((member) => member.id),
          ))
        }
        await tx.update(MemberTable).set({ removedAt }).where(eq(MemberTable.userId, userId))
        await tx.update(WorkerTable).set({ created_by_user_id: null }).where(eq(WorkerTable.created_by_user_id, userId))
        await tx.delete(AuthUserTable).where(eq(AuthUserTable.id, userId))
      })

      const organizationIds = Array.from(new Set(activeMembershipRows.map((row) => row.organizationId).filter(isOrganizationId)))
      for (const organizationId of organizationIds) {
        const seatCounts = await getOrganizationSeatBillingCounts({ organizationId })
        await syncSeatSubscriptionQuantityAfterMemberChange({ organizationId, memberCount: seatCounts.total })
      }

      return c.json({ ok: true, user: { id: targetUser.id, email: targetUser.email } })
    },
  )

  app.patch(
    "/v1/admin/organizations/:organizationId/plan",
    adminRoute(),
    async (c) => {
      const body = updateOrganizationPlanSchema.safeParse(await c.req.json().catch(() => null))
      if (!body.success) {
        return c.json({ error: "invalid_request", message: body.error.issues[0]?.message ?? "Invalid organization plan request." }, 400)
      }

      const organizationId = c.req.param("organizationId")
      if (!isOrganizationId(organizationId)) {
        return c.json({ error: "invalid_request", message: "Invalid organization id." }, 400)
      }
      const rows = await db
        .select({ id: OrganizationTable.id, metadata: OrganizationTable.metadata })
        .from(OrganizationTable)
        .where(eq(OrganizationTable.id, organizationId))
        .limit(1)

      const organization = rows[0]
      if (!organization) {
        return c.json({ error: "not_found", message: "Organization not found." }, 404)
      }

      const normalized = normalizeOrganizationMetadata(organization.metadata).metadata
      const metadata = {
        ...normalizeMetadata(normalized),
        plan: getManualPlanMetadata(body.data.tier),
        limits: {
          ...normalized.limits,
          members: body.data.seatLimit,
        },
      }

      await db
        .update(OrganizationTable)
        .set({ metadata })
        .where(eq(OrganizationTable.id, organizationId))

      return c.json({ ok: true, organization: { id: organizationId, plan: parseOrganizationPlan(metadata), seatLimit: body.data.seatLimit } })
    },
  )

  app.patch(
    "/v1/admin/organizations/:organizationId/free-seats",
    adminRoute(),
    async (c) => {
      const body = updateOrganizationFreeSeatsSchema.safeParse(await c.req.json().catch(() => null))
      if (!body.success) {
        return c.json({ error: "invalid_request", message: body.error.issues[0]?.message ?? "Invalid organization free seats request." }, 400)
      }

      const organizationId = c.req.param("organizationId")
      if (!isOrganizationId(organizationId)) {
        return c.json({ error: "invalid_request", message: "Invalid organization id." }, 400)
      }

      const rows = await db
        .select({ id: OrganizationTable.id, metadata: OrganizationTable.metadata })
        .from(OrganizationTable)
        .where(eq(OrganizationTable.id, organizationId))
        .limit(1)

      const organization = rows[0]
      if (!organization) {
        return c.json({ error: "not_found", message: "Organization not found." }, 404)
      }

      const seatsFreeAdditional = body.data.totalFreeSeats - DEFAULT_ORGANIZATION_FREE_SEAT_COUNT
      const metadata = {
        ...normalizeOrganizationMetadata(organization.metadata).metadata,
        seatsFreeAdditional,
      }

      await db
        .update(OrganizationTable)
        .set({ metadata })
        .where(eq(OrganizationTable.id, organizationId))

      const seatCounts = await getOrganizationSeatBillingCounts({ organizationId })
      await syncSeatSubscriptionQuantityAfterMemberChange({ organizationId, memberCount: seatCounts.total })

      return c.json({
        ok: true,
        organization: {
          id: organizationId,
          memberCount: seatCounts.total,
          freeSeatCount: seatCounts.free,
          seatsFreeAdditional: seatCounts.additionalFree,
          billableSeatCount: seatCounts.chargeable,
        },
      })
    },
  )

  app.get(
    "/v1/admin/organizations/:organizationId/capabilities",
    adminRoute(),
    async (c) => {
      const organizationId = c.req.param("organizationId")
      if (!isOrganizationId(organizationId)) {
        return c.json({ error: "invalid_request", message: "Invalid organization id." }, 400)
      }

      const rows = await db
        .select({ id: OrganizationTable.id, metadata: OrganizationTable.metadata })
        .from(OrganizationTable)
        .where(eq(OrganizationTable.id, organizationId))
        .limit(1)

      const organization = rows[0]
      if (!organization) {
        return c.json({ error: "not_found", message: "Organization not found." }, 404)
      }

      return c.json({ capabilities: readAdminVisibleOrganizationCapabilities(organization.metadata) })
    },
  )

  app.put(
    "/v1/admin/organizations/:organizationId/capabilities",
    adminRoute(),
    async (c) => {
      const body = updateOrganizationCapabilitiesSchema.safeParse(await c.req.json().catch(() => null))
      if (!body.success) {
        return c.json({ error: "invalid_request", message: body.error.issues[0]?.message ?? "Invalid organization capabilities request." }, 400)
      }

      const organizationId = c.req.param("organizationId")
      if (!isOrganizationId(organizationId)) {
        return c.json({ error: "invalid_request", message: "Invalid organization id." }, 400)
      }

      const rows = await db
        .select({ id: OrganizationTable.id, metadata: OrganizationTable.metadata })
        .from(OrganizationTable)
        .where(eq(OrganizationTable.id, organizationId))
        .limit(1)

      const organization = rows[0]
      if (!organization) {
        return c.json({ error: "not_found", message: "Organization not found." }, 404)
      }

      const capabilities = readOrganizationCapabilityOverrides(organization.metadata)
      const installLinks = body.data.capabilities.installLinks
      if (installLinks !== undefined) {
        if (installLinks === null) {
          delete capabilities.installLinks
        } else {
          capabilities.installLinks = installLinks
        }
      }
      const mcpConnections = body.data.capabilities.mcpConnections
      if (mcpConnections !== undefined) {
        if (mcpConnections === null) {
          delete capabilities.mcpConnections
        } else {
          capabilities.mcpConnections = mcpConnections
        }
      }

      const normalizedMetadata = normalizeOrganizationMetadata(organization.metadata).metadata
      const metadata = {
        ...normalizedMetadata,
        capabilities: {
          ...readUnmanagedCapabilityMetadata(normalizedMetadata),
          ...capabilities,
        },
      }

      await db
        .update(OrganizationTable)
        .set({ metadata })
        .where(eq(OrganizationTable.id, organizationId))

      return c.json({ ok: true, organization: { id: organizationId }, capabilities: readAdminVisibleOrganizationCapabilities(metadata) })
    },
  )

  app.get(
    "/v1/admin/users",
    describeRoute({
      tags: ["Admin"],
      summary: "Get a bounded admin user page",
      description: "Returns one bounded page of users plus required pagination metadata. Search runs across the global user set and optional billing enrichment stays page-scoped.",
      responses: {
        200: jsonResponse("Admin user page returned successfully.", adminUsersPageResponseSchema),
        400: jsonResponse("The admin user page query parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be authenticated.", unauthorizedSchema),
        403: jsonResponse("The authenticated user is not an admin.", forbiddenSchema),
      },
    }),
    adminRoute(),
    queryValidator(adminPageQuerySchema),
    async (c) => {
      const query = c.req.valid("query")
      const pageRequest = normalizeAdminPageRequest(query)
      const result = await loadAdminUsersPage(pageRequest, parseBooleanQuery(query.includeBilling))
      return c.json({ ...result, generatedAt: new Date().toISOString() })
    },
  )

  app.get(
    "/v1/admin/organizations",
    describeRoute({
      tags: ["Admin"],
      summary: "Get a bounded admin organization page",
      description: "Returns one bounded page of organizations plus required pagination metadata. Search runs across the global organization set without changing the global overview totals.",
      responses: {
        200: jsonResponse("Admin organization page returned successfully.", adminOrganizationsPageResponseSchema),
        400: jsonResponse("The admin organization page query parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be authenticated.", unauthorizedSchema),
        403: jsonResponse("The authenticated user is not an admin.", forbiddenSchema),
      },
    }),
    adminRoute(),
    queryValidator(adminPageQuerySchema),
    async (c) => {
      const query = c.req.valid("query")
      const pageRequest = normalizeAdminPageRequest(query)
      return c.json(await loadAdminOrganizationsPage(pageRequest))
    },
  )

  app.get(
    "/v1/admin/metrics",
    describeRoute({
      tags: ["Admin"],
      summary: "Load deferred admin analytics",
      description: "Calculates analytics that are intentionally deferred from the initial admin page: verified users, worker totals, activity, recurrence, invites, and chart series.",
      responses: {
        200: jsonResponse("Deferred admin analytics returned successfully.", adminMetricsResponseSchema),
        401: jsonResponse("The caller must be authenticated.", unauthorizedSchema),
        403: jsonResponse("The authenticated user is not an admin.", forbiddenSchema),
      },
    }),
    adminRoute(),
    async (c) => c.json({ summary: await loadAdminMetricsSummary(), generatedAt: new Date().toISOString() }),
  )

  app.get(
    "/v1/admin/overview",
    describeRoute({
      tags: ["Admin"],
      summary: "Get admin overview",
      description: "Returns the initial admin overview with bounded user data, global totals, and required pagination metadata. Expensive analytics are loaded separately from /v1/admin/metrics.",
      responses: {
        200: jsonResponse("Administrative overview returned successfully.", adminOverviewResponseSchema),
        400: jsonResponse("The admin overview query parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be an authenticated admin.", unauthorizedSchema),
        403: jsonResponse("The authenticated user is not an admin.", forbiddenSchema),
      },
    }),
    adminRoute(),
    queryValidator(overviewQuerySchema),
    async (c) => {
      const user = c.get("user")
      const query = c.req.valid("query")
      return c.json(await loadAdminInitialOverviewPayload(user, normalizeAdminPageRequest(query)))
    },
  )
}
