/**
 * The calendar trigger source with fake reads and claims: one run per meeting
 * across many polls, and one decision log per occurrence.
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import type { AutomationListItem } from "@openwork/automations"
import type { AutomationRunTriggerContext } from "@openwork/types/automations"
import type { MemberCalendarRead } from "../src/routes/org/google-workspace.js"

process.env.DATABASE_URL ??= "mysql://test:test@127.0.0.1:3306/calendar_trigger_unit_test"
process.env.BETTER_AUTH_URL ??= "http://unit.test"
process.env.BETTER_AUTH_SECRET ??= "synthetic-calendar-trigger-unit-test-secret-not-for-production"
process.env.DEN_DB_ENCRYPTION_KEY ??= "synthetic-calendar-trigger-unit-test-key"
process.env.OPENWORK_DEV_MODE = "1"
process.env.DATABASE_REDIS_URL = ""
const { CalendarTriggerSource } = await import("../src/automations/calendar-trigger-source.js")

const MINUTE = 60_000
const createdAt = Date.parse("2026-10-20T13:00:00.000Z")

const item: AutomationListItem = {
  automation: {
    id: "atm_meetings", organizationId: "org_acme", ownerMemberId: "mem_sam", name: "Meeting follow-up", state: "active",
    currentRevisionId: "atv_meetings", nextDueAt: null, latestRunAt: null, needsAttentionReason: null,
    createdAt, updatedAt: createdAt, archivedAt: null,
  },
  revision: {
    id: "atv_meetings", automationId: "atm_meetings", version: 1, instructions: "Write up the action items.",
    // The incident's trigger: 5 minutes after every meeting, no rule.
    schedule: { kind: "calendar", timezone: "America/New_York", edge: "end", offsetMinutes: 5, rule: { withExternalAttendees: false } },
    model: { providerId: "openwork", modelId: "auto" }, executionTarget: "cloud", maximumRuntimeMs: 600_000,
    digest: "digest-0123456789abcdef", createdAt,
  },
  latestRun: null,
}

type Attendee = { email: string; self?: boolean; responseStatus?: string }
const me = (responseStatus: string): Attendee => ({ email: "sam@acme.example", self: true, responseStatus })
const peer: Attendee = { email: "riley@acme.example" }

function meeting(id: string, endsAt: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    status: "confirmed",
    summary: "Acme Robotics weekly sync",
    updated: "2026-10-01T12:00:00.000Z",
    start: { dateTime: new Date(endsAt - 30 * MINUTE).toISOString() },
    end: { dateTime: new Date(endsAt).toISOString() },
    attendees: [me("needsAction"), peer],
    ...overrides,
  }
}

type Claimed = { scheduledFor: number; nonce: string; triggerContext: AutomationRunTriggerContext }

function harness(read: (now: number) => MemberCalendarRead) {
  const claims: Claimed[] = []
  let reads = 0
  let clock = 0
  const source = new CalendarTriggerSource({
    list: async () => [item],
    enabled: async () => true,
    read: async () => {
      reads += 1
      return read(clock)
    },
    claim: async (_item, occurrence) => {
      claims.push(occurrence)
      return `atr_${claims.length}`
    },
    needsConnection: async () => undefined,
  })
  return {
    claims,
    reads: () => reads,
    tick: (now: number) => {
      clock = now
      return source.tick(now)
    },
  }
}

/** Decision logs written while `run` runs, parsed from stdout. */
async function decisionLogs(run: () => Promise<void>): Promise<Array<Record<string, unknown>>> {
  const lines: string[] = []
  const stdout = process.stdout.write.bind(process.stdout)
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    lines.push(...(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")).split("\n"))
    return true
  }
  try {
    await run()
  } finally {
    process.stdout.write = stdout
  }
  return lines.flatMap((line) => {
    if (!line.includes("calendar trigger decision")) return []
    const parsed: unknown = JSON.parse(line)
    return typeof parsed === "object" && parsed !== null ? [Object.fromEntries(Object.entries(parsed))] : []
  })
}

test("an unanswered meeting runs once across many polls; each decision is logged once", async () => {
  const endsAt = createdAt + 60 * MINUTE
  const dueAt = endsAt + 5 * MINUTE
  const calendar = {
    items: [
      meeting("unanswered", endsAt),
      meeting("maybe", endsAt + 20 * MINUTE, { attendees: [me("tentative"), peer] }),
      meeting("declined", endsAt, { attendees: [me("declined"), peer] }),
      meeting("focus", endsAt, { eventType: "focusTime" }),
      meeting("solo", endsAt, { attendees: undefined, organizer: { email: "sam@acme.example", self: true } }),
      meeting("cancelled", endsAt, { status: "cancelled" }),
      meeting("all-day", endsAt, { start: { date: "2026-10-20" }, end: { date: "2026-10-21" } }),
    ],
  }
  const source = harness(() => ({ kind: "ok", json: calendar }))
  const logs = await decisionLogs(async () => {
    // Every 15 seconds from a minute before the first meeting's moment to well past the second's.
    for (let now = dueAt - MINUTE; now <= dueAt + 40 * MINUTE; now += 15_000) await source.tick(now)
  })

  assert.deepEqual(source.claims.map((claim) => [claim.triggerContext.eventId, claim.scheduledFor]), [["unanswered", dueAt], ["maybe", dueAt + 20 * MINUTE]])
  assert.ok(source.reads() <= 10, `one read per poll, not per tick (${source.reads()})`)

  const decided = logs.map((log) => [log.occurrence_key, log.decision, log.reason])
  assert.equal(new Set(decided.map((entry) => String(entry[0]))).size, decided.length, "one log per occurrence, not per poll")
  assert.deepEqual(Object.fromEntries(logs.map((log) => [String(log.occurrence_key).split(":").at(-1), log.reason ?? log.decision])), {
    unanswered: "run", maybe: "run", declined: "declined", focus: "not_a_meeting", solo: "no_one_else", cancelled: "cancelled",
  })
  const run = logs.find((log) => log.decision === "run" && String(log.occurrence_key).endsWith(":unanswered"))
  assert.equal(run?.owner_response, "needsAction")
  assert.equal(run?.run_id, "atr_1")
  assert.ok(!JSON.stringify(logs).includes("Acme Robotics weekly sync"), "logs never carry the title")
})

test("a decision that changes inside the grace window is acted on: declined, then accepted, runs once", async () => {
  const endsAt = createdAt + 60 * MINUTE
  const dueAt = endsAt + 5 * MINUTE
  let answer = "declined"
  const source = harness(() => ({ kind: "ok", json: { items: [meeting("changed", endsAt, { attendees: [me(answer), peer] })] } }))
  const logs = await decisionLogs(async () => {
    await source.tick(dueAt + 1_000)
    await source.tick(dueAt + 2 * MINUTE)
    answer = "accepted"
    await source.tick(dueAt + 6 * MINUTE)
    await source.tick(dueAt + 7 * MINUTE)
  })
  assert.deepEqual(source.claims.map((claim) => claim.triggerContext.eventId), ["changed"])
  assert.deepEqual(logs.map((log) => log.reason ?? log.decision), ["declined", "run"])
})
