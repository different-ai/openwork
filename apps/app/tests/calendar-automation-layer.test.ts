import { describe, expect, test } from "bun:test";
import type { AutomationList, AutomationRun, AutomationSchedule } from "@openwork/types/automations";
import { buildAutomationCalendarItems, describeRunOutcome } from "../src/react-app/domains/calendar/automation-calendar";
import { describeSchedule } from "../src/react-app/domains/calendar/calendar-format";
import { layoutOverlappingBlocks } from "../src/react-app/domains/calendar/calendar-layout";
import { calendarRange, dayLengthMinutes, minutesIntoDay, parseGraphDateTime, zonedTimeToInstant } from "../src/react-app/domains/calendar/calendar-time";

/**
 * The Calendar's Automations layer: Den run receipts reconciled with schedule
 * slots expanded by the scheduler's own resolver. Past time is never treated as
 * a run; blocked and paused Automations never show confirmed upcoming runs.
 */

const ZONE = "America/Los_Angeles";
const NOW = Date.parse("2026-10-07T17:00:00Z"); // Wed 10:00 PDT
const WEEK = calendarRange("week", { year: 2026, month: 10, day: 7 }, ZONE, 1);

type Item = AutomationList["items"][number];

function automation(id: string, name: string, schedule: AutomationSchedule, overrides: Partial<Item["automation"]> = {}, target: "desktop" | "cloud" = "cloud"): Item {
  return {
    automation: {
      id, organizationId: "org_1", ownerMemberId: "mem_1", name, state: "active", currentRevisionId: `rev_${id}`,
      nextDueAt: null, latestRunAt: null, needsAttentionReason: null, createdAt: Date.parse("2026-09-01T00:00:00Z"),
      updatedAt: Date.parse("2026-09-01T00:00:00Z"), archivedAt: null, ...overrides,
    },
    revision: {
      id: `rev_${id}`, automationId: id, version: 1, instructions: "Do the thing.", schedule,
      model: { providerId: "openwork-cloud", modelId: "default", variant: null }, executionTarget: target, workspaceId: null,
      maximumRuntimeMs: 900_000, digest: "0123456789abcdef0123", createdAt: Date.parse("2026-09-01T00:00:00Z"),
    },
    latestRun: null,
  };
}

function run(id: string, automationId: string, input: Partial<AutomationRun> & { scheduledFor: number | null }): AutomationRun {
  return {
    id, automationId, revisionId: `rev_${automationId}`, trigger: "scheduled", idempotencyKey: id, status: "succeeded",
    leaseOwner: null, leaseExpiresAt: null, heartbeatAt: null, attemptCount: 1, executionTarget: "cloud", executionThread: null,
    providerId: "openwork-cloud", modelId: "default", modelVariant: null, startedAt: input.scheduledFor, finishedAt: input.scheduledFor === null ? null : input.scheduledFor + 102_000,
    error: null, resultSummary: "Drafted", usage: { inputTokens: null, outputTokens: null, costMicros: null },
    createdAt: input.scheduledFor ?? NOW, updatedAt: input.scheduledFor ?? NOW, ...input,
  };
}

const weekdays: AutomationSchedule = { kind: "weekly", timezone: ZONE, daysOfWeek: [1, 2, 3, 4, 5], hour: 9, minute: 0 };
const mon9 = Date.parse("2026-10-05T16:00:00Z");
const tue9 = Date.parse("2026-10-06T16:00:00Z");

describe("buildAutomationCalendarItems", () => {
  test("past slots show only real receipts; future slots of an active Automation are upcoming", () => {
    const items = buildAutomationCalendarItems({
      automations: [automation("a1", "What's waiting on me", weekdays)],
      runs: [run("r1", "a1", { scheduledFor: mon9 }), run("r2", "a1", { scheduledFor: tue9, status: "failed", error: { code: "connect_access_unavailable", message: "Slack sign-in expired", retryable: false } })],
      range: WEEK, now: NOW,
    });
    expect(items.map((item) => [new Date(item.at).toISOString(), item.status])).toEqual([
      ["2026-10-05T16:00:00.000Z", "succeeded"],
      ["2026-10-06T16:00:00.000Z", "failed"],
      // Wednesday 9 AM already passed with no receipt: nothing is shown for it.
      ["2026-10-08T16:00:00.000Z", "upcoming"],
      ["2026-10-09T16:00:00.000Z", "upcoming"],
    ]);
  });

  test("needs-attention Automations show nominal blocked slots, paused ones show none", () => {
    const blocked = automation("a2", "Update launch deals", { kind: "weekly", timezone: ZONE, daysOfWeek: [4], hour: 16, minute: 0 }, {
      state: "needs_attention", needsAttentionReason: { code: "connect_access_unavailable", message: "Needs HubSpot access", occurredAt: NOW },
    });
    const paused = automation("a3", "Paused digest", weekdays, { state: "inactive" });
    const items = buildAutomationCalendarItems({ automations: [blocked, paused], runs: [run("r3", "a3", { scheduledFor: mon9 })], range: WEEK, now: NOW });
    expect(items.filter((item) => item.automationId === "a2").map((item) => item.status)).toEqual(["blocked"]);
    expect(items.filter((item) => item.automationId === "a3").map((item) => item.status)).toEqual(["succeeded"]);
    expect(items.some((item) => item.status === "upcoming")).toBe(false);
  });

  test("manual runs appear at their own time and do not consume a slot", () => {
    const manual = run("r4", "a1", { scheduledFor: null, trigger: "manual", startedAt: Date.parse("2026-10-06T20:30:00Z"), createdAt: Date.parse("2026-10-06T20:30:00Z") });
    const items = buildAutomationCalendarItems({ automations: [automation("a1", "Digest", weekdays)], runs: [manual], range: WEEK, now: NOW });
    expect(items.find((item) => item.key === "run:r4")?.trigger).toBe("manual");
    expect(items.filter((item) => item.status === "upcoming")).toHaveLength(2);
  });

  test("outcome copy shows duration or the recorded error", () => {
    expect(describeRunOutcome(run("r5", "a1", { scheduledFor: mon9 }))).toBe("Completed in 1m 42s");
    expect(describeRunOutcome(run("r6", "a1", { scheduledFor: mon9, status: "failed", error: { code: "execution_failed", message: "Slack sign-in expired", retryable: false } }))).toBe("Slack sign-in expired");
  });
});

describe("calendar time and layout", () => {
  test("a week crossing the US fall-back change is 169 hours and its Sunday has 25", () => {
    const week = calendarRange("week", { year: 2026, month: 10, day: 29 }, ZONE, 1);
    expect((week.end - week.start) / 3_600_000).toBe(169);
    expect(dayLengthMinutes({ year: 2026, month: 11, day: 1 }, ZONE)).toBe(25 * 60);
    // 9 AM PST on Sunday is 10 hours (600 minutes) into that 25-hour day.
    expect(minutesIntoDay(Date.parse("2026-11-01T17:00:00Z"), { year: 2026, month: 11, day: 1 }, ZONE)).toBe(600);
  });

  test("month view pads to whole Monday-first weeks", () => {
    const month = calendarRange("month", { year: 2026, month: 10, day: 7 }, ZONE, 1);
    expect(month.days[0]).toEqual({ year: 2026, month: 9, day: 28 });
    expect(month.days.at(-1)).toEqual({ year: 2026, month: 11, day: 1 });
    expect(month.days.length % 7).toBe(0);
  });

  test("skipped and repeated wall times resolve like calendars render them", () => {
    expect(new Date(zonedTimeToInstant({ year: 2027, month: 3, day: 14, hour: 2, minute: 30 }, ZONE)).toISOString()).toBe("2027-03-14T10:30:00.000Z");
    expect(new Date(zonedTimeToInstant({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, ZONE)).toISOString()).toBe("2026-11-01T08:30:00.000Z");
    expect(parseGraphDateTime("2026-10-06T20:00:00.0000000", "UTC")).toBe(Date.parse("2026-10-06T20:00:00Z"));
    expect(parseGraphDateTime("not a time", "UTC")).toBeNull();
  });

  test("overlapping blocks share a cluster's columns; separate clusters do not", () => {
    const placements = layoutOverlappingBlocks([
      { key: "a", start: 0, end: 30 }, { key: "b", start: 15, end: 60 }, { key: "c", start: 30, end: 45 }, { key: "d", start: 90, end: 120 },
    ]);
    expect(placements.get("a")).toEqual({ column: 0, columns: 2 });
    expect(placements.get("b")).toEqual({ column: 1, columns: 2 });
    expect(placements.get("c")).toEqual({ column: 0, columns: 2 });
    expect(placements.get("d")).toEqual({ column: 0, columns: 1 });
  });

  test("schedules read as sentences", () => {
    expect(describeSchedule(weekdays, ZONE, "en-US")).toBe("Every weekday at 9:00 AM");
    expect(describeSchedule({ kind: "weekly", timezone: ZONE, daysOfWeek: [5], hour: 15, minute: 0 }, ZONE, "en-US")).toBe("Every Friday at 3:00 PM");
    expect(describeSchedule({ kind: "daily", timezone: "Europe/Berlin", hour: 8, minute: 0 }, ZONE, "en-US")).toMatch(/^Every day at 8:00 AM GMT\+[12]$/);
  });
});
