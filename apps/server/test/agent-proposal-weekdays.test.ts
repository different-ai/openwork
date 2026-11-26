import assert from "node:assert/strict";
import { test } from "node:test";

import { personalAgentProposalSchema } from "@openwork/types/den/personal-agents";

import { withNumberedWeekdays } from "../src/agent-proposal-input.js";

const proposal = (schedule: object) => ({
  name: "Bug watcher",
  brief: "Watch #bugs and file what is missing.",
  routine: { name: "Check #bugs", instructions: "Read #bugs and file missing issues.", schedule },
});

test("weekdays a model wrote as names become the numbers a schedule needs", () => {
  const parsed = personalAgentProposalSchema.parse(withNumberedWeekdays(proposal({
    kind: "weekly", timezone: "America/Los_Angeles", days: ["mon", "Tuesday", "wed", "thu", "FRI"], hour: 9, minute: 0,
  })));
  assert.deepEqual(parsed.routine.schedule, { kind: "weekly", timezone: "America/Los_Angeles", daysOfWeek: [1, 2, 3, 4, 5], hour: 9, minute: 0 });
});

test("a schedule that is already right, or has no days, is left alone", () => {
  const weekly = proposal({ kind: "weekly", timezone: "UTC", daysOfWeek: [0, 6], hour: 8, minute: 30 });
  assert.deepEqual(withNumberedWeekdays(weekly), weekly);
  const daily = proposal({ kind: "daily", timezone: "UTC", hour: 8, minute: 30 });
  assert.deepEqual(withNumberedWeekdays(daily), daily);
  assert.equal(withNumberedWeekdays(null), null);
});

test("a day that is not a weekday still fails the schedule", () => {
  const parsed = personalAgentProposalSchema.safeParse(withNumberedWeekdays(proposal({
    kind: "weekly", timezone: "UTC", days: ["someday"], hour: 9, minute: 0,
  })));
  assert.equal(parsed.success, false);
});
