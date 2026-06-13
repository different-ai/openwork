import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { eq, sql, type SQL } from "@openwork-ee/den-db/drizzle"
import { OrganizationTable } from "@openwork-ee/den-db/schema"
import { z } from "zod"
import { db } from "../db.js"
import { parseOrganizationPlan, type PlanTier } from "../entitlements.js"
import { normalizeOrganizationMetadata } from "../organization-limits.js"
import { denApiAppVersion } from "../version.js"

/**
 * den-admin MCP toolset: read-only Den analytics for allowlisted platform
 * admins, served over streamable HTTP at /mcp/admin (see ./admin.ts).
 *
 * This is the server-hosted successor of ee/packages/den-admin-mcp (the
 * stdio break-glass variant that talks straight to MySQL). Tool names and
 * payloads are kept compatible; bump DEN_ADMIN_MCP_VERSION when they change
 * so `den_admin_version` can be used to spot stale deploys.
 *
 * Hardening: every statement goes through the shared read-only guard, raw
 * `den_query` results are row-capped, and all queries race a wall-clock
 * timeout so one expensive SELECT cannot pin an API worker indefinitely.
 */

export const DEN_ADMIN_MCP_VERSION = "0.4.0"

const QUERY_TIMEOUT_MS = 15_000
const DEFAULT_ROW_LIMIT = 200
const MAX_ROW_LIMIT = 1000

const SERVER_STARTED_AT = new Date().toISOString()

type Row = Record<string, unknown>
type OrganizationId = typeof OrganizationTable.$inferSelect.id

/**
 * `db` is drizzle over either mysql2 (returns `[rows, fields]`) or
 * PlanetScale serverless (returns `{ rows }`). Normalize both shapes.
 */
export function normalizeRows(result: unknown): Row[] {
  if (Array.isArray(result)) {
    const first: unknown = result[0]
    if (Array.isArray(first)) {
      return first as Row[]
    }
    return result as Row[]
  }
  if (typeof result === "object" && result !== null && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: Row[] }).rows
  }
  return []
}

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

function manualPlan(tier: PlanTier) {
  return {
    tier,
    source: "manual" as const,
    ...(tier === "enterprise" ? { grantedAt: new Date().toISOString() } : {}),
  }
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

/**
 * "Real" active users: executed at least one task in a session in the
 * window — task.* telemetry with a session id, not just sign-ins or
 * heartbeat pings. Returns 0 when the telemetry table is missing.
 */
async function taskActiveUserCount(days: number): Promise<number> {
  const interval = intLiteral(days)
  try {
    const result = await rows(sql`SELECT COUNT(DISTINCT m.user_id) AS count FROM telemetry_event t
        JOIN member m ON m.id = t.member_id
       WHERE m.user_id IS NOT NULL
         AND t.event_type IN ('task.started', 'task.completed', 'task.failed')
         AND t.session_id IS NOT NULL
         AND t.event_timestamp >= DATE_SUB(NOW(), INTERVAL ${interval} DAY)`)
    return n(result[0]?.count)
  } catch (error) {
    if (!isMissingTable(error)) throw error
    return 0
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

// --- read-only guard for den_query ---

const FORBIDDEN_SQL =
  /\b(insert|update|delete|drop|alter|create|truncate|rename|replace|grant|revoke|call|load|handler|lock|unlock|set|use|outfile|dumpfile|for\s+update)\b/i

export function assertReadOnlySql(input: string): string {
  const sqlText = input.trim().replace(/;+\s*$/, "")
  if (sqlText.includes(";")) throw new Error("Only a single SQL statement is allowed")
  if (!/^(select|with|show|describe|explain)\b/i.test(sqlText)) {
    throw new Error("Only SELECT/WITH/SHOW/DESCRIBE/EXPLAIN statements are allowed")
  }
  if (FORBIDDEN_SQL.test(sqlText)) {
    throw new Error("Statement contains a forbidden keyword (read-only access)")
  }
  return sqlText
}

/** Append a LIMIT to bare SELECT/WITH statements and clamp the cap. */
export function applyDefaultRowLimit(sqlText: string, limit?: number): { sql: string; cap: number } {
  const cap = Math.max(1, Math.min(limit ?? DEFAULT_ROW_LIMIT, MAX_ROW_LIMIT))
  if (/^(select|with)\b/i.test(sqlText) && !/\blimit\s+\d+/i.test(sqlText)) {
    return { sql: `${sqlText} LIMIT ${cap}`, cap }
  }
  return { sql: sqlText, cap }
}

export function buildAdminMcpVersionInfo() {
  return {
    name: "den-admin",
    transport: "streamable-http",
    toolsetVersion: DEN_ADMIN_MCP_VERSION,
    denApi: denApiAppVersion,
    node: process.version,
    serverStartedAt: SERVER_STARTED_AT,
  }
}

// --- tool registration ---

export function registerAdminMcpTools(server: McpServer) {
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
        const [users, orgs, members, invitations, subscriptions, dau, wau, mau, realDau, realWau, realMau] = await Promise.all([
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
          taskActiveUserCount(1),
          taskActiveUserCount(7),
          taskActiveUserCount(30),
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
          realActiveUsers: { daily: realDau, weekly: realWau, monthly: realMau },
          subscriptions: subscriptions.map((row) => ({
            type: row.type,
            status: row.status,
            count: n(row.count),
          })),
          note: "active = sign-in session day or any telemetry event; realActive = executed at least one task in a session (task.* events with a session id)",
        }
      }),
  )

  server.registerTool(
    "den_update_org_plan",
    {
      description:
        "Admin write tool: grant or remove organization plan access and set the member seat limit. Use tier='enterprise' to grant enterprise access.",
      inputSchema: z.object({
        organizationId: z.string().min(1).describe("Organization id, e.g. org_..."),
        tier: z.enum(["free", "team", "enterprise"]).describe("Plan tier to set"),
        seatLimit: z.number().int().min(1).max(100000).describe("Maximum active organization members/seats"),
      }),
    },
    async ({ organizationId, tier, seatLimit }) =>
      run(async () => {
        if (!isOrganizationId(organizationId)) {
          throw new Error("Invalid organization id")
        }

        const existing = await db
          .select({ id: OrganizationTable.id, name: OrganizationTable.name, slug: OrganizationTable.slug, metadata: OrganizationTable.metadata })
          .from(OrganizationTable)
          .where(eq(OrganizationTable.id, organizationId))
          .limit(1)

        const organization = existing[0]
        if (!organization) {
          throw new Error(`No organization found for ${organizationId}`)
        }

        const normalized = normalizeOrganizationMetadata(organization.metadata).metadata
        const metadata = {
          ...normalized,
          plan: manualPlan(tier),
          limits: {
            ...normalized.limits,
            members: seatLimit,
          },
        }

        await db
          .update(OrganizationTable)
          .set({ metadata })
          .where(eq(OrganizationTable.id, organizationId))

        return {
          ok: true,
          organization: {
            id: organization.id,
            name: organization.name,
            slug: organization.slug,
            plan: parseOrganizationPlan(metadata),
            seatLimit,
          },
        }
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
        const WEEK_MS = 7 * 86_400_000
        const signupByUser = new Map<string, { week: string; time: number }>()
        for (const row of users) {
          const time = toTime(row.day)
          if (typeof row.id !== "string" || typeof row.week !== "string" || time === null) continue
          signupByUser.set(row.id, { week: row.week, time })
        }
        const cohorts = new Map<string, { size: number; retained: Map<number, Set<string>> }>()
        for (const signup of signupByUser.values()) {
          const cohort = cohorts.get(signup.week) ?? { size: 0, retained: new Map() }
          cohort.size += 1
          cohorts.set(signup.week, cohort)
        }
        for (const row of activity) {
          if (typeof row.uid !== "string") continue
          const signup = signupByUser.get(row.uid)
          const dayTime = toTime(row.day)
          if (!signup || dayTime === null) continue
          const offset = Math.floor((dayTime - signup.time) / WEEK_MS)
          if (offset < 0) continue
          const cohort = cohorts.get(signup.week)
          if (!cohort) continue
          const usersAtOffset = cohort.retained.get(offset) ?? new Set<string>()
          usersAtOffset.add(row.uid)
          cohort.retained.set(offset, usersAtOffset)
        }
        const result = [...cohorts.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([week, cohort]) => {
            const byWeek: Record<string, { users: number; percent: number }> = {}
            for (const [offset, retainedUsers] of [...cohort.retained.entries()].sort((a, b) => a[0] - b[0])) {
              byWeek[`week${offset}`] = {
                users: retainedUsers.size,
                percent: Math.round((retainedUsers.size / cohort.size) * 1000) / 10,
              }
            }
            return { cohort: week, signups: cohort.size, retention: byWeek }
          })
        return {
          cohorts: result,
          note: "week0 = signup week; weekN = active N weeks after signup",
        }
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
        "Escape hatch: run a single read-only SQL statement (SELECT/WITH/SHOW/DESCRIBE/EXPLAIN) against the Den database. Useful tables: user, session, organization, member, invitation, team, org_subscriptions, telemetry_event, worker, audit_event. Avoid encrypted columns (scim_provider.scim_token, sso_provider.*_config, llm_provider.api_key, config_object_version payloads, inference upstream keys).",
      inputSchema: z.object({
        sql: z.string().min(1).describe("A single read-only SQL statement"),
        limit: z.number().int().min(1).max(MAX_ROW_LIMIT).optional().describe("Row limit appended when the query has none"),
      }),
    },
    async ({ sql: sqlText, limit }) =>
      run(async () => {
        const safe = applyDefaultRowLimit(assertReadOnlySql(sqlText), limit)
        const result = await rows(sql.raw(safe.sql))
        const capped = result.slice(0, MAX_ROW_LIMIT)
        return {
          rowCount: capped.length,
          ...(result.length > capped.length ? { truncated: true } : {}),
          rows: capped,
        }
      }),
  )
}
