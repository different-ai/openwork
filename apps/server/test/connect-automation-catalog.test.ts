import { describe, expect, test } from "bun:test";

import { parseOpenWorkAutomationIndex, renderOpenWorkAutomationInstruction } from "../src/connect-automation-catalog.js";

const entry = (id: string, schedule: unknown, extra: Record<string, unknown> = {}) => ({
  id,
  name: `Automation ${id}`,
  state: "active",
  schedule,
  nextDueAt: null,
  executionTarget: "cloud",
  latestRun: null,
  ...extra,
});

describe("Automation catalog", () => {
  test("a Den from before schedule summaries still renders its schedules", () => {
    const index = parseOpenWorkAutomationIndex({
      fetchedAt: 1,
      total: 1,
      omitted: 0,
      automations: [entry("atm_daily", { kind: "weekly", timezone: "UTC", daysOfWeek: [1, 3], hour: 9, minute: 0 })],
    });
    expect(renderOpenWorkAutomationInstruction(index)).toContain("<schedule>weekly on days 1,3 at 09:00 UTC (0=Sunday)</schedule>");
  });

  test("lists interval Automations from moreAutomations with Den's summary", () => {
    const index = parseOpenWorkAutomationIndex({
      fetchedAt: 1,
      total: 2,
      omitted: 0,
      automations: [entry("atm_daily", { kind: "daily", timezone: "UTC", hour: 8, minute: 0 }, { summary: "Daily · 08:00 · UTC" })],
      moreAutomations: [entry("atm_interval", { kind: "interval", timezone: "UTC", everyHours: 3, daysOfWeek: [1, 2, 3, 4, 5], startHour: 9, endHour: 18 }, { summary: "Every 3 hours · 09:00–18:00 · Mon, Tue, Wed, Thu, Fri · UTC" })],
    });
    const rendered = renderOpenWorkAutomationInstruction(index);
    expect(rendered).toContain("<id>atm_daily</id>");
    expect(rendered).toContain("<id>atm_interval</id>");
    expect(rendered).toContain("<schedule>Every 3 hours · 09:00–18:00 · Mon, Tue, Wed, Thu, Fri · UTC</schedule>");
  });

  test("an unknown schedule kind from a newer Den keeps the rest of the index", () => {
    const index = parseOpenWorkAutomationIndex({
      fetchedAt: 1,
      total: 2,
      omitted: 0,
      automations: [entry("atm_daily", { kind: "daily", timezone: "UTC", hour: 8, minute: 0 })],
      moreAutomations: [
        entry("atm_future", { kind: "someday", timezone: "UTC" }),
        entry("atm_meetings", { kind: "calendar", timezone: "UTC", edge: "end", offsetMinutes: 5, rule: { withExternalAttendees: true } }, { summary: "After each meeting (+5 min) · with people outside the organization · UTC" }),
      ],
    });
    const rendered = renderOpenWorkAutomationInstruction(index);
    expect(rendered).toContain("<schedule>daily at 08:00 UTC</schedule>");
    expect(rendered).toContain("<schedule>a schedule this OpenWork version cannot describe</schedule>");
    expect(rendered).toContain("<schedule>After each meeting (+5 min) · with people outside the organization · UTC</schedule>");
  });
});
