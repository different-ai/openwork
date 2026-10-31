import assert from "node:assert/strict"
import { test } from "node:test"
import type { AutomationListItem } from "@openwork/automations"
import { CALENDAR_TRIGGER_POLL_MS } from "@openwork/automations"
import { CalendarTriggerSource, type CalendarTriggerSourceDeps } from "../src/automations/calendar-trigger-source.js"

const now = Date.parse("2026-10-30T12:00:00Z")

function automation(id = "automation_a"): AutomationListItem {
  return {
    automation: {
      id, organizationId: "org_a", ownerMemberId: "member_a", name: "Meeting follow-up", state: "active",
      currentRevisionId: `revision_${id}`, nextDueAt: null, latestRunAt: null,
      needsAttentionReason: null, createdAt: now - 60_000, updatedAt: now - 60_000, archivedAt: null,
    },
    revision: {
      id: `revision_${id}`, automationId: id, version: 1, instructions: "Summarize the action items.",
      schedule: { kind: "calendar", timezone: "UTC", edge: "end", offsetMinutes: 0, rule: { withExternalAttendees: false } },
      model: { providerId: "openwork", modelId: "auto" }, executionTarget: "cloud",
      maximumRuntimeMs: 60_000, digest: "calendar-trigger-test-digest", createdAt: now - 60_000,
    },
    latestRun: null,
  }
}

const calendar = {
  items: [{
    id: "meeting_a", status: "confirmed", summary: "Planning",
    start: { dateTime: new Date(now - 30 * 60_000).toISOString() },
    end: { dateTime: new Date(now).toISOString() },
    attendees: [
      { email: "owner@example.test", self: true, responseStatus: "accepted" },
      { email: "peer@example.test" },
    ],
  }],
}

function dependencies(overrides: Partial<CalendarTriggerSourceDeps> = {}): CalendarTriggerSourceDeps {
  return {
    list: async () => [automation()],
    read: async () => ({ kind: "ok", json: calendar }),
    claim: async (item) => `run_${item.automation.id}`,
    needsConnection: async () => { assert.fail("a connected calendar must not need attention") },
    ...overrides,
  }
}

test("calendar triggers read and claim meetings without a feature dependency, caching reads per owner", async () => {
  const reads: string[] = []
  const claims: string[] = []
  const source = new CalendarTriggerSource(dependencies({
    list: async () => [automation(), automation("automation_b")],
    read: async (input) => {
      reads.push(input.ownerMemberId)
      return { kind: "ok", json: calendar }
    },
    claim: async (item, occurrence) => {
      claims.push(item.automation.id)
      assert.equal(occurrence.scheduledFor, now)
      assert.equal(occurrence.triggerContext.kind, "calendar_meeting")
      return `run_${item.automation.id}`
    },
  }))
  assert.deepEqual(await source.tick(now), ["run_automation_a", "run_automation_b"])
  assert.deepEqual(await source.tick(now + 1_000), [])
  assert.deepEqual(reads, ["member_a"])
  assert.deepEqual(claims, ["automation_a", "automation_b"])
  assert.deepEqual(await source.tick(now + CALENDAR_TRIGGER_POLL_MS), [])
  assert.equal(reads.length, 2)
  assert.equal(claims.length, 2, "a cached occurrence is never claimed again")
})

test("only owners with active calendar-triggered Automations need a calendar read", async () => {
  const daily = automation()
  daily.revision.schedule = { kind: "daily", timezone: "UTC", hour: 12, minute: 0 }
  const source = new CalendarTriggerSource(dependencies({
    list: async () => [daily],
    read: async () => { assert.fail("clock schedules must not read calendars") },
  }))
  assert.deepEqual(await source.tick(now), [])
})

test("calendar triggers still require a Google connection with calendar scope", async () => {
  const attention: string[] = []
  const source = new CalendarTriggerSource(dependencies({
    read: async () => ({ kind: "needs_connection" }),
    claim: async () => { assert.fail("an unreadable calendar cannot produce work") },
    needsConnection: async (item, message) => {
      attention.push(item.automation.id)
      assert.match(message, /Connect Google Calendar with calendar access/)
    },
  }))
  assert.deepEqual(await source.tick(now), [])
  assert.deepEqual(attention, ["automation_a"])
})
