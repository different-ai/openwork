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
  await turnOn(acmeId, ["automationCalendarTriggers", "automationIntervalSchedules", "workbotProactive", "slackSendAsBot", "mermaidZoom"]);
  await turnOn(northwindId, ["automationCalendarTriggers", "slackSendAsBot"]);

  // Automations: inactive, so the scheduler leaves them alone; their runs are what /admin reads.
  // Times are UTC wall-clock, the way Den writes timestamps.
  let next = 1;
  const automation = async (organizationId: string, memberId: string, kind: "calendar" | "interval") => {
    const automationId = id("atm", next);
    const revisionId = id("atv", next);
    next += 1;
    const schedule = kind === "calendar"
      ? { kind: "calendar", timezone: "UTC", edge: "end", offsetMinutes: 5, rule: { withExternalAttendees: true } }
      : { kind: "interval", timezone: "UTC", everyHours: 3, daysOfWeek: [1, 2, 3, 4, 5], startHour: 9, endHour: 18 };
    await sql("INSERT INTO automation (id, organization_id, owner_member_id, name, state, current_revision_id) VALUES (?, ?, ?, ?, 'inactive', ?)", [automationId, organizationId, memberId, `${kind} fixture`, revisionId]);
    await sql("INSERT INTO automation_revision (id, automation_id, version, instructions, schedule_kind, schedule_config, timezone, provider_id, model_id, execution_target, maximum_runtime_ms, digest) VALUES (?, ?, 1, 'fixture', ?, ?, 'UTC', 'openwork', 'fixture-model', 'cloud', 600000, ?)",
      [revisionId, automationId, kind, JSON.stringify(schedule), `fixture-${revisionId}`]);
    return { automationId, revisionId };
  };
  let runs = 1;
  const run = async (target: { automationId: string; revisionId: string }, status: string, hoursAgo: number, code: string | null = null) => {
    const runId = id("atr", runs);
    const threadId = id("ath", runs);
    runs += 1;
    await sql(
      "INSERT INTO automation_run (id, automation_id, revision_id, `trigger`, idempotency_key, status, execution_target, cloud_thread_id, provider_id, model_id, error, `usage`, created_at, updated_at) VALUES (?, ?, ?, 'scheduled', ?, ?, 'cloud', ?, 'openwork', 'fixture-model', ?, ?, DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? HOUR), DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? HOUR))",
      [runId, target.automationId, target.revisionId, `fixture:${runId}`, status, threadId, code ? JSON.stringify({ code, message: "Fixture reason.", retryable: false }) : null, JSON.stringify({ inputTokens: null, outputTokens: null, costMicros: null }), hoursAgo, hoursAgo],
    );
  };
  const acmeCalendar = await automation(acmeId, acmeMember.id, "calendar");
  const northwindCalendar = await automation(northwindId, northwindOwner.id, "calendar");
  const acmeInterval = await automation(acmeId, acmeOwner.id, "interval");
  await run(acmeCalendar, "succeeded", 26);
  for (const hours of [1, 2, 27, 50, 51]) await run(acmeCalendar, "skipped", hours, "execution_runtime_unavailable");
  for (const hours of [74, 98, 122]) await run(acmeCalendar, "skipped", hours, "model_access_lost");
  await run(acmeCalendar, "failed", 75, "execution_failed");
  await run(acmeCalendar, "succeeded", 20 * 24);
  for (const hours of [3, 28, 52, 100]) await run(northwindCalendar, "succeeded", hours);
  for (let day = 0; day < 6; day += 1) for (const hour of [1, 4, 7]) await run(acmeInterval, "succeeded", day * 24 + hour);
  await run(acmeInterval, "failed", 3 * 24 + 2, "execution_timed_out");

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

  // Who used what (feature_usage): this week, and one Northwind use three weeks ago.
  const use = async (organizationId: string, memberId: string, key: string, hoursAgo: number) => {
    await sql("INSERT INTO feature_usage (member_id, feature_key, organization_id, first_used_at, days_used, last_used_at, last_used_day) VALUES (?, ?, ?, DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? HOUR), 1, DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? HOUR), DATE_FORMAT(DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? HOUR), '%Y-%m-%d'))", [memberId, key, organizationId, hoursAgo, hoursAgo, hoursAgo]);
  };
  for (const key of ["automationCalendarTriggers", "workbotProactive", "slackSendAsBot", "mermaidZoom"]) await use(acmeId, acmeMember.id, key, 2);
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
