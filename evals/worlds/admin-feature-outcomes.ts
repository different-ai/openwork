import { queryDenDatabase, type Seed } from "@openwork/env";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const id = (prefix: string, index: number) => `${prefix}_${String(index).padStart(26, "0")}`;

/**
 * Two fictional organizations whose background features already ran, written the way the product writes them:
 * automation runs (calendar and every-few-hours), Your agent's counters and check records, slack_send_as_bot's
 * daily windows in rate_limit, and recorded feature use. Only setup; the proof reads /admin.
 */
export async function adminFeatureOutcomesWorld(seed: Seed) {
  const den = await seed.den({
    web: true,
    org: {
      name: "Acme Robotics",
      admin: { name: "Sam Rivera" },
      members: { member: { name: "Alex Chen" } },
    },
  });
  const databaseUrl = den.database?.url;
  if (!databaseUrl || !new URL(databaseUrl).pathname.startsWith("/openwork_eval_")) throw new Error("Outcome fixtures require a disposable testkit database.");
  const sql = (statement: string, values: ReadonlyArray<string | number | null> = []) => queryDenDatabase(databaseUrl, statement, values);

  const initial = await seed.api(den.admin, "/v1/org");
  if (!isRecord(initial.body) || !isRecord(initial.body.organization) || typeof initial.body.organization.id !== "string") throw new Error("Expected the seeded organization.");
  const acmeId = initial.body.organization.id;
  const created = await seed.api(den.admin, "/v1/org", { method: "POST", body: JSON.stringify({ name: "Northwind Labs" }) });
  if (!isRecord(created.body) || !isRecord(created.body.organization) || typeof created.body.organization.id !== "string") throw new Error("Expected Northwind Labs.");
  const northwindId = created.body.organization.id;

  const members = async (organizationId: string) => {
    const rows = await sql("SELECT m.id, m.user_id, u.email FROM member m JOIN `user` u ON u.id = m.user_id WHERE m.organization_id = ? AND m.removed_at IS NULL", [organizationId]);
    return rows.flatMap((row) => isRecord(row) && typeof row.id === "string" && typeof row.user_id === "string" && typeof row.email === "string" ? [{ id: row.id, userId: row.user_id, email: row.email }] : []);
  };
  const acmeMembers = await members(acmeId);
  const acmeOwner = acmeMembers.find((row) => row.email === den.admin.email);
  const acmeMember = acmeMembers.find((row) => row.email !== den.admin.email);
  const [northwindOwner] = await members(northwindId);
  if (!acmeOwner || !acmeMember || !northwindOwner) throw new Error("Expected the fixture members.");

  const turnOn = async (organizationId: string, keys: string[]) => {
    const set = await seed.api(den.admin, `/v1/admin/organizations/${organizationId}/capabilities`, {
      method: "PUT", body: JSON.stringify({ capabilities: Object.fromEntries(keys.map((key) => [key, true])) }),
    });
    if (!set.response.ok) throw new Error(`Could not turn features on (${set.response.status}).`);
  };
  // Your agent is the remaining background outcome feature; the schedule-trigger outcome features are retired (GA).
  await turnOn(acmeId, ["workbotProactive", "settledSessions"]);

  // Your agent: daily counters for every member, and one member's check records.
  await sql("INSERT INTO agent_instance (member_id, organization_id, next_wake_at) VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 30 DAY))", [acmeMember.id, acmeId]);
  for (let day = 0; day < 7; day += 1) {
    await sql("INSERT INTO agent_check (organization_id, day, responsibility, checks, quiet, sent) VALUES (?, DATE_FORMAT(DATE_SUB(UTC_DATE(), INTERVAL ? DAY), '%Y-%m-%d'), 'meeting_prep', ?, ?, ?)", [acmeId, day, 6 + (day % 3), 5 + (day % 3), 1]);
    await sql("INSERT INTO agent_check (organization_id, day, responsibility, checks, quiet, sent) VALUES (?, DATE_FORMAT(DATE_SUB(UTC_DATE(), INTERVAL ? DAY), '%Y-%m-%d'), 'waiting_on_you', 6, 6, 0)", [acmeId, day]);
  }
  for (const [index, hours] of [[1, 5], [2, 30]]) {
    await sql("INSERT INTO agent_member_check (id, organization_id, member_id, checked_at, kind, outcome, reason, summary) VALUES (?, ?, ?, DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? HOUR), 'scheduled', 'failed', 'google_disconnected', 'Fixture sentence.')", [`fixture-check-${index}`, acmeId, acmeMember.id, hours]);
  }

  // slack_send_as_bot: Alex reached the daily limit today and Slack refused 2 of 20; Northwind sent 4.
  const nowMs = Date.now();
  const windowStart = nowMs - 5 * 3_600_000;
  let limits = 1;
  const limit = async (key: string, count: number, lastRequest: number) => {
    await sql("INSERT INTO rate_limit (id, `key`, count, last_request) VALUES (?, ?, ?, ?)", [id("rli", limits), key, count, lastRequest]);
    limits += 1;
  };
  await limit(`slack-send-as-bot:day:${acmeId}:${acmeMember.userId}`, 20, windowStart);
  for (let index = 0; index < 18; index += 1) await limit(`slack-send-as-bot:same:${acmeId}:${acmeMember.userId}:fixture${index}`, 1, windowStart + index * 60_000);
  await limit(`slack-send-as-bot:day:${northwindId}:${northwindOwner.userId}`, 4, windowStart);
  for (let index = 0; index < 4; index += 1) await limit(`slack-send-as-bot:same:${northwindId}:${northwindOwner.userId}:fixture${index}`, 1, windowStart + index * 60_000);

  // Historical GA usage rows remain stored, but retired keys no longer appear as rollout reports.
  // Who used what (feature_usage): this week, and one Northwind use three weeks ago.
  const use = async (organizationId: string, memberId: string, key: string, hoursAgo: number) => {
    await sql("INSERT INTO feature_usage (member_id, feature_key, organization_id, first_used_at, days_used, last_used_at, last_used_day) VALUES (?, ?, ?, DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? HOUR), 1, DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? HOUR), DATE_FORMAT(DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? HOUR), '%Y-%m-%d'))", [memberId, key, organizationId, hoursAgo, hoursAgo, hoursAgo]);
  };
  for (const key of ["automationCalendarTriggers", "workbotProactive", "settledSessions"]) await use(acmeId, acmeMember.id, key, 2);
  await use(acmeId, acmeOwner.id, "automationIntervalSchedules", 1);
  await use(northwindId, northwindOwner.id, "slackSendAsBot", 4);
  await use(northwindId, northwindOwner.id, "automationCalendarTriggers", 20 * 24);

  const viewport = { width: 1440, height: 1000 };
  const admin = await seed.web({ den, signedInAs: den.admin, startPath: "/admin/feature-usage", headless: true, viewport });
  const member = await seed.web({ den, signedInAs: den.members.member, startPath: "/admin/feature-usage", headless: true, viewport });
  return {
    admin,
    member,
    acmeId,
    northwindId,
    url: (path: string) => new URL(path, den.ref.webUrl).toString(),
    async memberRead() {
      return (await seed.api(den.members.member, "/v1/admin/feature-usage")).response.status;
    },
  };
}
