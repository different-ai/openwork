import assert from "node:assert/strict"
import { test } from "node:test"
import type { SQL } from "@openwork-ee/den-db/drizzle"
import {
  buildWorkbotAdoptionQueries,
  readWorkbotAdoptionReport,
  workbotAdoptionInputSchema,
} from "../src/workbot/adoption-report.js"

type Row = Record<string, unknown>
const input = { startDate: "2026-10-01", endDate: "2026-10-18" }
const seconds = Date.parse("2026-10-01T00:00:00.000Z") / 1000

function member(memberId: string, extra: Row = {}): Row {
  return {
    org_id: "org_a",
    member_id: memberId,
    signed_in_seconds: String(seconds),
    greeting_started_seconds: null,
    greeting_completed_seconds: null,
    first_message_seconds: null,
    first_message_after_greeting_seconds: null,
    connected_seconds: null,
    ready_probe_observed: 0,
    greeting_failure_count: 0,
    ...extra,
  }
}

function fixtureQuery(aggregates: Row[] = [], members: Row[] = [], failures: Row[] = [], models: Row[] = []) {
  let calls = 0
  return {
    query: async (_query: SQL) => {
      const rows = [aggregates, members, failures, models][calls]
      calls += 1
      assert.ok(rows, "the report uses exactly four bounded read queries")
      return rows
    },
    calls: () => calls,
  }
}

test("cohort dates are real UTC dates, inclusive and limited to 90 days", () => {
  assert.equal(workbotAdoptionInputSchema.safeParse({ startDate: "2026-01-01", endDate: "2026-03-31" }).success, true)
  assert.equal(workbotAdoptionInputSchema.safeParse({ startDate: "2026-01-01", endDate: "2026-04-01" }).success, false)
  for (const invalid of [
    { startDate: "2026-02-29", endDate: "2026-03-01" },
    { startDate: "2026-02-30", endDate: "2026-03-01" },
    { startDate: "2026-10-19", endDate: "2026-10-18" },
    { startDate: "2026-10-01T00:00:00Z", endDate: "2026-10-18" },
    { ...input, organizationId: "an-organization-name" },
    { ...input, limit: 501 },
    { ...input, offset: 100_001 },
    { ...input, offset: -1 },
  ]) {
    assert.equal(workbotAdoptionInputSchema.safeParse(invalid).success, false)
  }
  assert.equal(workbotAdoptionInputSchema.safeParse({ startDate: "2028-02-29", endDate: "2028-02-29" }).success, true)
})

test("queries keep cohort identity, event chronology and dimension identity scoped without reading user content", () => {
  const queries = buildWorkbotAdoptionQueries({ ...input, organizationId: "org_a", limit: 2, offset: 3 })
  // SQL chunks retain bound parameters, so checking them does not require a DB
  // connection or constructing a client against an inherited DATABASE_URL.
  for (const query of [queries.aggregates, queries.members, queries.failures, queries.models]) {
    const chunks = JSON.stringify(query)
    assert.match(chunks, /prior\.org_id = s\.org_id AND prior\.member_id = s\.member_id/)
    assert.match(chunks, /prior\.source = 'workbot' AND prior\.event_type = 'workbot\.signed_in'/)
    assert.match(chunks, /AND s\.org_id = /)
    assert.match(chunks, /org_a/)
    assert.match(chunks, /t\.org_id = c\.org_id AND t\.member_id = c\.member_id AND t\.source = 'workbot'/)
    assert.match(chunks, /t\.event_timestamp >= FROM_UNIXTIME\(c\.signed_in_seconds\)/)
    assert.match(chunks, /d\.org_id = t\.org_id AND d\.source = t\.source AND d\.session_id = t\.session_id/)
    assert.doesNotMatch(chunks, /\b(?:user|member|workbot_message|workbot_session|organization)\s+(?:JOIN|WHERE)|(?:name|email|content|body|title|dimension_label)\b/i)
  }
  const facts = JSON.stringify(queries.aggregates)
  assert.match(facts, /t\.event_timestamp >= FROM_UNIXTIME\(c\.greeting_completed_seconds\)/)
  assert.match(facts, /first_message_after_greeting_seconds IS NOT NULL AND connected_seconds IS NOT NULL/)
  assert.match(facts, /JSON_TYPE\(JSON_EXTRACT\(d\.metadata, '\$\.ready_count'\)\) = 'INTEGER'/)
  assert.match(facts, /JSON_EXTRACT\(d\.metadata, '\$\.ready_count'\) > 0/)
  assert.match(facts, /DATE_ADD\('1970-01-01', INTERVAL signed_in_seconds SECOND\)/)
  assert.match(facts, /1001/)
  assert.match(JSON.stringify(queries.members), /LIMIT .*3.*OFFSET .*3/)
  assert.match(JSON.stringify(queries.failures), /md\.org_id = t\.org_id AND md\.source = t\.source AND md\.session_id = t\.session_id/)
  assert.match(JSON.stringify(queries.failures), /md\.dimension_type = 'model'/)
  assert.match(facts, /t\.event_timestamp = FROM_UNIXTIME\(c\.signed_in_seconds\)/)
  assert.match(facts, /AS ready_count_at_sign_in/)
  assert.match(facts, /t\.event_type = 'workbot.greeting_started'.*ready_count_at_greeting/s)
  assert.match(facts, /t\.event_type = 'connection.connected' THEN 1 ELSE 0 END\) AS connection_count/)
  const models = JSON.stringify(queries.models)
  assert.match(models, /t\.event_type IN \('workbot.greeting_completed', 'workbot.turn_completed'\)/)
  assert.match(models, /WHEN 'response' THEN 'response' WHEN 'configured' THEN 'configured'/)
  assert.match(models, /ELSE 'unknown' END AS model_source/)
  assert.match(models, /PARTITION BY org_id, member_id/)
  assert.match(models, /model_rank <= .*11/)
  assert.match(models, /LIMIT .*22/)
})

test("full-cohort funnel totals and daily/org summaries do not change with a member page", async () => {
  const totals = {
    signed_in: "10", greeting_completed: "7", first_message_sent: "5", connected: "3",
    greeting_started: "8", message_observed: "6", connection_observed: "8",
    greeting_failed_attempts: "4", greeting_failed_members: "1", greeting_never_started: "1",
    greeting_without_outcome: "1", connection_unknown: "1", connection_zero_observed: "1",
  }
  const fixture = fixtureQuery([
    { ...totals, bucket_type: "total", bucket: "" },
    { ...totals, bucket_type: "day", bucket: "2026-10-01" },
    { ...totals, bucket_type: "organization", bucket: "org_a" },
  ], [member("mem_a"), member("mem_b")])
  const report = await readWorkbotAdoptionReport({ ...input, limit: 1 }, fixture.query)
  assert.equal(fixture.calls(), 4)
  assert.equal(report.scope, "full_cohort")
  assert.deepEqual(report.funnel, { signedIn: 10, greetingCompleted: 7, firstMessageSent: 5, atLeastOneConnected: 3 })
  assert.deepEqual(report.daily[0]?.funnel, report.funnel)
  assert.deepEqual(report.organizations.rows[0]?.funnel, report.funnel)
  assert.equal(report.observed.messageSent, 6, "observed messages need not follow the greeting; the funnel does")
  assert.equal(report.observed.greetingFailedMembers, 1)
  assert.equal(report.observed.greetingFailedAttempts, 4)
  assert.equal(report.members.rows.length, 1)
  assert.equal(report.members.hasMore, true)
  assert.equal(report.members.nextOffset, 1)
  assert.equal(report.members.truncated, true)
  assert.equal(report.truncated, true)
})

test("member facts distinguish recorded failures, no greeting, missing outcome, completion and unknown connection probes", async () => {
  const fixture = fixtureQuery([], [
    member("mem_never"),
    member("mem_failed", { greeting_failure_count: "2" }),
    member("mem_pending", { greeting_started_seconds: seconds + 1, ready_probe_observed: "1" }),
    member("mem_complete", {
      greeting_started_seconds: String(seconds + 0.001),
      greeting_completed_seconds: String(seconds + 1),
      first_message_seconds: String(seconds + 0.5),
      first_message_after_greeting_seconds: String(seconds + 2),
      connected_seconds: String(seconds),
      greeting_failure_count: 1,
      ready_probe_observed: 1,
      email: "must-not-leave@example.test",
      content: "must not leave",
    }),
  ], [{ error_code: "runner_unavailable", model: "gateway/model-a", attempts: "3", members: "2" },
    { error_code: null, model: null, attempts: 1, members: 1 }])
  const report = await readWorkbotAdoptionReport(input, fixture.query)
  assert.deepEqual(report.members.rows.map((row) => row.greetingState), [
    "never_started", "failed", "started_without_outcome", "completed",
  ])
  assert.deepEqual(report.members.rows.map((row) => row.connectionState), [
    "unknown", "unknown", "zero_observed", "connected_observed",
  ])
  assert.equal(report.members.rows[1]?.greetingFailedAttempts, 2)
  assert.equal(report.members.rows[3]?.cohortDay, "2026-10-01")
  assert.equal(report.members.rows[3]?.signedInAt, "2026-10-01T00:00:00.000Z")
  assert.equal(report.members.rows[3]?.greetingStartedAt, "2026-10-01T00:00:00.001Z")
  assert.equal(report.members.rows[3]?.firstMessageSentAt, "2026-10-01T00:00:00.500Z")
  assert.equal(report.members.rows[3]?.firstMessageAfterGreetingAt, "2026-10-01T00:00:02.000Z")
  assert.deepEqual(report.greetingFailures.rows, [
    { errorCode: "runner_unavailable", model: "gateway/model-a", attempts: 3, members: 2 },
    { errorCode: null, model: null, attempts: 1, members: 1 },
  ])
  assert.doesNotMatch(JSON.stringify(report), /must.not.leave|example\.test|"email"|"content"/)
})

test("member ready snapshots preserve null versus zero and later connection successes are separate from readiness", async () => {
  const fixture = fixtureQuery([], [
    member("mem_unknown", { ready_count_at_sign_in: null, ready_count_at_greeting: null }),
    member("mem_known", { ready_count_at_sign_in: "0", ready_count_at_greeting: "3", connection_count: "2" }),
  ])
  const report = await readWorkbotAdoptionReport(input, fixture.query)
  assert.equal(report.members.rows[0]?.readyCountAtSignIn, null)
  assert.equal(report.members.rows[0]?.readyCountAtGreeting, null)
  assert.equal(report.members.rows[0]?.connectionCount, 0)
  assert.equal(report.members.rows[1]?.readyCountAtSignIn, 0)
  assert.equal(report.members.rows[1]?.readyCountAtGreeting, 3)
  assert.equal(report.members.rows[1]?.connectionCount, 2)
})

test("answering models use completion facts and honestly retain response, configured fallback and unknown sources per org/member", async () => {
  const fixture = fixtureQuery([], [member("mem_a"), member("mem_a", { org_id: "org_b" })], [], [
    { org_id: "org_a", member_id: "mem_a", model: "gateway/answer", model_source: "response", greeting_completions: "1", user_turn_completions: "3" },
    { org_id: "org_a", member_id: "mem_a", model: "gateway/requested", model_source: "configured", greeting_completions: 0, user_turn_completions: 2 },
    { org_id: "org_a", member_id: "mem_a", model: "gateway/legacy", model_source: null, greeting_completions: 1, user_turn_completions: 0 },
    { org_id: "org_b", member_id: "mem_a", model: null, model_source: "not-allowlisted", greeting_completions: 0, user_turn_completions: 1 },
  ])
  const report = await readWorkbotAdoptionReport(input, fixture.query)
  assert.deepEqual(report.members.rows[0]?.answeringModels, {
    rows: [
      { model: "gateway/answer", source: "response", greetingCompletions: 1, userTurnCompletions: 3 },
      { model: "gateway/requested", source: "configured", greetingCompletions: 0, userTurnCompletions: 2 },
      { model: "gateway/legacy", source: "unknown", greetingCompletions: 1, userTurnCompletions: 0 },
    ],
    limit: 10,
    truncated: false,
  })
  assert.deepEqual(report.members.rows[1]?.answeringModels.rows, [
    { model: null, source: "unknown", greetingCompletions: 0, userTurnCompletions: 1 },
  ])
})

test("each member's model list is bounded without affecting other members or full-cohort totals", async () => {
  const fixture = fixtureQuery([{ bucket_type: "total", signed_in: 50 }], [member("mem_a"), member("mem_b")], [],
    Array.from({ length: 11 }, (_, index) => ({ org_id: "org_a", member_id: "mem_a", model: `model_${index}`, model_source: "response", user_turn_completions: 1 })))
  const report = await readWorkbotAdoptionReport(input, fixture.query)
  assert.equal(report.funnel.signedIn, 50)
  assert.equal(report.members.rows[0]?.answeringModels.rows.length, 10)
  assert.equal(report.members.rows[0]?.answeringModels.truncated, true)
  assert.deepEqual(report.members.rows[1]?.answeringModels.rows, [])
  assert.equal(report.members.rows[1]?.answeringModels.truncated, false)
  assert.equal(report.truncated, true)
})

test("organization and failure breakdowns are capped independently and clearly truncated", async () => {
  const fixture = fixtureQuery(Array.from({ length: 1001 }, (_, index) => ({ bucket_type: "organization", bucket: `org_${index}` })),
    [member("mem_a")],
    Array.from({ length: 1001 }, (_, index) => ({ error_code: `error_${index}`, attempts: 1, members: 1 })))
  const report = await readWorkbotAdoptionReport({ ...input, offset: 1 }, fixture.query)
  assert.equal(report.organizations.rows.length, 1000)
  assert.equal(report.organizations.truncated, true)
  assert.equal(report.greetingFailures.rows.length, 1000)
  assert.equal(report.greetingFailures.truncated, true)
  assert.equal(report.members.hasMore, false)
  assert.equal(report.members.nextOffset, null)
  assert.equal(report.members.truncated, true, "an offset page is not a complete member list")
  assert.equal(report.truncated, true)
})

test("an empty cohort is zero, not an error, and malformed input never reaches the query helper", async () => {
  const fixture = fixtureQuery()
  const report = await readWorkbotAdoptionReport(input, fixture.query)
  assert.deepEqual(report.funnel, { signedIn: 0, greetingCompleted: 0, firstMessageSent: 0, atLeastOneConnected: 0 })
  assert.deepEqual(report.daily, [])
  assert.deepEqual(report.members.rows, [])
  assert.equal(report.truncated, false)
  assert.equal(report.members.nextOffset, null)
  const invalid = fixtureQuery()
  await assert.rejects(readWorkbotAdoptionReport({ ...input, endDate: "2027-10-01" }, invalid.query))
  assert.equal(invalid.calls(), 0)
})

test("a read failure or invalid database count is never reported as zero adoption", async () => {
  await assert.rejects(readWorkbotAdoptionReport(input, async () => { throw new Error("query_timeout") }), /query_timeout/)
  const invalid = fixtureQuery([{ bucket_type: "total", signed_in: "not a count" }])
  await assert.rejects(readWorkbotAdoptionReport(input, invalid.query), /Invalid adoption count/)
})
