import { describe, expect, test } from "bun:test";
import type { AutomationCalendarItem } from "@openwork/calendar";
import { visibleCalendarSelection } from "../src/calendar-selection";

const block: AutomationCalendarItem = { key: "slot:a:1", automationId: "a", name: "Daily brief", at: 1, end: 2, status: "upcoming", run: null, executionTarget: "cloud", trigger: "schedule" };
const base = { scope: "week:1", selectionScope: "week:1", automations: [{ automation: { id: "a" } }], items: [block], meetings: [], layers: { automations: true, meetings: true } };

describe("calendar selection validity", () => {
  test("data arrival never selects an item", () => {
    expect(visibleCalendarSelection({ ...base, selection: null })).toBeNull();
  });
  test("a chosen occurrence is valid only in its range and visible layer", () => {
    const selection = { kind: "automation", automationId: "a", itemKey: block.key } satisfies NonNullable<Parameters<typeof visibleCalendarSelection>[0]["selection"]>;
    expect(visibleCalendarSelection({ ...base, selection })).toEqual(selection);
    expect(visibleCalendarSelection({ ...base, selection, scope: "week:2" })).toBeNull();
    expect(visibleCalendarSelection({ ...base, selection, layers: { automations: false, meetings: true } })).toBeNull();
    expect(visibleCalendarSelection({ ...base, selection, items: [] })).toBeNull();
    expect(visibleCalendarSelection({ ...base, selection, automations: [] })).toBeNull();
  });
  test("an explicit directory/history intent does not require an occurrence but still has a scope", () => {
    const selection = { kind: "automation", automationId: "a", itemKey: null } satisfies NonNullable<Parameters<typeof visibleCalendarSelection>[0]["selection"]>;
    expect(visibleCalendarSelection({ ...base, selection, items: [] })).toEqual(selection);
    expect(visibleCalendarSelection({ ...base, selection, items: [], scope: "day:1" })).toBeNull();
  });
});
