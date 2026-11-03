import { and, count, eq, gte, inArray, isNotNull, lt, ne, sql } from "@openwork-ee/den-db/drizzle"
import {
  AdminAllowlistTable,
  AuthApiKeyTable,
  AutomationTable,
  AuthSessionTable,
  AuthUserTable,
  InferenceFreeUsageTable,
  InferenceUsageLedgerEntryTable,
  InvitationTable,
  MemberTable,
  OAuthClientTable,
  OrganizationTable,
  PlatformAuditEventTable,
} from "@openwork-ee/den-db/schema"
import { INFERENCE_USAGE_CONVERSION_FACTOR } from "@openwork/types/den/inference"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { db } from "../../db.js"
import { env } from "../../env.js"
import { adminRoute, queryValidator } from "../../middleware/index.js"
import { forbiddenSchema, invalidRequestSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import type { AuthContextVariables } from "../../session.js"
import { PERSONAL_EMAIL_DOMAINS } from "./opportunity-signals.js"
import {
  adminGrantFinding,
  apiKeyFinding,
  API_KEY_TIERS,
  automationClientFinding,
  automationClientOf,
  CLIENT_REGISTRATION_USER_TIERS,
  clientRegistrationFinding,
  deniedSpikeFinding,
  DISPOSABLE_EMAIL_DOMAINS,
  disposableSignupFinding,
  emailDomain,
  failedSignInFinding,
  instantAllowanceFinding,
  INVITATION_TIERS,
  invitationFinding,
  isSignInAction,
  NETWORK_SPREAD_TIERS,
  networkOf,
  networkSpreadFinding,
  ORGANIZATION_CREATION_TIERS,
  organizationCreationFinding,
  rateLimitedFinding,
  ROUND_THE_CLOCK_HOURS,
  roundTheClockFinding,
  signupNetworkFinding,
  sortFindings,
  SPEND_SPIKE,
  spendSpikeFinding,
  spikeOf,
  unverifiedDomainFinding,
  unverifiedSignupFinding,
  type AutomationSignIn,
  type HourlySeries,
  type NewAccount,
} from "./security-findings.js"

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
const REQUEST_HOURS = 24
/** Endpoints listed in the request table; the rest still count in the hourly totals. */
const REQUEST_ENDPOINT_LIMIT = 25

const querySchema = z.object({ days: z.coerce.number().int().min(1).max(30).default(7) })

const targetSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("user"), userId: z.string() }),
  z.object({ type: z.literal("organization"), organizationId: z.string() }),
]).nullable()

const severitySchema = z.enum(["high", "medium", "low", "clear"])

const findingSchema = z.object({
  id: z.string(),
  category: z.enum(["access", "accounts", "automation", "credentials", "usage"]),
  severity: severitySchema,
  title: z.string(),
  summary: z.string().describe("What is true now, in one sentence."),
  rule: z.string().describe("The threshold that decides the severity."),
  why: z.string(),
  review: z.string().describe("What a reviewer should check next."),
  value: z.number().int().nonnegative(),
  unit: z.enum(["count", "micro_usd"]),
  entities: z.array(z.object({
    id: z.string(),
    label: z.string(),
    detail: z.string().nullable(),
    value: z.number().int().nonnegative(),
    severity: severitySchema,
    target: targetSchema,
  })),
  entityCount: z.number().int().nonnegative().describe("Matching entities, including any past the listed ones."),
}).meta({ ref: "AdminSecurityFinding" })

export const securityReportResponseSchema = z.object({
  generatedAt: z.string().datetime(),
  range: z.object({ days: z.number().int(), from: z.string().datetime(), to: z.string().datetime() }),
  findings: z.array(findingSchema),
}).meta({ ref: "AdminSecurityReportResponse" })

export const securityRequestsResponseSchema = z.object({
  generatedAt: z.string().datetime(),
  range: z.object({ hours: z.number().int(), from: z.string().datetime(), to: z.string().datetime() }),
  hourly: z.array(z.object({
    hour: z.string().datetime(),
    refused: z.number().int().nonnegative(),
    rateLimited: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    failedSignIns: z.number().int().nonnegative(),
  })),
  endpoints: z.array(z.object({
    action: z.string(),
    refused: z.number().int().nonnegative(),
    rateLimited: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    peakHour: z.number().int().nonnegative(),
    typicalHour: z.number().nonnegative(),
  })),
  findings: z.array(findingSchema),
}).meta({ ref: "AdminSecurityRequestsResponse" })

export type SecurityReport = z.infer<typeof securityReportResponseSchema>
export type SecurityRequests = z.infer<typeof securityRequestsResponseSchema>

function number(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("security_report_invalid_totals")
  return parsed
}
/** Inference amounts are stored at INFERENCE_USAGE_CONVERSION_FACTOR units per USD; reports use micro-USD. */
function microUsd(amount: number): number {
  return Math.round(amount * 1_000_000 / INFERENCE_USAGE_CONVERSION_FACTOR)
}
type UserId = typeof AuthUserTable.$inferSelect.id
type MemberId = typeof MemberTable.$inferSelect.id
type OrganizationId = typeof OrganizationTable.$inferSelect.id

/**
 * Account, credential and usage signals for the last `days` days, each compared with a
 * threshold and, where it helps, the previous range of the same length.
 */
export async function readSecurityReport(input: { days: number; now?: Date }): Promise<SecurityReport> {
  const now = input.now ?? new Date()
  const from = new Date(now.getTime() - input.days * DAY_MS)
  const previousFrom = new Date(from.getTime() - input.days * DAY_MS)

  const [
    accounts, firstSignIns, previousAccounts, sessions, owners, adminGrants, adminTotal,
    keyOwners, keyPosture, clientTotals, clientUsers, inviters, paidSpend, freeSpend, paidHours, freeHours, firstDayAllowance,
  ] = await Promise.all([
    db.select({ userId: AuthUserTable.id, email: AuthUserTable.email, emailVerified: AuthUserTable.emailVerified, createdAt: AuthUserTable.createdAt })
      .from(AuthUserTable).where(gte(AuthUserTable.createdAt, from)),
    db.select({ userId: AuthSessionTable.userId, ipAddress: AuthSessionTable.ipAddress, createdAt: AuthSessionTable.createdAt })
      .from(AuthSessionTable).innerJoin(AuthUserTable, eq(AuthUserTable.id, AuthSessionTable.userId))
      .where(gte(AuthUserTable.createdAt, from)),
    db.select({ total: count(), unverified: sql<number>`coalesce(sum(case when ${AuthUserTable.emailVerified} then 0 else 1 end), 0)` })
      .from(AuthUserTable).where(and(gte(AuthUserTable.createdAt, previousFrom), lt(AuthUserTable.createdAt, from))),
    db.select({ userId: AuthSessionTable.userId, ipAddress: AuthSessionTable.ipAddress, userAgent: AuthSessionTable.userAgent, signIns: count() })
      .from(AuthSessionTable).where(gte(AuthSessionTable.createdAt, from))
      .groupBy(AuthSessionTable.userId, AuthSessionTable.ipAddress, AuthSessionTable.userAgent),
    db.select({ userId: MemberTable.userId, organizations: count() }).from(MemberTable)
      .where(and(gte(MemberTable.createdAt, from), sql`${MemberTable.role} like ${"%owner%"}`, eq(MemberTable.isSetupAgent, false), isNotNull(MemberTable.userId)))
      .groupBy(MemberTable.userId).having(sql`count(*) >= ${ORGANIZATION_CREATION_TIERS.medium}`),
    db.select({ id: AdminAllowlistTable.id, email: AdminAllowlistTable.email, note: AdminAllowlistTable.note, createdAt: AdminAllowlistTable.created_at })
      .from(AdminAllowlistTable).where(gte(AdminAllowlistTable.created_at, from)),
    db.select({ admins: count() }).from(AdminAllowlistTable),
    db.select({ ownerId: AuthApiKeyTable.referenceId, keys: count() }).from(AuthApiKeyTable)
      .where(gte(AuthApiKeyTable.createdAt, from)).groupBy(AuthApiKeyTable.referenceId).having(sql`count(*) >= ${API_KEY_TIERS.medium}`),
    db.select({
      enabled: sql<number>`coalesce(sum(case when ${AuthApiKeyTable.enabled} then 1 else 0 end), 0)`,
      withoutExpiry: sql<number>`coalesce(sum(case when ${AuthApiKeyTable.enabled} and ${AuthApiKeyTable.expiresAt} is null then 1 else 0 end), 0)`,
    }).from(AuthApiKeyTable),
    db.select({
      current: sql<number>`coalesce(sum(case when ${OAuthClientTable.createdAt} >= ${from} then 1 else 0 end), 0)`,
      previous: sql<number>`coalesce(sum(case when ${OAuthClientTable.createdAt} < ${from} then 1 else 0 end), 0)`,
      anonymous: sql<number>`coalesce(sum(case when ${OAuthClientTable.createdAt} >= ${from} and ${OAuthClientTable.userId} is null then 1 else 0 end), 0)`,
    }).from(OAuthClientTable).where(gte(OAuthClientTable.createdAt, previousFrom)),
    db.select({ userId: OAuthClientTable.userId, clients: count() }).from(OAuthClientTable)
      .where(and(gte(OAuthClientTable.createdAt, from), isNotNull(OAuthClientTable.userId)))
      .groupBy(OAuthClientTable.userId).having(sql`count(*) >= ${CLIENT_REGISTRATION_USER_TIERS.medium}`),
    db.select({ userId: InvitationTable.inviterId, invitations: count(), organizations: sql<number>`count(distinct ${InvitationTable.organizationId})` })
      .from(InvitationTable).where(gte(InvitationTable.createdAt, from))
      .groupBy(InvitationTable.inviterId).having(sql`count(*) >= ${INVITATION_TIERS.medium}`),
    db.select({
      organizationId: InferenceUsageLedgerEntryTable.organization_id,
      current: sql<number>`coalesce(sum(case when ${InferenceUsageLedgerEntryTable.occurred_at} >= ${from} then ${InferenceUsageLedgerEntryTable.cost_amount} else 0 end), 0)`,
      previous: sql<number>`coalesce(sum(case when ${InferenceUsageLedgerEntryTable.occurred_at} < ${from} then ${InferenceUsageLedgerEntryTable.cost_amount} else 0 end), 0)`,
    }).from(InferenceUsageLedgerEntryTable).where(gte(InferenceUsageLedgerEntryTable.occurred_at, previousFrom))
      .groupBy(InferenceUsageLedgerEntryTable.organization_id),
    db.select({
      organizationId: InferenceFreeUsageTable.organization_id,
      current: sql<number>`coalesce(sum(case when ${InferenceFreeUsageTable.created_at} >= ${from} then ${InferenceFreeUsageTable.amount} else 0 end), 0)`,
      previous: sql<number>`coalesce(sum(case when ${InferenceFreeUsageTable.created_at} < ${from} then ${InferenceFreeUsageTable.amount} else 0 end), 0)`,
    }).from(InferenceFreeUsageTable).where(gte(InferenceFreeUsageTable.created_at, previousFrom))
      .groupBy(InferenceFreeUsageTable.organization_id),
    // Hours with any OpenWork-billed model request, per member, for the round-the-clock check.
    db.selectDistinct({ memberId: InferenceUsageLedgerEntryTable.org_membership_id, hour: sql<number>`floor(unix_timestamp(${InferenceUsageLedgerEntryTable.occurred_at}) / 3600)` })
      .from(InferenceUsageLedgerEntryTable).where(gte(InferenceUsageLedgerEntryTable.occurred_at, from)),
    db.selectDistinct({ memberId: InferenceFreeUsageTable.org_membership_id, hour: sql<number>`floor(unix_timestamp(${InferenceFreeUsageTable.created_at}) / 3600)` })
      .from(InferenceFreeUsageTable).where(gte(InferenceFreeUsageTable.created_at, from)),
    // New accounts whose free Auto spend in their first day reached 90% of the weekly allowance.
    env.inferenceFree.weeklyLimitAmount > 0
      ? db.select({ userId: AuthUserTable.id, email: AuthUserTable.email, createdAt: AuthUserTable.createdAt, amount: sql<number>`coalesce(sum(${InferenceFreeUsageTable.amount}), 0)` })
        .from(InferenceFreeUsageTable)
        .innerJoin(MemberTable, eq(MemberTable.id, InferenceFreeUsageTable.org_membership_id))
        .innerJoin(AuthUserTable, eq(AuthUserTable.id, MemberTable.userId))
        .where(and(gte(AuthUserTable.createdAt, from), gte(InferenceFreeUsageTable.created_at, from),
          sql`${InferenceFreeUsageTable.created_at} < date_add(${AuthUserTable.createdAt}, interval 1 day)`))
        .groupBy(AuthUserTable.id, AuthUserTable.email, AuthUserTable.createdAt)
        .having(sql`coalesce(sum(${InferenceFreeUsageTable.amount}), 0) >= ${Math.floor(env.inferenceFree.weeklyLimitAmount * 0.9)}`)
      : [],
  ])

  // The earliest sign-in still on record stands for where each new account came from.
  const firstNetwork = new Map<string, { at: number; network: string | null }>()
  for (const row of firstSignIns) {
    const at = row.createdAt.getTime()
    const current = firstNetwork.get(row.userId)
    if (!current || at < current.at) firstNetwork.set(row.userId, { at, network: networkOf(row.ipAddress) })
  }
  const newAccounts: NewAccount[] = accounts.map((row) => ({ ...row, network: firstNetwork.get(row.userId)?.network ?? null }))

  const unverifiedByDomain = new Map<string, { unverified: number; total: number }>()
  for (const account of newAccounts) {
    const domain = emailDomain(account.email)
    if (!domain) continue
    const entry = unverifiedByDomain.get(domain) ?? { unverified: 0, total: 0 }
    entry.total += 1
    if (!account.emailVerified) entry.unverified += 1
    unverifiedByDomain.set(domain, entry)
  }

  const spread = new Map<string, { networks: Set<string>; clients: Set<string>; signIns: number }>()
  for (const row of sessions) {
    const entry = spread.get(row.userId) ?? { networks: new Set<string>(), clients: new Set<string>(), signIns: 0 }
    const network = networkOf(row.ipAddress)
    if (network) entry.networks.add(network)
    if (row.userAgent) entry.clients.add(row.userAgent)
    entry.signIns += number(row.signIns)
    spread.set(row.userId, entry)
  }
  const spreadUsers = [...spread].filter(([, entry]) => entry.networks.size >= NETWORK_SPREAD_TIERS.low)

  const newAccountIds = new Set(accounts.map((row) => row.userId as string))
  const automationSignIns = sessions.flatMap((row) => {
    const client = automationClientOf(row.userAgent)
    return client ? [{ userId: row.userId as string, client, signIns: number(row.signIns), newAccount: newAccountIds.has(row.userId) }] : []
  })

  // Distinct active UTC hours of each UTC day, per member, across paid and free model use.
  const hoursByMember = new Map<string, Set<number>>()
  for (const row of [...paidHours, ...freeHours]) {
    const hours = hoursByMember.get(row.memberId) ?? new Set<number>()
    hours.add(number(row.hour))
    hoursByMember.set(row.memberId, hours)
  }
  const roundTheClock = [...hoursByMember].flatMap(([memberId, hours]) => {
    const perDay = new Map<number, number>()
    for (const hour of hours) perDay.set(Math.floor(hour / 24), (perDay.get(Math.floor(hour / 24)) ?? 0) + 1)
    const days = [...perDay.values()]
    return days.some((value) => value >= ROUND_THE_CLOCK_HOURS) ? [{ memberId, days }] : []
  })
  const [activityMembers, activeAutomations] = roundTheClock.length ? await Promise.all([
    db.select({ id: MemberTable.id, userId: MemberTable.userId, organizationId: MemberTable.organizationId }).from(MemberTable)
      .where(inArray(MemberTable.id, roundTheClock.map((row) => row.memberId) as MemberId[])),
    db.select({ memberId: AutomationTable.owner_member_id, automations: count() }).from(AutomationTable)
      .where(and(inArray(AutomationTable.owner_member_id, roundTheClock.map((row) => row.memberId) as MemberId[]), eq(AutomationTable.state, "active"), sql`${AutomationTable.archived_at} is null`))
      .groupBy(AutomationTable.owner_member_id),
  ]) : [[], []]
  const memberById = new Map(activityMembers.map((member) => [member.id as string, member]))
  const automationsByMember = new Map(activeAutomations.map((row) => [row.memberId as string, number(row.automations)]))

  const spendByOrganization = new Map<string, { current: number; previous: number }>()
  for (const row of [...paidSpend, ...freeSpend]) {
    const entry = spendByOrganization.get(row.organizationId) ?? { current: 0, previous: 0 }
    entry.current += microUsd(number(row.current))
    entry.previous += microUsd(number(row.previous))
    spendByOrganization.set(row.organizationId, entry)
  }
  const spendCandidates = [...spendByOrganization].filter(([, entry]) => entry.current >= SPEND_SPIKE.mediumMicroUsd
    && entry.current >= entry.previous * SPEND_SPIKE.mediumGrowth)

  const userIds = [...new Set([
    ...spreadUsers.map(([userId]) => userId),
    ...owners.flatMap((row) => row.userId ? [row.userId] : []),
    ...keyOwners.map((row) => row.ownerId),
    ...clientUsers.flatMap((row) => row.userId ? [row.userId] : []),
    ...inviters.map((row) => row.userId),
    ...automationSignIns.map((row) => row.userId),
    ...activityMembers.flatMap((member) => member.userId ? [member.userId] : []),
  ])]
  const organizationIds = [...new Set([...spendCandidates.map(([id]) => id), ...activityMembers.map((member) => member.organizationId as string)])]
  const [users, organizations] = await Promise.all([
    userIds.length ? db.select({ id: AuthUserTable.id, email: AuthUserTable.email }).from(AuthUserTable).where(inArray(AuthUserTable.id, userIds as UserId[])) : [],
    organizationIds.length
      ? db.select({ id: OrganizationTable.id, name: OrganizationTable.name }).from(OrganizationTable)
        .where(inArray(OrganizationTable.id, organizationIds as OrganizationId[]))
      : [],
  ])
  const emailById = new Map(users.map((user) => [user.id as string, user.email]))
  const emailOf = (userId: string) => emailById.get(userId) ?? userId
  const nameById = new Map(organizations.map((organization) => [organization.id as string, organization.name]))

  const personal = new Set(PERSONAL_EMAIL_DOMAINS)
  const findings = [
    signupNetworkFinding(newAccounts, personal),
    unverifiedSignupFinding(newAccounts, { total: number(previousAccounts[0]?.total), unverified: number(previousAccounts[0]?.unverified) }),
    disposableSignupFinding(newAccounts),
    unverifiedDomainFinding([...unverifiedByDomain].map(([domain, entry]) => ({ domain, ...entry })), new Set([...PERSONAL_EMAIL_DOMAINS, ...DISPOSABLE_EMAIL_DOMAINS])),
    networkSpreadFinding(spreadUsers.map(([userId, entry]) => ({ userId, email: emailOf(userId), networks: entry.networks.size, signIns: entry.signIns, clients: entry.clients.size }))),
    organizationCreationFinding(owners.flatMap((row) => row.userId ? [{ userId: row.userId, email: emailOf(row.userId), organizations: number(row.organizations) }] : [])),
    adminGrantFinding(adminGrants, number(adminTotal[0]?.admins)),
    apiKeyFinding(keyOwners.map((row) => ({ ownerId: row.ownerId, label: emailOf(row.ownerId), keys: number(row.keys), isUser: emailById.has(row.ownerId) })),
      { enabled: number(keyPosture[0]?.enabled), withoutExpiry: number(keyPosture[0]?.withoutExpiry) }),
    clientRegistrationFinding({
      current: number(clientTotals[0]?.current), previous: number(clientTotals[0]?.previous), anonymous: number(clientTotals[0]?.anonymous),
      byUser: clientUsers.flatMap((row) => row.userId ? [{ userId: row.userId, email: emailOf(row.userId), clients: number(row.clients) }] : []),
    }),
    invitationFinding(inviters.map((row) => ({ userId: row.userId, email: emailOf(row.userId), invitations: number(row.invitations), organizations: number(row.organizations) }))),
    spendSpikeFinding(spendCandidates.map(([organizationId, entry]) => ({
      organizationId, name: nameById.get(organizationId) ?? organizationId, currentMicroUsd: entry.current, previousMicroUsd: entry.previous,
    }))),
    automationClientFinding(automationSignIns.map((row): AutomationSignIn => ({ ...row, email: emailOf(row.userId) }))),
    roundTheClockFinding(roundTheClock.flatMap((row) => {
      const member = memberById.get(row.memberId)
      if (!member?.userId) return []
      return [{ userId: member.userId, email: emailOf(member.userId), organization: nameById.get(member.organizationId) ?? member.organizationId, days: row.days, automations: automationsByMember.get(row.memberId) ?? 0 }]
    })),
    instantAllowanceFinding(firstDayAllowance.map((row) => ({ userId: row.userId, email: row.email, createdAt: row.createdAt, firstDayMicroUsd: microUsd(number(row.amount)) })),
      microUsd(env.inferenceFree.weeklyLimitAmount)),
  ]

  return {
    generatedAt: now.toISOString(),
    range: { days: input.days, from: from.toISOString(), to: now.toISOString() },
    findings: sortFindings(findings),
  }
}

/**
 * Refused, rate-limited and failed requests without a trusted tenant (sign-in, token,
 * registration and stale-credential calls) per hour for the last 24 hours. The log keeps
 * no addresses, so this shows volume and shape, not sources.
 */
export async function readSecurityRequests(input: { now?: Date } = {}): Promise<SecurityRequests> {
  const now = input.now ?? new Date()
  const currentHour = Math.floor(now.getTime() / HOUR_MS)
  const firstHour = currentHour - REQUEST_HOURS + 1
  const from = new Date(firstHour * HOUR_MS)
  const table = PlatformAuditEventTable
  // UNIX_TIMESTAMP on a TIMESTAMP column is UTC whatever the session time zone is.
  const hour = sql<number>`floor(unix_timestamp(${table.occurred_at}) / 3600)`
  const rows = await db.select({ hour, action: table.action, outcome: table.outcome, status: table.status, requests: count() })
    .from(table).where(and(gte(table.occurred_at, from), ne(table.outcome, "succeeded")))
    .groupBy(hour, table.action, table.outcome, table.status)

  const empty = (): HourlySeries => Array.from({ length: REQUEST_HOURS }, () => 0)
  const hourly = Array.from({ length: REQUEST_HOURS }, (_, index) => ({ hour: new Date((firstHour + index) * HOUR_MS).toISOString(), refused: 0, rateLimited: 0, failed: 0, failedSignIns: 0 }))
  const byAction = new Map<string, { refused: number; rateLimited: number; failed: number; series: HourlySeries }>()
  const limitedByAction = new Map<string, HourlySeries>()
  const signIns = empty()
  for (const row of rows) {
    const index = number(row.hour) - firstHour
    const bucket = hourly[index]
    if (!bucket) continue
    const requests = number(row.requests)
    const kind = row.status === 429 ? "rateLimited" : row.outcome === "denied" ? "refused" : "failed"
    bucket[kind] += requests
    const endpoint = byAction.get(row.action) ?? { refused: 0, rateLimited: 0, failed: 0, series: empty() }
    endpoint[kind] += requests
    endpoint.series[index] = (endpoint.series[index] ?? 0) + requests
    byAction.set(row.action, endpoint)
    if (kind === "rateLimited") {
      const series = limitedByAction.get(row.action) ?? empty()
      series[index] = (series[index] ?? 0) + requests
      limitedByAction.set(row.action, series)
    }
    if (isSignInAction(row.action)) {
      bucket.failedSignIns += requests
      signIns[index] = (signIns[index] ?? 0) + requests
    }
  }

  const total = (entry: { refused: number; rateLimited: number; failed: number }) => entry.refused + entry.rateLimited + entry.failed
  const endpoints = [...byAction].sort(([a, left], [b, right]) => total(right) - total(left) || a.localeCompare(b))
    .slice(0, REQUEST_ENDPOINT_LIMIT).map(([action, entry]) => {
      const spike = spikeOf(entry.series)
      return { action, refused: entry.refused, rateLimited: entry.rateLimited, failed: entry.failed, peakHour: spike.peak, typicalHour: spike.typical }
    })

  return {
    generatedAt: now.toISOString(),
    range: { hours: REQUEST_HOURS, from: from.toISOString(), to: now.toISOString() },
    hourly,
    endpoints,
    findings: sortFindings([
      failedSignInFinding(signIns),
      rateLimitedFinding(limitedByAction),
      deniedSpikeFinding(new Map([...byAction].map(([action, entry]) => [action, entry.series]))),
    ]),
  }
}

/** The 24-hour rollup reads about a million log rows in production; admins share one result for a short while per instance. */
export const SECURITY_REQUESTS_CACHE_MS = 120_000
let requestsCache: { at: number; value: Promise<SecurityRequests> } | null = null

function cachedSecurityRequests(): Promise<SecurityRequests> {
  const now = Date.now()
  if (requestsCache && now - requestsCache.at < SECURITY_REQUESTS_CACHE_MS) return requestsCache.value
  const value = readSecurityRequests({ now: new Date(now) })
  requestsCache = { at: now, value }
  // A failed read is never served again from the cache.
  value.catch(() => { if (requestsCache?.value === value) requestsCache = null })
  return value
}

const routeErrors = {
  401: jsonResponse("The caller must be authenticated.", unauthorizedSchema),
  403: jsonResponse("The authenticated user is not an admin.", forbiddenSchema),
}

export function registerAdminSecurityRoutes<T extends { Variables: AuthContextVariables }>(app: Hono<T>) {
  app.get(
    "/v1/admin/security",
    describeRoute({
      tags: ["Admin"],
      summary: "Get security signals across all organizations",
      description: "Returns threshold-based findings for the last `days` days: sign-up bursts, unverified and disposable sign-ups, accounts used from many networks, organization, API key, app registration and invitation bursts, new platform admins, model spend spikes, and bot-like use (automation-tool sign-ins, model use around the clock, free allowance used up on day one). Findings are prompts for review, not verdicts.",
      responses: {
        200: jsonResponse("Security signals returned.", securityReportResponseSchema),
        400: jsonResponse("The query parameters were invalid.", invalidRequestSchema),
        ...routeErrors,
      },
    }),
    adminRoute(),
    queryValidator(querySchema),
    async (c) => c.json(await readSecurityReport({ days: c.req.valid("query").days }), 200, { "cache-control": "no-store" }),
  )
  app.get(
    "/v1/admin/security/requests",
    describeRoute({
      tags: ["Admin"],
      summary: "Get refused and failed platform requests for the last 24 hours",
      description: "Returns hourly counts of refused, rate-limited and failed requests that had no trusted organization (sign-in, token, app registration and stale-credential calls), the busiest endpoints, and findings for failed sign-ins, rate limiting and refusal spikes. No addresses are stored or returned.",
      responses: {
        200: jsonResponse("Request activity returned.", securityRequestsResponseSchema),
        ...routeErrors,
      },
    }),
    adminRoute(),
    async (c) => c.json(await cachedSecurityRequests(), 200, { "cache-control": "no-store" }),
  )
}
