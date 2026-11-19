import assert from "node:assert/strict";
import { test } from "node:test";

import { automationTimestampFromText } from "@openwork/types/automation-schedule";
import { automationProposalSchema } from "@openwork/types/automations";

import { withOnceTimestamp } from "../src/automation-proposal-input.js";

const nineAmPacific = Date.UTC(2026, 10, 19, 17, 0);

test("a one-time run written as a date string becomes epoch milliseconds", () => {
  assert.equal(automationTimestampFromText("2026-11-19T09:00:00", "America/Los_Angeles"), nineAmPacific);
  assert.equal(automationTimestampFromText("2026-11-19 09:00", "America/Los_Angeles"), nineAmPacific);
  assert.equal(automationTimestampFromText("2026-11-19T09:00:00-08:00", "Europe/Paris"), nineAmPacific);
  assert.equal(automationTimestampFromText("2026-11-19T17:00:00.000Z", "America/Los_Angeles"), nineAmPacific);
  assert.equal(automationTimestampFromText(String(nineAmPacific), "America/Los_Angeles"), nineAmPacific);
});

test("text that is not a date-time is left for the schema to reject", () => {
  assert.equal(automationTimestampFromText("next Thursday", "America/Los_Angeles"), null);
  assert.equal(automationTimestampFromText("2026-13-40T09:00", "America/Los_Angeles"), null);
  assert.equal(automationTimestampFromText("2026-11-19T09:00", "Not/AZone"), null);
  const args = { name: "n", instructions: "i", schedule: { kind: "once", timezone: "America/Los_Angeles", at: "next Thursday" } };
  assert.equal(withOnceTimestamp(args), args);
  assert.equal(automationProposalSchema.safeParse(withOnceTimestamp(args)).success, false);
});

test("a proposal with a date string for its one-time run passes validation", () => {
  const proposal = automationProposalSchema.parse(withOnceTimestamp({
    name: "Remind me",
    instructions: "Prepare the draft.",
    schedule: { kind: "once", timezone: "America/Los_Angeles", at: "2026-11-19T09:00:00" },
  }));
  assert.deepEqual(proposal.schedule, { kind: "once", timezone: "America/Los_Angeles", at: nineAmPacific });
});

test("other schedules and numeric times pass through untouched", () => {
  const daily = { name: "n", instructions: "i", schedule: { kind: "daily", timezone: "UTC", hour: 9, minute: 0 } };
  assert.equal(withOnceTimestamp(daily), daily);
  const once = { name: "n", instructions: "i", schedule: { kind: "once", timezone: "UTC", at: nineAmPacific } };
  assert.equal(withOnceTimestamp(once), once);
});
