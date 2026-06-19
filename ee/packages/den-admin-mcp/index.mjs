#!/usr/bin/env node
// den-admin-mcp — read-only admin analytics MCP server for the OpenWork Den database.
//
// Tools: den_overview, den_growth, den_retention, den_company_users,
//        den_users_search, den_org_overview, den_query
//
// Config: DATABASE_URL (mysql://user:pass@host:3306/openwork_den).
// Only SELECT statements are ever issued. For defense in depth, point it at a
// read-only MySQL user. Activity definitions match den-api /v1/admin/overview:
// a user is "active" on a day if they have a sign-in session day or a
// `session.active` telemetry event that day.
//
// Register in OpenWork (opencode.json):
//   { "mcp": { "den-admin": { "type": "local",
//       "command": ["node", "/path/to/ee/packages/den-admin-mcp/index.mjs"],
//       "environment": { "DATABASE_URL": "mysql://..." }, "enabled": true } } }

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import mysql from "mysql2/promise";
import { z } from "zod";

const DEFAULT_ROW_LIMIT = Number(process.env.DEN_ADMIN_MCP_ROW_LIMIT || 200);

let pool = null;
function getPool() {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error(
        "DATABASE_URL is required (e.g. mysql://root:password@127.0.0.1:3306/openwork_den)",
      );
    }
    pool = mysql.createPool({ uri: url, connectionLimit: 4, dateStrings: true });
  }
  return pool;
}

async function rows(sqlText, params = []) {
  const [result] = await getPool().query(sqlText, params);
  return result;
}

const n = (value) => Number(value ?? 0);

function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(error) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

async function run(fn) {
  try {
    return ok(await fn());
  } catch (error) {
    return fail(error);
  }
}

function isMissingTable(error) {
  return error && typeof error === "object" && error.code === "ER_NO_SUCH_TABLE";
}

// --- activity (sign-in session days UNION session.active telemetry days) ---

async function activeUserCount(days) {
  const withTelemetry = `SELECT COUNT(DISTINCT uid) AS count FROM (
      SELECT s.user_id AS uid FROM session s
       WHERE s.updated_at >= DATE_SUB(NOW(), INTERVAL ${days} DAY)
      UNION
      SELECT m.user_id FROM telemetry_event t
        JOIN member m ON m.id = t.member_id
       WHERE m.user_id IS NOT NULL
         AND t.event_timestamp >= DATE_SUB(NOW(), INTERVAL ${days} DAY)
    ) activity`;
  try {
    return n((await rows(withTelemetry))[0]?.count);
  } catch (error) {
    if (!isMissingTable(error)) throw error;
    const sessionsOnly = `SELECT COUNT(DISTINCT user_id) AS count FROM session
       WHERE updated_at >= DATE_SUB(NOW(), INTERVAL ${days} DAY)`;
    return n((await rows(sessionsOnly))[0]?.count);
  }
}

// "Real" active users: executed at least one task in a session in the window
// (task.* telemetry with a session id), vs the looser sign-in/ping activity.
async function taskActiveUserCount(days) {
  try {
    const result = await rows(
      `SELECT COUNT(DISTINCT m.user_id) AS count FROM telemetry_event t
         JOIN member m ON m.id = t.member_id
        WHERE m.user_id IS NOT NULL
          AND t.event_type IN ('task.started', 'task.completed', 'task.failed')
          AND t.session_id IS NOT NULL
          AND t.event_timestamp >= DATE_SUB(NOW(), INTERVAL ${days} DAY)`,
    );
    return n(result[0]?.count);
  } catch (error) {
    if (!isMissingTable(error)) throw error;
    return 0;
  }
}

async function activityDays() {
  const withTelemetry = `SELECT s.user_id AS uid, DATE(s.updated_at) AS day FROM session s
      UNION
      SELECT m.user_id, DATE(t.event_timestamp) FROM telemetry_event t
        JOIN member m ON m.id = t.member_id
       WHERE m.user_id IS NOT NULL`;
  try {
    return await rows(withTelemetry);
  } catch (error) {
    if (!isMissingTable(error)) throw error;
    return rows(`SELECT user_id AS uid, DATE(updated_at) AS day FROM session GROUP BY uid, day`);
  }
}

async function lastActiveByUser(userIds) {
  const result = new Map();
  if (userIds.length === 0) return result;
  const merge = (userId, value) => {
    if (!value) return;
    const previous = result.get(userId);
    if (!previous || value > previous) result.set(userId, value);
  };
  const sessionRows = await rows(
    `SELECT user_id, MAX(updated_at) AS last FROM session WHERE user_id IN (?) GROUP BY user_id`,
    [userIds],
  );
  for (const row of sessionRows) merge(row.user_id, row.last);
  try {
    const telemetryRows = await rows(
      `SELECT m.user_id AS user_id, MAX(t.event_timestamp) AS last FROM telemetry_event t
         JOIN member m ON m.id = t.member_id
        WHERE m.user_id IN (?) GROUP BY m.user_id`,
      [userIds],
    );
    for (const row of telemetryRows) merge(row.user_id, row.last);
  } catch (error) {
    if (!isMissingTable(error)) throw error;
  }
  return result;
}

async function membershipsByUser(userIds) {
  const result = new Map();
  if (userIds.length === 0) return result;
  const memberRows = await rows(
    `SELECT m.user_id, m.role, o.name, o.slug FROM member m
       JOIN organization o ON o.id = m.organization_id
      WHERE m.user_id IN (?) AND m.removed_at IS NULL`,
    [userIds],
  );
  for (const row of memberRows) {
    const list = result.get(row.user_id) ?? [];
    list.push({ organization: row.name, slug: row.slug, role: row.role });
    result.set(row.user_id, list);
  }
  return result;
}

async function describeUsers(userRows) {
  const ids = userRows.map((row) => row.id);
  const [lastActive, memberships] = await Promise.all([
    lastActiveByUser(ids),
    membershipsByUser(ids),
  ]);
  return userRows.map((row) => ({
    name: row.name,
    email: row.email,
    signedUpAt: row.created_at,
    lastActiveAt: lastActive.get(row.id) ?? null,
    organizations: memberships.get(row.id) ?? [],
  }));
}

// --- read-only guard for den_query ---

const FORBIDDEN_SQL =
  /\b(insert|update|delete|drop|alter|create|truncate|rename|replace|grant|revoke|call|load|handler|lock|unlock|set|use|outfile|dumpfile|for\s+update)\b/i;

function assertReadOnly(input) {
  const sqlText = input.trim().replace(/;+\s*$/, "");
  if (sqlText.includes(";")) throw new Error("Only a single SQL statement is allowed");
  if (!/^(select|with|show|describe|explain)\b/i.test(sqlText)) {
    throw new Error("Only SELECT/WITH/SHOW/DESCRIBE/EXPLAIN statements are allowed");
  }
  if (FORBIDDEN_SQL.test(sqlText)) {
    throw new Error("Statement contains a forbidden keyword (read-only access)");
  }
  return sqlText;
}

// --- MCP server ---

// Keep in sync with package.json. The hosted admin MCP may expose additional
// admin-only write tools while this break-glass stdio variant remains read-only.
const DEN_ADMIN_MCP_VERSION = "0.4.0";

const server = new McpServer({ name: "den-admin", version: DEN_ADMIN_MCP_VERSION });

server.tool(
  "den_admin_version",
  "Report the den-admin MCP version and runtime so you can verify which build is running.",
  {},
  async () =>
    run(async () => ({
      name: "den-admin",
      transport: "stdio",
      toolsetVersion: DEN_ADMIN_MCP_VERSION,
      node: process.version,
    })),
);

server.tool(
  "den_overview",
  "High-level Den admin overview: total users/organizations/members, new users (7d/30d), active users (DAU/WAU/MAU), pending invitations, and subscriptions by status.",
  {},
  async () =>
    run(async () => {
      const [users, orgs, members, invitations, subscriptions, dau, wau, mau, realDau, realWau, realMau] =
        await Promise.all([
          rows(`SELECT COUNT(*) AS total,
                  SUM(created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)) AS new7d,
                  SUM(created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)) AS new30d
                FROM user`),
          rows(`SELECT COUNT(*) AS total FROM organization`),
          rows(`SELECT COUNT(*) AS total FROM member WHERE removed_at IS NULL`),
          rows(`SELECT COUNT(*) AS pending FROM invitation WHERE status = 'pending'`),
          rows(`SELECT type, status, COUNT(*) AS count FROM org_subscriptions GROUP BY type, status`),
          activeUserCount(1),
          activeUserCount(7),
          activeUserCount(30),
          taskActiveUserCount(1),
          taskActiveUserCount(7),
          taskActiveUserCount(30),
        ]);
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
      };
    }),
);

server.tool(
  "den_growth",
  "Signup growth series for users or organizations, bucketed by day/week/month, with period-over-period growth rates and cumulative totals.",
  {
    metric: z.enum(["users", "organizations"]).default("users").describe("What to count"),
    interval: z.enum(["day", "week", "month"]).default("week").describe("Bucket size"),
    periods: z.number().int().min(1).max(36).default(12).describe("How many periods back"),
  },
  async ({ metric, interval, periods }) =>
    run(async () => {
      const table = metric === "organizations" ? "organization" : "user";
      const format = { day: "%Y-%m-%d", week: "%x-W%v", month: "%Y-%m" }[interval];
      const unit = { day: "DAY", week: "WEEK", month: "MONTH" }[interval];
      const [series, before] = await Promise.all([
        rows(
          `SELECT DATE_FORMAT(created_at, ?) AS period, COUNT(*) AS count FROM ${table}
            WHERE created_at >= DATE_SUB(NOW(), INTERVAL ${periods} ${unit})
            GROUP BY period ORDER BY period`,
          [format],
        ),
        rows(
          `SELECT COUNT(*) AS count FROM ${table}
            WHERE created_at < DATE_SUB(NOW(), INTERVAL ${periods} ${unit})`,
        ),
      ]);
      let cumulative = n(before[0]?.count);
      let previous = null;
      const buckets = series.map((row) => {
        const count = n(row.count);
        cumulative += count;
        const growthPercent =
          previous === null || previous === 0
            ? null
            : Math.round(((count - previous) / previous) * 1000) / 10;
        previous = count;
        return { period: row.period, new: count, cumulative, growthPercent };
      });
      const complete = buckets.slice(0, -1);
      const latest = complete[complete.length - 1];
      return {
        metric,
        interval,
        startingTotal: n(before[0]?.count),
        buckets,
        latestCompletePeriod: latest ?? null,
        note: "last bucket is the current in-progress period; growthPercent compares new signups vs the previous bucket; periods with zero signups are omitted",
      };
    }),
);

server.tool(
  "den_retention",
  "Weekly cohort retention: users grouped by ISO signup week, with the percentage active in each week after signup (activity = sign-in session days + session.active telemetry).",
  {
    weeks: z.number().int().min(2).max(26).default(8).describe("How many signup-week cohorts"),
  },
  async ({ weeks }) =>
    run(async () => {
      const users = await rows(
        `SELECT id, DATE(created_at) AS day, DATE_FORMAT(created_at, '%x-W%v') AS week
           FROM user WHERE created_at >= DATE_SUB(NOW(), INTERVAL ${weeks} WEEK)`,
      );
      const activity = await activityDays();
      const DAY_MS = 86_400_000;
      const signupByUser = new Map(
        users.map((row) => [row.id, { week: row.week, time: Date.parse(row.day) }]),
      );
      const cohorts = new Map();
      for (const row of users) {
        const cohort = cohorts.get(row.week) ?? { size: 0, retained: new Map() };
        cohort.size += 1;
        cohorts.set(row.week, cohort);
      }
      for (const row of activity) {
        const signup = signupByUser.get(row.uid);
        if (!signup || !row.day) continue;
        const offset = Math.floor((Date.parse(row.day) - signup.time) / (7 * DAY_MS));
        if (offset < 0) continue;
        const cohort = cohorts.get(signup.week);
        const usersAtOffset = cohort.retained.get(offset) ?? new Set();
        usersAtOffset.add(row.uid);
        cohort.retained.set(offset, usersAtOffset);
      }
      const result = [...cohorts.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([week, cohort]) => {
          const byWeek = {};
          for (const [offset, retainedUsers] of [...cohort.retained.entries()].sort(
            (a, b) => a[0] - b[0],
          )) {
            byWeek[`week${offset}`] = {
              users: retainedUsers.size,
              percent: Math.round((retainedUsers.size / cohort.size) * 1000) / 10,
            };
          }
          return { cohort: week, signups: cohort.size, retention: byWeek };
        });
      return {
        cohorts: result,
        note: "week0 = signup week; weekN = active N weeks after signup",
      };
    }),
);

server.tool(
  "den_company_users",
  "Find users related to a company: matches organizations by name/slug/allowed email domains, and users by email domain. Returns members with role, signup date, and last activity.",
  {
    company: z.string().min(1).describe("Company name, org slug, or email domain (e.g. 'acme', 'acme.test')"),
    limit: z.number().int().min(1).max(200).default(50).describe("Max users per group"),
  },
  async ({ company, limit }) =>
    run(async () => {
      const query = company.includes("@") ? company.split("@").pop() : company;
      const like = `%${query}%`;
      const organizations = await rows(
        `SELECT id, name, slug, created_at FROM organization
          WHERE name LIKE ? OR slug LIKE ? OR allowed_email_domains LIKE ? LIMIT 10`,
        [like, like, like],
      );
      const orgResults = [];
      for (const org of organizations) {
        const memberRows = await rows(
          `SELECT u.id, u.name, u.email, u.created_at, m.role, m.joined_at FROM member m
             JOIN user u ON u.id = m.user_id
            WHERE m.organization_id = ? AND m.removed_at IS NULL
            ORDER BY m.joined_at LIMIT ${limit}`,
          [org.id],
        );
        const lastActive = await lastActiveByUser(memberRows.map((row) => row.id));
        orgResults.push({
          organization: org.name,
          slug: org.slug,
          createdAt: org.created_at,
          members: memberRows.map((row) => ({
            name: row.name,
            email: row.email,
            role: row.role,
            joinedAt: row.joined_at,
            lastActiveAt: lastActive.get(row.id) ?? null,
          })),
        });
      }
      const domainRows = await rows(
        `SELECT id, name, email, created_at FROM user
          WHERE email LIKE ? ORDER BY created_at DESC LIMIT ${limit}`,
        [`%@%${query}%`],
      );
      return {
        organizations: orgResults,
        usersByEmailDomain: await describeUsers(domainRows),
      };
    }),
);

server.tool(
  "den_users_search",
  "Search users by name or email substring. Returns signup date, last activity, and organization memberships.",
  {
    query: z.string().min(1).describe("Name or email substring"),
    limit: z.number().int().min(1).max(100).default(20),
  },
  async ({ query, limit }) =>
    run(async () => {
      const like = `%${query}%`;
      const userRows = await rows(
        `SELECT id, name, email, created_at FROM user
          WHERE email LIKE ? OR name LIKE ? ORDER BY created_at DESC LIMIT ${limit}`,
        [like, like],
      );
      return { users: await describeUsers(userRows) };
    }),
);

server.tool(
  "den_org_overview",
  "Deep dive on one organization (by slug or name): members by role, pending invitations, teams, subscriptions, and active members in the last 7/30 days.",
  {
    org: z.string().min(1).describe("Organization slug or name"),
  },
  async ({ org }) =>
    run(async () => {
      const matches = await rows(
        `SELECT id, name, slug, allowed_email_domains, created_at FROM organization
          WHERE slug = ? OR name LIKE ? LIMIT 1`,
        [org, `%${org}%`],
      );
      const found = matches[0];
      if (!found) throw new Error(`No organization matching "${org}"`);
      const [roleRows, invitations, teams, subscriptions, memberRows] = await Promise.all([
        rows(
          `SELECT role, COUNT(*) AS count FROM member
            WHERE organization_id = ? AND removed_at IS NULL GROUP BY role`,
          [found.id],
        ),
        rows(
          `SELECT email, role, status, created_at FROM invitation
            WHERE organization_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 50`,
          [found.id],
        ),
        rows(`SELECT COUNT(*) AS count FROM team WHERE organization_id = ?`, [found.id]),
        rows(
          `SELECT type, status, quantity, current_period_end FROM org_subscriptions
            WHERE organization_id = ?`,
          [found.id],
        ),
        rows(
          `SELECT u.id, u.name, u.email, u.created_at, m.role FROM member m
             JOIN user u ON u.id = m.user_id
            WHERE m.organization_id = ? AND m.removed_at IS NULL LIMIT 100`,
          [found.id],
        ),
      ]);
      const lastActive = await lastActiveByUser(memberRows.map((row) => row.id));
      const activeSince = (days) => {
        const cutoff = Date.now() - days * 86_400_000;
        return memberRows.filter((row) => {
          const last = lastActive.get(row.id);
          return last && Date.parse(last) >= cutoff;
        }).length;
      };
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
          lastActiveAt: lastActive.get(row.id) ?? null,
        })),
      };
    }),
);

server.tool(
  "den_query",
  "Escape hatch: run a single read-only SQL statement (SELECT/WITH/SHOW/DESCRIBE/EXPLAIN) against the Den database. Useful tables: user, session, organization, member, invitation, team, org_subscriptions, telemetry_event, worker, audit_event. Avoid encrypted columns (scim_provider.scim_token, sso_provider.*_config, llm_provider.api_key, config_object_version payloads, inference upstream keys).",
  {
    sql: z.string().min(1).describe("A single read-only SQL statement"),
    limit: z.number().int().min(1).max(1000).optional().describe("Row limit appended when the query has none"),
  },
  async ({ sql: sqlText, limit }) =>
    run(async () => {
      let safe = assertReadOnly(sqlText);
      if (/^(select|with)\b/i.test(safe) && !/\blimit\s+\d+/i.test(safe)) {
        safe += ` LIMIT ${limit ?? DEFAULT_ROW_LIMIT}`;
      }
      const result = await rows(safe);
      return { rowCount: result.length, rows: result };
    }),
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[den-admin-mcp] ready (stdio), read-only analytics for Den");
}

main().catch((error) => {
  console.error("[den-admin-mcp] fatal:", error);
  process.exit(1);
});
