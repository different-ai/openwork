import { denFetch } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import type { Seed } from "@openwork/env";
import { isRecord } from "./library.ts";
import { seededOrganizationId } from "./organization-capabilities.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Usage activity on specific past days, sent through the app's own telemetry ingest. */
const ACTIVITY: { daysAgo: number; member: "admin" | "peer"; sessions: number; tasks: number; failed: number }[] = [
  { daysAgo: 0, member: "admin", sessions: 3, tasks: 4, failed: 0 },
  { daysAgo: 0, member: "peer", sessions: 2, tasks: 2, failed: 1 },
  { daysAgo: 1, member: "admin", sessions: 5, tasks: 6, failed: 1 },
  { daysAgo: 2, member: "peer", sessions: 1, tasks: 1, failed: 0 },
  { daysAgo: 4, member: "admin", sessions: 6, tasks: 8, failed: 0 },
  { daysAgo: 4, member: "peer", sessions: 4, tasks: 3, failed: 0 },
  { daysAgo: 7, member: "admin", sessions: 2, tasks: 2, failed: 0 },
  { daysAgo: 11, member: "peer", sessions: 3, tasks: 4, failed: 1 },
  { daysAgo: 15, member: "admin", sessions: 4, tasks: 5, failed: 0 },
  { daysAgo: 22, member: "admin", sessions: 1, tasks: 1, failed: 0 },
];

/** A private Den whose organization has usage on known days, with daily trends available by default. */
export async function analyticsDailyTrends(seed: Seed) {
  const den = await seed.den({
    org: { name: "Usage studio", admin: { name: "Analytics Owner" }, members: { peer: { name: "Analytics Teammate" } } },
  });
  const organizationId = await seededOrganizationId(seed, den.admin);
  if (!organizationId) throw new Error("The analytics fixture has no organization.");
  // Midday UTC on each day keeps every event inside its own UTC calendar day.
  const todayNoon = new Date();
  todayNoon.setUTCHours(12, 0, 0, 0);
  const at = (daysAgo: number, minute: number) => {
    const base = todayNoon.getTime() - daysAgo * DAY_MS;
    return new Date(Math.min(base + minute * 60_000, Date.now() - 60_000)).toISOString();
  };
  for (const [index, row] of ACTIVITY.entries()) {
    const session: DenSession = row.member === "admin" ? den.admin : den.members.peer;
    const events = Array.from({ length: row.sessions }, (_, s) => {
      const sessionId = `daily-${index}-${s}`;
      const outcomes = Array.from({ length: s === 0 ? row.tasks : 0 }, (_, t) => ({
        type: t < row.failed ? "task.failed" : "task.completed", timestamp: at(row.daysAgo, s + t + 1), source: "app", sessionId, durationMs: 40_000,
      }));
      return [{ type: "session.active", timestamp: at(row.daysAgo, s), source: "app", sessionId }, ...outcomes];
    }).flat();
    const sent = await seed.api(session, "/v1/telemetry/ingest", { method: "POST", body: JSON.stringify({ events }) });
    if (sent.response.status !== 204) throw new Error(`Sending usage events failed: ${sent.text}`);
  }

  const web = await seed.web({
    den, signedInAs: den.admin, startPath: "/dashboard/analytics",
    headless: true, viewport: { width: 1440, height: 1200 },
  });

  return {
    den, web,
    /** Sessions the fixture sent for today (UTC). */
    expectedTodaySessions: ACTIVITY.filter((row) => row.daysAgo === 0).reduce((sum, row) => sum + row.sessions, 0),
    async analytics() {
      const result = await denFetch(den.admin, "/v1/telemetry/analytics", { headers: { authorization: `Bearer ${den.admin.token}` } });
      if (!result.response.ok || !isRecord(result.body)) throw new Error(`Reading analytics failed: ${result.text}`);
      const daily = Array.isArray(result.body.daily) ? result.body.daily.filter(isRecord) : null;
      const weekly = Array.isArray(result.body.weekly) ? result.body.weekly.filter(isRecord) : [];
      return { daily, weekly };
    },
  };
}
