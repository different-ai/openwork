import { automationListSchema, automationRunRangeSchema, type AutomationList, type AutomationRun, type AutomationSchedule } from "@openwork/types/automations"
import { denGoogleCalendarEventsResponseSchema } from "../../../../packages/calendar/src/den-contract.js"

/**
 * Test-only: a person's week as the Calendar reads it through `/v1/workbot/calendar/...`, built around today so the
 * page always shows past runs, a run that failed, one that won't run until fixed, meetings and what runs next.
 * The shapes are Den's, parsed with Den's own schemas before they are served.
 */
const HOUR = 60 * 60 * 1_000
const MINUTE = 60 * 1_000
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"

function at(dayOffset: number, hours: number, base = new Date()) {
  const day = new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset)
  return day.getTime() + hours * HOUR
}

// [day offset from today, start hour, end hour, title]
const MEETINGS: Array<[number, number, number, string]> = []
for (let offset = -7; offset <= 7; offset++) {
  const weekday = new Date(at(offset, 0)).getDay()
  if (weekday === 0) { if (offset >= 0) MEETINGS.push([offset, 17, 17.5, "Week planning"]); continue }
  if (weekday === 6) continue
  MEETINGS.push([offset, 9.5, 10, "Engineering Sync"])
  if (weekday === 1) MEETINGS.push([offset, 11, 11.5, "1:1 Omar"], [offset, 14, 15, "Product review"], [offset, 16, 16.5, "Candidate interview"])
  if (weekday === 2) MEETINGS.push([offset, 10.5, 11.25, "Pilot check-in"], [offset, 13, 13.5, "Lunch with Jalil"], [offset, 15, 16, "Roadmap planning"])
  if (weekday === 3) MEETINGS.push([offset, 12, 13, "Design review: Calendar"], [offset, 15, 15.5, "30 min intro call"], [offset, 16.5, 17, "1:1 Omar"])
  if (weekday === 4) MEETINGS.push([offset, 11, 11.75, "Pilot check-in"], [offset, 13, 13.5, "1:1 Jalil"], [offset, 16, 17, "Open office hours"])
  if (weekday === 5) MEETINGS.push([offset, 10, 10.5, "Metrics review"], [offset, 12.5, 13.5, "Team lunch"], [offset, 15, 16, "Demo day"])
}

const iso = (instant: number) => new Date(instant).toISOString()
const dateOnly = (offset: number) => { const day = new Date(at(offset, 0)); return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}` }

export function fixtureMeetings(from: number, to: number) {
  const events = [
    ...MEETINGS.map(([offset, start, end, title], index) => ({
      id: `evt_${offset}_${index}`, summary: title, description: "", location: "", start: iso(at(offset, start)), end: iso(at(offset, end)),
      status: "confirmed", htmlLink: "https://calendar.google.com/", attendees: ["sam@example.test", "omar@example.test"], meetLink: "https://meet.google.com/abc-defg-hij",
    })),
    // Working location: an all-day Office or Home event on weekdays.
    ...Array.from({ length: 15 }, (_, index) => index - 7).filter((offset) => { const day = new Date(at(offset, 0)).getDay(); return day > 0 && day < 6 }).map((offset) => ({
      id: `loc_${offset}`, summary: new Date(at(offset, 0)).getDay() % 2 ? "Office" : "Home", description: "", location: "", start: dateOnly(offset), end: dateOnly(offset + 1),
      status: "confirmed", htmlLink: "https://calendar.google.com/", attendees: [], meetLink: null,
    })),
  ].filter((event) => {
    const start = Date.parse(event.start.length === 10 ? `${event.start}T00:00:00` : event.start)
    return start < to && start + 24 * HOUR > from
  })
  return denGoogleCalendarEventsResponseSchema.parse({ ok: true, events })
}

const usage = { inputTokens: null, outputTokens: null, costMicros: null }
const model = { providerId: "openwork", modelId: "claude-sonnet-4-5" }

function automation(id: string, name: string, schedule: AutomationSchedule, instructions: string, state: "active" | "needs_attention" = "active", nextDueAt: number | null = null) {
  const created = at(-30, 9)
  return {
    automation: {
      id, organizationId: "org_fixture", ownerMemberId: "member_fixture", name, state, currentRevisionId: `${id}_r1`, nextDueAt, latestRunAt: null,
      needsAttentionReason: state === "needs_attention" ? { code: "connect_access_unavailable" as const, message: "PostHog was disconnected, so this won’t run. Reconnect it to start again.", occurredAt: at(-2, 9) } : null,
      createdAt: created, updatedAt: created, archivedAt: null,
    },
    revision: { id: `${id}_r1`, automationId: id, version: 1, instructions, schedule, model, executionTarget: "cloud" as const, maximumRuntimeMs: 600_000, digest: "fixture-digest-0001", createdAt: created },
    latestRun: null,
  }
}

const daily = (hour: number, minute = 0): AutomationSchedule => ({ kind: "daily", timezone: zone, hour, minute })
const failedAt = at((3 - new Date().getDay() + 7) % 7 - 7 || -4, 14)

export const AUTOMATIONS: AutomationList = automationListSchema.parse({
  items: [
    automation("auto_greeting", "Morning greeting", daily(7), "Every morning, say good morning in Slack with today's first meeting."),
    automation("auto_prep", "Prep brief 1 hour before meetings", { kind: "calendar", timezone: zone, edge: "start", offsetMinutes: -60, rule: { withExternalAttendees: false } }, "An hour before each meeting, send me a short brief on who's coming and what we last discussed."),
    automation("auto_prs", "Tell me when PRs need review", { kind: "interval", timezone: zone, everyHours: 2, daysOfWeek: [1, 2, 3, 4, 5], startHour: 9, endHour: 18 }, "Check GitHub for pull requests waiting on my review and tell me in Slack."),
    automation("auto_actions", "Action items after meetings", { kind: "calendar", timezone: zone, edge: "end", offsetMinutes: 5, rule: { withExternalAttendees: false } }, "After each meeting, post the action items to me in Slack."),
    automation("auto_bugs", "Nightly bug status map → #ai-dump", daily(22, 20), "Every night, map the bug reports posted in #bug during the last 24 hours to their current status and post it to #ai-dump."),
    automation("auto_hi", "hi", { kind: "once", timezone: zone, at: failedAt }, "Say hi in #general-old."),
    automation("auto_metrics", "Weekly metrics digest", { kind: "weekly", timezone: zone, daysOfWeek: [5], hour: 8, minute: 0 }, "Every Friday, send the weekly product metrics from PostHog.", "needs_attention"),
  ],
  nextCursor: null,
})

function run(automationId: string, instant: number, status: AutomationRun["status"] = "succeeded", extra: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: `run_${automationId}_${instant}`, automationId, revisionId: `${automationId}_r1`, trigger: "scheduled", scheduledFor: instant,
    idempotencyKey: `fixture_${automationId}_${instant}`, status, leaseOwner: null, leaseExpiresAt: null, heartbeatAt: null, attemptCount: 1,
    executionTarget: "cloud", executionThread: null, providerId: model.providerId, modelId: model.modelId, modelVariant: null,
    startedAt: instant + 2_000, finishedAt: instant + 64_000, error: null, resultSummary: status === "succeeded" ? "Done." : null, usage,
    createdAt: instant, updatedAt: instant + 64_000, ...extra,
  }
}

function allRuns(now: number): AutomationRun[] {
  const runs: AutomationRun[] = []
  for (let offset = -14; offset <= 0; offset++) {
    const weekday = new Date(at(offset, 0)).getDay()
    runs.push(run("auto_greeting", at(offset, 7)), run("auto_bugs", at(offset, 22 + 20 / 60)))
    if (weekday > 0 && weekday < 6) for (const hour of [9, 11, 13, 15, 17]) runs.push(run("auto_prs", at(offset, hour)))
  }
  MEETINGS.forEach(([offset, start, end], index) => {
    const context = { kind: "calendar_meeting" as const, eventId: `evt_${offset}_${index}`, title: null, start: at(offset, start), end: at(offset, end), attendeeDomains: ["example.test"], externalAttendees: 0, link: null }
    runs.push(run("auto_prep", at(offset, start - 1), "succeeded", { triggerContext: context }))
    runs.push(run("auto_actions", at(offset, end) + 5 * MINUTE, "succeeded", { triggerContext: context }))
  })
  runs.push(run("auto_hi", failedAt, "failed", { resultSummary: null, error: { code: "execution_failed", message: "Slack couldn’t find #general-old, so nothing was sent.", retryable: true } }))
  return runs.filter((entry) => (entry.scheduledFor ?? 0) < now)
}

export function fixtureRunRange(from: number, to: number) {
  const items = allRuns(Date.now()).filter((entry) => (entry.scheduledFor ?? 0) >= from && (entry.scheduledFor ?? 0) < to)
  return automationRunRangeSchema.parse({ items, nextCursor: null })
}

export function fixtureAutomationRuns(automationId: string) {
  const items = allRuns(Date.now()).filter((entry) => entry.automationId === automationId).sort((left, right) => (right.scheduledFor ?? 0) - (left.scheduledFor ?? 0)).slice(0, 10)
  return { items, nextCursor: null }
}
