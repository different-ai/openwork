import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { eq, or, sql, type SQL } from "@openwork-ee/den-db/drizzle"
import { OrganizationTable } from "@openwork-ee/den-db/schema"
import { z } from "zod"
import { db } from "../db.js"
import { getDesktopReleaseMetadata } from "../desktop-releases.js"
import { env } from "../env.js"
import { adminOrganizationPlanInputSchema, setOrganizationPlanByAdmin } from "../admin-organization-plan.js"
import { readFeatureRollouts } from "@openwork-ee/den-db/organization-features"
import { updateFeatureRollout, updateOrganizationFeatureOverrides } from "../features.js"
import { isDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { SANDBOX_MAX_CREDIT_USD, SANDBOX_MAX_DAYS, SANDBOX_MAX_MEMBERS, sandboxCreateInputSchema } from "@openwork/types/den/sandbox-organizations"
import { closeSandbox, createSandbox, extendSandbox, listSandboxes, sandboxDefaults, setSandboxCredit } from "../sandbox-organizations.js"
import { FEATURE_KEYS, featureAvailableOn, featureDefinition, featureDocsUrl, featureKeySchema, featureRollout, resolveFeature } from "@openwork/features"
import { runPlatformAdminPlatformAction, runPlatformAdminServiceAction, type PlatformAdminAuditActor } from "../audit/mcp-service-audit.js"
import { readWorkbotAdoptionReport, workbotAdoptionInputSchema } from "../workbot/adoption-report.js"
import { assertReadOnlySql, isDatabaseTimeLimitError, withDatabaseTimeLimit } from "./admin-query-limit.js"
import { DEN_MCP_WRITE_SCOPE } from "./scopes.js"
import { buildRetentionCohorts } from "../admin-metrics/definitions.js"
import { readTaskUserWindows } from "../admin-metrics/metrics.js"
import { normalizeRows } from "../admin-metrics/sql.js"

/**
 * den-admin MCP toolset: read-only Den analytics for allowlisted platform
 * admins, served over streamable HTTP at /mcp/admin (see ./admin.ts).
 *
 * This is the server-hosted successor of ee/packages/den-admin-mcp (the
 * stdio break-glass variant that talks straight to MySQL). Tool names and
 * payloads are kept compatible; bump DEN_ADMIN_MCP_VERSION when they change
 * so `den_admin_version` can be used to spot stale deploys.
 *
 * Hardening: every statement goes through the shared read-only guard, which
 * also refuses credential tables, raw `den_query` results are row-capped, and
 * all queries race a wall-clock timeout so one expensive SELECT cannot pin an
 * API worker indefinitely. Raw `den_query` SELECTs also carry the limit to the
 * database, which stops the statement itself (admin-query-limit.ts). Admin
 * write tools need the caller's mcp:write scope, like connection writes.
 */

export const DEN_ADMIN_MCP_VERSION = "0.11.0"

const QUERY_TIMEOUT_MS = 15_000
// Slightly under Den's own timer, so the database stops the statement first.
const DATABASE_TIME_LIMIT_MS = QUERY_TIMEOUT_MS - 1_000
const DEFAULT_ROW_LIMIT = 200
const MAX_ROW_LIMIT = 1000

const SERVER_STARTED_AT = new Date().toISOString()

type Row = Record<string, unknown>
type OrganizationId = typeof OrganizationTable.$inferSelect.id

type OrganizationRecord = {
  id: typeof OrganizationTable.$inferSelect.id
  name: typeof OrganizationTable.$inferSelect.name
  slug: typeof OrganizationTable.$inferSelect.slug
  metadata: typeof OrganizationTable.$inferSelect.metadata
}

const organizationSelect = {
  id: OrganizationTable.id,
  name: OrganizationTable.name,
  slug: OrganizationTable.slug,
  metadata: OrganizationTable.metadata,
}

export { normalizeRows }

async function rows(query: SQL): Promise<Row[]> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Query exceeded the ${QUERY_TIMEOUT_MS}ms time limit`)),
      QUERY_TIMEOUT_MS,
    )
  })
  try {
    const result: unknown = await Promise.race([db.execute(query), timeout])
    return normalizeRows(result)
  } finally {
    clearTimeout(timer)
  }
}

const n = (value: unknown) => {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

/** Inline a zod-validated integer into SQL (interval/limit positions reject placeholders on some drivers). */
function intLiteral(value: number): SQL {
  if (!Number.isInteger(value)) {
    throw new Error("Expected an integer")
  }
  return sql.raw(String(value))
}

function idList(ids: string[]): SQL {
  return sql.join(ids.map((id) => sql`${id}`), sql`, `)
}

function isOrganizationId(value: string): value is OrganizationId {
  return value.startsWith("org_")
}

function organizationCandidate(organization: OrganizationRecord) {
  return {
    id: organization.id,
    name: organization.name,
    slug: organization.slug,
  }
}

async function resolveOrganization(org: string): Promise<
  | { organization: OrganizationRecord }
  | { error: "ambiguous_organization"; candidates: Array<ReturnType<typeof organizationCandidate>> }
> {
  const input = org.trim()
  if (!input) {
    throw new Error("Organization is required")
  }

  const exactMatches = await db
    .select(organizationSelect)
    .from(OrganizationTable)
    .where(isOrganizationId(input) ? or(eq(OrganizationTable.id, input), eq(OrganizationTable.slug, input)) : eq(OrganizationTable.slug, input))
    .limit(2)

  const exactMatch = exactMatches[0]
  if (exactMatches.length === 1 && exactMatch) {
    return { organization: exactMatch }
  }
  if (exactMatches.length > 1) {
    return { error: "ambiguous_organization", candidates: exactMatches.map(organizationCandidate) }
  }

  const nameMatches = await db
    .select(organizationSelect)
    .from(OrganizationTable)
    .where(sql`${OrganizationTable.name} LIKE ${`%${input}%`}`)
    .limit(11)

  const nameMatch = nameMatches[0]
  if (nameMatches.length === 1 && nameMatch) {
    return { organization: nameMatch }
  }
  if (nameMatches.length > 1) {
    return { error: "ambiguous_organization", candidates: nameMatches.map(organizationCandidate) }
  }

  throw new Error(`No organization matching "${org}"`)
}

function toTime(value: unknown): number | null {
  if (value instanceof Date) {
    const time = value.getTime()
    return Number.isNaN(time) ? null : time
  }
  if (typeof value === "string" && value.trim()) {
    const time = Date.parse(value)
    return Number.isNaN(time) ? null : time
  }
  return null
}

function toIso(value: unknown): string | null {
  const time = toTime(value)
  return time === null ? null : new Date(time).toISOString()
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean }

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] }
}

async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await fn())
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true }
  }
}

function isMissingTable(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false
  }
  const record = error as Record<string, unknown>
  if (record.code === "ER_NO_SUCH_TABLE") {
    return true
  }
  if (typeof record.message === "string" && /table '.*' doesn't exist/i.test(record.message)) {
    return true
  }
  return isMissingTable(record.cause)
}

// --- activity (sign-in session days UNION session.active telemetry days) ---
// Matches den-api /v1/admin/overview: a user is "active" on a day if they
// have a sign-in session day or a session.active telemetry event that day.

async function activeUserCount(days: number): Promise<number> {
  const interval = intLiteral(days)
  try {
    const result = await rows(sql`SELECT COUNT(DISTINCT uid) AS count FROM (
        SELECT s.user_id AS uid FROM session s
         WHERE s.updated_at >= DATE_SUB(NOW(), INTERVAL ${interval} DAY)
        UNION
        SELECT m.user_id FROM telemetry_event t
          JOIN member m ON m.id = t.member_id
         WHERE m.user_id IS NOT NULL
           AND t.event_timestamp >= DATE_SUB(NOW(), INTERVAL ${interval} DAY)
      ) activity`)
    return n(result[0]?.count)
  } catch (error) {
    if (!isMissingTable(error)) throw error
    const result = await rows(sql`SELECT COUNT(DISTINCT user_id) AS count FROM session
       WHERE updated_at >= DATE_SUB(NOW(), INTERVAL ${interval} DAY)`)
    return n(result[0]?.count)
  }
}

async function activityDays(): Promise<Row[]> {
  try {
    return await rows(sql`SELECT s.user_id AS uid, DATE(s.updated_at) AS day FROM session s
        UNION
        SELECT m.user_id, DATE(t.event_timestamp) FROM telemetry_event t
          JOIN member m ON m.id = t.member_id
         WHERE m.user_id IS NOT NULL`)
  } catch (error) {
    if (!isMissingTable(error)) throw error
    return rows(sql`SELECT user_id AS uid, DATE(updated_at) AS day FROM session GROUP BY uid, day`)
  }
}

async function lastActiveByUser(userIds: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>()
  if (userIds.length === 0) return result
  const merge = (userId: unknown, value: unknown) => {
    if (typeof userId !== "string") return
    const time = toTime(value)
    if (time === null) return
    const previous = result.get(userId)
    if (previous === undefined || time > previous) result.set(userId, time)
  }
  const sessionRows = await rows(
    sql`SELECT user_id, MAX(updated_at) AS last FROM session WHERE user_id IN (${idList(userIds)}) GROUP BY user_id`,
  )
  for (const row of sessionRows) merge(row.user_id, row.last)
  try {
    const telemetryRows = await rows(
      sql`SELECT m.user_id AS user_id, MAX(t.event_timestamp) AS last FROM telemetry_event t
           JOIN member m ON m.id = t.member_id
          WHERE m.user_id IN (${idList(userIds)}) GROUP BY m.user_id`,
    )
    for (const row of telemetryRows) merge(row.user_id, row.last)
  } catch (error) {
    if (!isMissingTable(error)) throw error
  }
  return result
}

const lastActiveIso = (lastActive: Map<string, number>, userId: unknown): string | null => {
  if (typeof userId !== "string") return null
  const time = lastActive.get(userId)
  return time === undefined ? null : new Date(time).toISOString()
}

type Membership = { organization: unknown; slug: unknown; role: unknown }

async function membershipsByUser(userIds: string[]): Promise<Map<string, Membership[]>> {
  const result = new Map<string, Membership[]>()
  if (userIds.length === 0) return result
  const memberRows = await rows(
    sql`SELECT m.user_id, m.role, o.name, o.slug FROM member m
         JOIN organization o ON o.id = m.organization_id
        WHERE m.user_id IN (${idList(userIds)}) AND m.removed_at IS NULL`,
  )
  for (const row of memberRows) {
    if (typeof row.user_id !== "string") continue
    const list = result.get(row.user_id) ?? []
    list.push({ organization: row.name, slug: row.slug, role: row.role })
    result.set(row.user_id, list)
  }
  return result
}

async function describeUsers(userRows: Row[]) {
  const ids = userRows
    .map((row) => row.id)
    .filter((id): id is string => typeof id === "string")
  const [lastActive, memberships] = await Promise.all([
    lastActiveByUser(ids),
    membershipsByUser(ids),
  ])
  return userRows.map((row) => ({
    name: row.name,
    email: row.email,
    signedUpAt: row.created_at,
    lastActiveAt: lastActiveIso(lastActive, row.id),
    organizations: (typeof row.id === "string" ? memberships.get(row.id) : undefined) ?? [],
  }))
}

/** Append a LIMIT to bare SELECT/WITH statements and clamp the cap. */
export function applyDefaultRowLimit(sqlText: string, limit?: number): { sql: string; cap: number } {
  const cap = Math.max(1, Math.min(limit ?? DEFAULT_ROW_LIMIT, MAX_ROW_LIMIT))
  if (/^(select|with)\b/i.test(sqlText) && !/\blimit\s+\d+/i.test(sqlText)) {
    return { sql: `${sqlText} LIMIT ${cap}`, cap }
  }
  return { sql: sqlText, cap }
}

export async function buildAdminMcpVersionInfo() {
  const { minAppVersion, latestAppVersion } = await getDesktopReleaseMetadata()
  return {
    name: "den-admin",
    transport: "streamable-http",
    toolsetVersion: DEN_ADMIN_MCP_VERSION,
    denApi: { minAppVersion, latestAppVersion },
    node: process.version,
    serverStartedAt: SERVER_STARTED_AT,
  }
}

// --- tool registration ---

/** The verified platform admin calling the tools, with the scopes of the token they called with. */
export type AdminToolCaller = PlatformAdminAuditActor & Readonly<{ scopes: ReadonlySet<string> }>

/**
 * `admin` is the verified platform admin calling the tools; org-mutating tools
 * are audited for it (src/audit/service-actions.ts) and refuse without it or
 * without its mcp:write scope. Pass null only for catalog listing.
 */
export function registerAdminMcpTools(server: McpServer, admin: AdminToolCaller | null) {
  const requireAdmin = () => {
    if (!admin) throw new Error("Admin write tools require an authenticated platform admin.")
    return admin
  }
  // The same refusal connection writes give a token without the write scope.
  const writeScopeMissing = (toolName: string): ToolResult | null => {
    if (!admin || admin.scopes.has(DEN_MCP_WRITE_SCOPE)) return null
    const refusal = { error: "insufficient_mcp_scope", requiredScope: DEN_MCP_WRITE_SCOPE, message: `${toolName} requires the ${DEN_MCP_WRITE_SCOPE} scope.` }
    return { content: [{ type: "text", text: JSON.stringify(refusal) }], isError: true }
  }

  server.registerTool(
    "den_admin_version",
    {
      description:
        "Report the den-admin MCP toolset version, den-api build versions, and process start time so you can verify which build is deployed.",
    },
    async () => run(async () => buildAdminMcpVersionInfo()),
  )

  server.registerTool(
    "den_overview",
    {
      description:
        "High-level Den admin overview: total users/organizations/members, new users (7d/30d), active users (DAU/WAU/MAU, plus 'real' task-executing variants), pending invitations, and subscriptions by status.",
    },
    async () =>
      run(async () => {
        const [users, orgs, members, invitations, subscriptions, dau, wau, mau, taskUsers] = await Promise.all([
          rows(sql`SELECT COUNT(*) AS total,
                  SUM(created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)) AS new7d,
                  SUM(created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)) AS new30d
                FROM user`),
          rows(sql`SELECT COUNT(*) AS total FROM organization`),
          rows(sql`SELECT COUNT(*) AS total FROM member WHERE removed_at IS NULL`),
          rows(sql`SELECT COUNT(*) AS pending FROM invitation WHERE status = 'pending'`),
          rows(sql`SELECT type, status, COUNT(*) AS count FROM org_subscriptions GROUP BY type, status`),
          activeUserCount(1),
          activeUserCount(7),
          activeUserCount(30),
          readTaskUserWindows(rows, new Date()).catch((error: unknown) => {
            if (!isMissingTable(error)) throw error
            return { daily: 0, weekly: 0, monthly: 0 }
          }),
        ])
        return {
          users: {
            total: n(users[0]?.total),
            newLast7d: n(users[0]?.new7d),
            newLast30d: n(users[0]?.new30d),
          },
          organizations: n(orgs[0]?.total),
          activeMembers: n(members[0]?.total),
          pendingInvitations: n(invitations[0]?.pending),
          activeUsers: { daily: dau, weekly: wau, monthly: mau },
          realActiveUsers: { daily: taskUsers.daily, weekly: taskUsers.weekly, monthly: taskUsers.monthly },
          subscriptions: subscriptions.map((row) => ({
            type: row.type,
            status: row.status,
            count: n(row.count),
          })),
          note: "active = sign-in session day or any telemetry event; realActive = ran at least one task in a session from the app (task.* events with a session id), excluding setup agents and removed members, as in the admin Control Center",
        }
      }),
  )

  server.registerTool(
    "den_update_org_plan",
    {
      description:
        "Admin write tool: set an organization's plan (free, team or enterprise) and how many users it allows, counting pending invitations, the same control as /admin › Billing. Invitations, SSO sign-up and SCIM all enforce it unless a paid Stripe plan bills every user. Team and Enterprise may carry a display-only end date (endsAt, YYYY-MM-DD; null clears it). Never changes Stripe. Returns the resolved plan.",
      inputSchema: z.object({
        organizationId: z.string().min(1).describe("Organization id, e.g. org_..."),
        tier: z.enum(["free", "team", "enterprise"]).describe("Plan tier to set"),
        seatLimit: z.number().int().min(1).max(100000).describe("Users allowed, counting pending invitations (at least 5; smaller values are raised to 5)"),
        endsAt: z.string().nullable().optional().describe("Optional end date for team or enterprise, YYYY-MM-DD; display only. null clears it. Not allowed on free."),
      }),
    },
    async ({ organizationId, tier, seatLimit, endsAt }) =>
      writeScopeMissing("den_update_org_plan") ?? run(async () => {
        if (!isOrganizationId(organizationId)) {
          throw new Error("Invalid organization id")
        }
        const input = adminOrganizationPlanInputSchema.safeParse({ tier, seatLimit, endsAt })
        if (!input.success) {
          throw new Error(input.error.issues[0]?.message ?? "Invalid organization plan")
        }

        const existing = await db
          .select({ id: OrganizationTable.id, name: OrganizationTable.name, slug: OrganizationTable.slug })
          .from(OrganizationTable)
          .where(eq(OrganizationTable.id, organizationId))
          .limit(1)

        const organization = existing[0]
        if (!organization) {
          throw new Error(`No organization found for ${organizationId}`)
        }

        const plan = await runPlatformAdminServiceAction("organization.plan.set", requireAdmin(), organization, () => setOrganizationPlanByAdmin(organizationId, input.data))

        return {
          ok: true,
          organization: {
            id: organization.id,
            name: organization.name,
            slug: organization.slug,
            plan,
            seatLimit: plan.seats ?? plan.userLimit ?? input.data.seatLimit,
          },
        }
      }),
  )

  server.registerTool(
    "den_set_org_capability",
    {
      description:
        "Admin write tool: turn one feature on or off for one organization (an organization override, the same switch as the admin panel), e.g. capability='workbotDocuments'. enabled=null removes the override so the feature follows the deployment-wide on/off state again. The kill switch (den_set_feature_rollout) still outranks it.",
      inputSchema: z.object({
        organizationId: z.string().min(1).describe("Organization id, e.g. org_..."),
        capability: featureKeySchema.describe("Feature to set (see packages/features/src/registry.ts)"),
        enabled: z.boolean().nullable().describe("true or false, or null to restore the default"),
      }),
    },
    async ({ organizationId, capability, enabled }) =>
      writeScopeMissing("den_set_org_capability") ?? run(async () => {
        if (!isOrganizationId(organizationId)) {
          throw new Error("Invalid organization id")
        }
        const existing = await db
          .select({ id: OrganizationTable.id, name: OrganizationTable.name, slug: OrganizationTable.slug })
          .from(OrganizationTable)
          .where(eq(OrganizationTable.id, organizationId))
          .limit(1)
        const organization = existing[0]
        if (!organization) {
          throw new Error(`No organization found for ${organizationId}`)
        }
        if (!featureAvailableOn(capability, env.features.deployment)) {
          throw new Error(`${capability} is not part of this deployment.`)
        }
        const overrides = await runPlatformAdminServiceAction("organization.capability.set", requireAdmin(), organization, () => updateOrganizationFeatureOverrides({
          organizationId,
          changes: { [capability]: enabled },
          source: "platform",
          setByUserId: requireAdmin().userId,
        }))
        return {
          ok: true,
          organization: { id: organization.id, name: organization.name, slug: organization.slug },
          capability,
          enabled: resolveFeature(capability, {
            ...env.features,
            rollouts: await readFeatureRollouts(db),
            overrides,
          }).enabled,
        }
      }),
  )

  server.registerTool(
    "den_list_features",
    {
      description:
        "Admin read tool: every feature in the registry with its author, internal docs link, the deployments it exists on and this deployment's state (on or off for everyone, kill switch, operator lock).",
      inputSchema: z.object({}),
    },
    async () =>
      run(async () => {
        const rollouts = await readFeatureRollouts(db)
        return {
          deployment: env.features.deployment,
          features: FEATURE_KEYS.map((key) => {
            const definition = featureDefinition(key)
            return {
              key,
              label: definition.label,
              category: definition.category,
              added: definition.added,
              author: definition.author,
              docsUrl: featureDocsUrl(key),
              deployments: definition.deployments,
              available: featureAvailableOn(key, env.features.deployment),
              ...featureRollout(key, rollouts),
              lock: env.features.locks[key] ?? null,
            }
          }),
        }
      }),
  )

  server.registerTool(
    "den_set_feature_rollout",
    {
      description:
        "Admin write tool: change a feature for this whole deployment. enabled turns it on or off for everyone (organization overrides still apply); killed=true turns it off everywhere at once (the revert), outranking operator locks and organization overrides.",
      inputSchema: z.object({
        feature: featureKeySchema.describe("Feature key (see den_list_features)"),
        enabled: z.boolean().optional().describe("true for on for everyone, false for off"),
        killed: z.boolean().optional().describe("true to turn it off everywhere, false to clear the kill switch"),
      }),
    },
    async ({ feature, enabled, killed }) =>
      writeScopeMissing("den_set_feature_rollout") ?? run(async () => {
        if (enabled === undefined && killed === undefined) throw new Error("Set enabled, killed, or both.")
        if (!featureAvailableOn(feature, env.features.deployment)) throw new Error(`${feature} is not part of this deployment.`)
        // Deployment-wide: no organization's data changes, so platform evidence only.
        const rollouts = await runPlatformAdminPlatformAction("feature.rollout.set", requireAdmin(), { type: "feature", id: feature }, () =>
          updateFeatureRollout({ key: feature, enabled, killed, defaultEnabled: featureDefinition(feature).default, updatedByUserId: requireAdmin().userId }))
        return { ok: true, feature, ...featureRollout(feature, rollouts) }
      }),
  )

  server.registerTool(
    "den_growth",
    {
      description:
        "Signup growth series for users or organizations, bucketed by day/week/month, with period-over-period growth rates and cumulative totals.",
      inputSchema: z.object({
        metric: z.enum(["users", "organizations"]).default("users").describe("What to count"),
        interval: z.enum(["day", "week", "month"]).default("week").describe("Bucket size"),
        periods: z.number().int().min(1).max(36).default(12).describe("How many periods back"),
      }),
    },
    async ({ metric, interval, periods }) =>
      run(async () => {
        const table = sql.raw(metric === "organizations" ? "organization" : "user")
        const format = { day: "%Y-%m-%d", week: "%x-W%v", month: "%Y-%m" }[interval]
        const unit = sql.raw({ day: "DAY", week: "WEEK", month: "MONTH" }[interval])
        const span = intLiteral(periods)
        const [series, before] = await Promise.all([
          rows(sql`SELECT DATE_FORMAT(created_at, ${format}) AS period, COUNT(*) AS count FROM ${table}
              WHERE created_at >= DATE_SUB(NOW(), INTERVAL ${span} ${unit})
              GROUP BY period ORDER BY period`),
          rows(sql`SELECT COUNT(*) AS count FROM ${table}
              WHERE created_at < DATE_SUB(NOW(), INTERVAL ${span} ${unit})`),
        ])
        let cumulative = n(before[0]?.count)
        let previous: number | null = null
        const buckets = series.map((row) => {
          const count = n(row.count)
          cumulative += count
          const growthPercent =
            previous === null || previous === 0
              ? null
              : Math.round(((count - previous) / previous) * 1000) / 10
          previous = count
          return { period: row.period, new: count, cumulative, growthPercent }
        })
        const complete = buckets.slice(0, -1)
        const latest = complete[complete.length - 1]
        return {
          metric,
          interval,
          startingTotal: n(before[0]?.count),
          buckets,
          latestCompletePeriod: latest ?? null,
          note: "last bucket is the current in-progress period; growthPercent compares new signups vs the previous bucket; periods with zero signups are omitted",
        }
      }),
  )

  server.registerTool(
    "den_retention",
    {
      description:
        "Weekly cohort retention: users grouped by ISO signup week, with the percentage active in each week after signup (activity = sign-in session days + session.active telemetry).",
      inputSchema: z.object({
        weeks: z.number().int().min(2).max(26).default(8).describe("How many signup-week cohorts"),
      }),
    },
    async ({ weeks }) =>
      run(async () => {
        const users = await rows(
          sql`SELECT id, DATE(created_at) AS day, DATE_FORMAT(created_at, '%x-W%v') AS week
             FROM user WHERE created_at >= DATE_SUB(NOW(), INTERVAL ${intLiteral(weeks)} WEEK)`,
        )
        const activity = await activityDays()
        const signups = users.flatMap((row) => {
          const time = toTime(row.day)
          return typeof row.id === "string" && typeof row.week === "string" && time !== null ? [{ userId: row.id, cohort: row.week, signupTime: time }] : []
        })
        const activityRows = activity.flatMap((row) => {
          const dayTime = toTime(row.day)
          return typeof row.uid === "string" && dayTime !== null ? [{ userId: row.uid, dayTime }] : []
        })
        const result = buildRetentionCohorts(signups, activityRows).map((cohort) => {
          const byWeek: Record<string, { users: number; percent: number }> = {}
          for (const [offset, retained] of cohort.retained) {
            byWeek[`week${offset}`] = { users: retained, percent: Math.round((retained / cohort.signups) * 1000) / 10 }
          }
          return { cohort: cohort.cohort, signups: cohort.signups, retention: byWeek }
        })
        return {
          cohorts: result,
          note: "week0 = signup week; weekN = active N weeks after signup",
        }
      }),
  )

  server.registerTool(
    "den_workbot_adoption",
    {
      description:
        "Platform-admin read-only Workbot adoption funnel, grouped by first recorded sign-in day (UTC) and organization: signed in, greeting completed, first message, at least one connected service. Includes id-only member pages with initial/greeting ready counts, later connection success counts, completion model/source details, and greeting failures by error code/model. Dates are inclusive, at most 90 days; totals cover the full cohort even when breakdowns are truncated. Never reads messages or profile fields.",
      inputSchema: workbotAdoptionInputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (input) =>
      run(async () => {
        if (!admin) throw new Error("Workbot adoption reports require an authenticated platform admin.")
        return readWorkbotAdoptionReport(input, rows)
      }),
  )

  server.registerTool(
    "den_company_users",
    {
      description:
        "Find users related to a company: matches organizations by name/slug/allowed email domains, and users by email domain. Returns members with role, signup date, and last activity.",
      inputSchema: z.object({
        company: z.string().min(1).describe("Company name, org slug, or email domain (e.g. 'acme', 'acme.test')"),
        limit: z.number().int().min(1).max(200).default(50).describe("Max users per group"),
      }),
    },
    async ({ company, limit }) =>
      run(async () => {
        const query = company.includes("@") ? company.split("@").pop() ?? company : company
        const like = `%${query}%`
        const cap = intLiteral(limit)
        const organizations = await rows(
          sql`SELECT id, name, slug, created_at FROM organization
            WHERE name LIKE ${like} OR slug LIKE ${like} OR allowed_email_domains LIKE ${like} LIMIT 10`,
        )
        const orgResults = []
        for (const org of organizations) {
          const memberRows = await rows(
            sql`SELECT u.id, u.name, u.email, u.created_at, m.role, m.joined_at FROM member m
               JOIN user u ON u.id = m.user_id
              WHERE m.organization_id = ${org.id} AND m.removed_at IS NULL
              ORDER BY m.joined_at LIMIT ${cap}`,
          )
          const lastActive = await lastActiveByUser(
            memberRows.map((row) => row.id).filter((id): id is string => typeof id === "string"),
          )
          orgResults.push({
            organization: org.name,
            slug: org.slug,
            createdAt: org.created_at,
            members: memberRows.map((row) => ({
              name: row.name,
              email: row.email,
              role: row.role,
              joinedAt: row.joined_at,
              lastActiveAt: lastActiveIso(lastActive, row.id),
            })),
          })
        }
        const domainRows = await rows(
          sql`SELECT id, name, email, created_at FROM user
            WHERE email LIKE ${`%@%${query}%`} ORDER BY created_at DESC LIMIT ${cap}`,
        )
        return {
          organizations: orgResults,
          usersByEmailDomain: await describeUsers(domainRows),
        }
      }),
  )

  server.registerTool(
    "den_users_search",
    {
      description:
        "Search users by name or email substring. Returns signup date, last activity, and organization memberships.",
      inputSchema: z.object({
        query: z.string().min(1).describe("Name or email substring"),
        limit: z.number().int().min(1).max(100).default(20),
      }),
    },
    async ({ query, limit }) =>
      run(async () => {
        const like = `%${query}%`
        const userRows = await rows(
          sql`SELECT id, name, email, created_at FROM user
            WHERE email LIKE ${like} OR name LIKE ${like} ORDER BY created_at DESC LIMIT ${intLiteral(limit)}`,
        )
        return { users: await describeUsers(userRows) }
      }),
  )

  server.registerTool(
    "den_org_overview",
    {
      description:
        "Deep dive on one organization (by slug or name): members by role, pending invitations, teams, subscriptions, and active members in the last 7/30 days.",
      inputSchema: z.object({
        org: z.string().min(1).describe("Organization slug or name"),
      }),
    },
    async ({ org }) =>
      run(async () => {
        const matches = await rows(
          sql`SELECT id, name, slug, allowed_email_domains, created_at FROM organization
            WHERE slug = ${org} OR name LIKE ${`%${org}%`} LIMIT 1`,
        )
        const found = matches[0]
        if (!found) throw new Error(`No organization matching "${org}"`)
        const [roleRows, invitations, teams, subscriptions, memberRows] = await Promise.all([
          rows(sql`SELECT role, COUNT(*) AS count FROM member
              WHERE organization_id = ${found.id} AND removed_at IS NULL GROUP BY role`),
          rows(sql`SELECT email, role, status, created_at FROM invitation
              WHERE organization_id = ${found.id} AND status = 'pending' ORDER BY created_at DESC LIMIT 50`),
          rows(sql`SELECT COUNT(*) AS count FROM team WHERE organization_id = ${found.id}`),
          rows(sql`SELECT type, status, quantity, current_period_end FROM org_subscriptions
              WHERE organization_id = ${found.id}`),
          rows(sql`SELECT u.id, u.name, u.email, u.created_at, m.role FROM member m
               JOIN user u ON u.id = m.user_id
              WHERE m.organization_id = ${found.id} AND m.removed_at IS NULL LIMIT 100`),
        ])
        const lastActive = await lastActiveByUser(
          memberRows.map((row) => row.id).filter((id): id is string => typeof id === "string"),
        )
        const activeSince = (days: number) => {
          const cutoff = Date.now() - days * 86_400_000
          return memberRows.filter((row) => {
            const last = typeof row.id === "string" ? lastActive.get(row.id) : undefined
            return last !== undefined && last >= cutoff
          }).length
        }
        return {
          organization: {
            name: found.name,
            slug: found.slug,
            createdAt: found.created_at,
            allowedEmailDomains: found.allowed_email_domains,
          },
          membersByRole: roleRows.map((row) => ({ role: row.role, count: n(row.count) })),
          activeMembersLast7d: activeSince(7),
          activeMembersLast30d: activeSince(30),
          teams: n(teams[0]?.count),
          pendingInvitations: invitations,
          subscriptions,
          members: memberRows.map((row) => ({
            name: row.name,
            email: row.email,
            role: row.role,
            lastActiveAt: lastActiveIso(lastActive, row.id),
          })),
        }
      }),
  )

  server.registerTool(
    "den_query",
    {
      description:
        "Escape hatch: run a single read-only SQL statement (SELECT/WITH/SHOW/DESCRIBE/EXPLAIN) against the Den database. Useful tables: user, organization, member, team, org_subscriptions, telemetry_event, worker, audit_event. Statements that name a credential table (session, account, verification, apikey, OAuth tokens, invitation, stored keys and secrets) or server internals are refused; use den_overview/den_retention for sign-in activity and single quotes for text. Avoid encrypted columns (sso_provider.*_config, llm_provider.api_key, config_object_version payloads).",
      inputSchema: z.object({
        sql: z.string().min(1).describe("A single read-only SQL statement"),
        limit: z.number().int().min(1).max(MAX_ROW_LIMIT).optional().describe("Row limit appended when the query has none"),
      }),
    },
    async ({ sql: sqlText, limit }) =>
      run(async () => {
        const safe = applyDefaultRowLimit(assertReadOnlySql(sqlText), limit)
        const result = await rows(sql.raw(withDatabaseTimeLimit(safe.sql, DATABASE_TIME_LIMIT_MS))).catch((error: unknown) => {
          if (!isDatabaseTimeLimitError(error)) throw error
          throw new Error(`The database stopped this query at its ${DATABASE_TIME_LIMIT_MS}ms time limit. Narrow it with indexed filters such as org_id or a created_at range.`)
        })
        const capped = result.slice(0, MAX_ROW_LIMIT)
        return {
          rowCount: capped.length,
          ...(result.length > capped.length ? { truncated: true } : {}),
          rows: capped,
        }
      }),
  )

  // Sandbox organizations: the same functions as /v1/admin/sandbox-orgs and the /admin Sandbox page. Platform
  // evidence only, like those routes (creating one makes a new organization).
  const sandboxesOn = async () => {
    if (env.features.deployment !== "cloud") throw new Error("Sandbox organizations are only available on cloud deployments.")
  }
  const sandboxId = (value: string) => {
    if (!isDenTypeId("sandboxOrganization", value)) throw new Error("Invalid sandbox id (expected sbx_... from den_sandbox_list).")
    return normalizeDenTypeId("sandboxOrganization", value)
  }
  const found = <T>(sandbox: T | null) => {
    if (!sandbox) throw new Error("Sandbox not found.")
    return { ok: true, sandbox }
  }

  server.registerTool(
    "den_sandbox_list",
    {
      description: "List sandbox organizations (try-it-out Enterprise orgs for prospects): state, end date, seats, join link, connectors, and the model credit left on each sandbox's own OpenRouter key. Also returns what a new sandbox gets on this deployment.",
      inputSchema: z.object({}),
    },
    async () => run(async () => {
      await sandboxesOn()
      return { sandboxes: await listSandboxes(), defaults: sandboxDefaults() }
    }),
  )

  server.registerTool(
    "den_sandbox_create",
    {
      description: `Admin write tool: create a sandbox organization owned by you, on the Enterprise plan until it ends, with AI Gateway models for everyone (its own OpenRouter key capped at creditUsd when the deployment mints them), the fictional workplace connectors and a join link to send the prospect. Confirm name, seats, days and credit with the person first.`,
      inputSchema: z.object({
        name: z.string().trim().min(2).max(120).describe("Organization name, e.g. 'Trial sandbox'. Never include anything the prospect would consider confidential."),
        days: z.number().int().min(1).max(SANDBOX_MAX_DAYS).describe("How many days the sandbox stays open"),
        memberLimit: z.number().int().min(1).max(SANDBOX_MAX_MEMBERS).describe("Seats"),
        creditUsd: z.number().int().min(1).max(SANDBOX_MAX_CREDIT_USD).optional().describe("Model spending cap in US dollars; omitted uses the deployment default"),
        allowedEmailDomains: z.array(z.string()).max(20).optional().describe("Only people with these email domains can join; omitted means anyone with the link"),
        joinRole: z.enum(["member", "admin"]).optional().describe("What people who join become; default admin"),
        withConnectors: z.boolean().optional().describe("Add the fictional workplace connectors (default true)"),
      }),
    },
    async ({ name, days, memberLimit, creditUsd, allowedEmailDomains, joinRole, withConnectors }) =>
      writeScopeMissing("den_sandbox_create") ?? run(async () => {
        await sandboxesOn()
        const input = sandboxCreateInputSchema.safeParse({
          name, days, memberLimit, allowedEmailDomains: allowedEmailDomains ?? [], joinRole,
          connectorBaseUrl: withConnectors === false ? null : sandboxDefaults().workplaceUrl,
          ...(creditUsd === undefined ? {} : { creditUsd }),
        })
        if (!input.success) throw new Error(input.error.issues[0]?.message ?? "Invalid sandbox.")
        const admin = requireAdmin()
        const sandbox = await runPlatformAdminPlatformAction("sandbox_organization.create", admin, { type: "sandbox_organization", id: null }, () =>
          createSandbox(normalizeDenTypeId("user", admin.userId), input.data))
        return { ok: true, sandbox }
      }),
  )

  server.registerTool(
    "den_sandbox_extend",
    {
      description: "Admin write tool: add days to a sandbox (from now or its current end, whichever is later). Reopens a closed or ended sandbox: join link, Free Auto and its own model key come back on, and the Enterprise plan's end date moves.",
      inputSchema: z.object({ sandboxId: z.string().describe("sbx_... from den_sandbox_list"), days: z.number().int().min(1).max(SANDBOX_MAX_DAYS) }),
    },
    async ({ sandboxId: id, days }) =>
      writeScopeMissing("den_sandbox_extend") ?? run(async () => {
        await sandboxesOn()
        const target = sandboxId(id)
        return found(await runPlatformAdminPlatformAction("sandbox_organization.extend", requireAdmin(), { type: "sandbox_organization", id: target }, () => extendSandbox(target, days)))
      }),
  )

  server.registerTool(
    "den_sandbox_set_credit",
    {
      description: "Admin write tool: set the model spending cap, in US dollars, on a sandbox's own OpenRouter key. This is the new total, not an increment: to add $25 to a $50 sandbox, set 75.",
      inputSchema: z.object({ sandboxId: z.string().describe("sbx_... from den_sandbox_list"), creditUsd: z.number().int().min(1).max(SANDBOX_MAX_CREDIT_USD) }),
    },
    async ({ sandboxId: id, creditUsd }) =>
      writeScopeMissing("den_sandbox_set_credit") ?? run(async () => {
        await sandboxesOn()
        const target = sandboxId(id)
        return found(await runPlatformAdminPlatformAction("sandbox_organization.credit.set", requireAdmin(), { type: "sandbox_organization", id: target }, () => setSandboxCredit(target, creditUsd)))
      }),
  )

  server.registerTool(
    "den_sandbox_close",
    {
      description: "Admin write tool: close a sandbox now. Stops the join link, Free Auto and its own model key; the organization, members and their work are kept, and den_sandbox_extend reopens it.",
      inputSchema: z.object({ sandboxId: z.string().describe("sbx_... from den_sandbox_list") }),
    },
    async ({ sandboxId: id }) =>
      writeScopeMissing("den_sandbox_close") ?? run(async () => {
        await sandboxesOn()
        const target = sandboxId(id)
        return found(await runPlatformAdminPlatformAction("sandbox_organization.close", requireAdmin(), { type: "sandbox_organization", id: target }, () => closeSandbox(target)))
      }),
  )

}
