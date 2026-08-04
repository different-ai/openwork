import { describe, expect, test } from "bun:test";

import { formatAutomationWeekdays } from "../src/react-app/domains/automations/automation-format";

describe("Automation labels", () => {
  test("formats weekly schedules with human-readable weekday names", () => {
    expect(formatAutomationWeekdays([5], "en-US")).toBe("Fri");
    expect(formatAutomationWeekdays([1, 3, 5], "en-US")).toBe("Mon, Wed, Fri");
  });
});
