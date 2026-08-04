import { describe, expect, test } from "bun:test";

import { formatScheduledTaskWeekdays } from "../src/react-app/domains/scheduled-tasks/scheduled-task-format";

describe("Scheduled Task labels", () => {
  test("formats weekly schedules with human-readable weekday names", () => {
    expect(formatScheduledTaskWeekdays([5], "en-US")).toBe("Fri");
    expect(formatScheduledTaskWeekdays([1, 3, 5], "en-US")).toBe("Mon, Wed, Fri");
  });
});
