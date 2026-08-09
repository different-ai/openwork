import { describe, expect, test } from "bun:test";

import { parseAutomationProposal } from "../src/components/tools/openwork-automation-proposal";

const dailyProposal = {
  ok: true,
  id: "automation.propose",
  result: {
    ok: true,
    kind: "automation-proposal",
    created: false,
    proposal: {
      name: "Morning Slack check",
      instructions: "Summarize my most recent Slack message.",
      schedule: { kind: "daily", timezone: "Europe/Berlin", hour: 9, minute: 0 },
    },
  },
};

describe("Automation proposal card", () => {
  test("reads a proposal out of an openwork_execute result, string or object", () => {
    const fromObject = parseAutomationProposal(dailyProposal);
    const fromString = parseAutomationProposal(JSON.stringify(dailyProposal));

    expect(fromObject).toEqual(fromString);
    expect(fromObject?.name).toBe("Morning Slack check");
    expect(fromObject?.schedule).toEqual({
      kind: "daily",
      timezone: "Europe/Berlin",
      hour: 9,
      minute: 0,
    });
    expect(fromObject?.model).toBeUndefined();
  });

  test("ignores results that are not Automation proposals", () => {
    expect(parseAutomationProposal({ ...dailyProposal, id: "session.create" })).toBeNull();
    expect(parseAutomationProposal({ ...dailyProposal, ok: false })).toBeNull();
    expect(parseAutomationProposal("not json")).toBeNull();
    expect(parseAutomationProposal(null)).toBeNull();
  });

  test("refuses a proposal whose schedule or fields fail the shared contract", () => {
    const badSchedule = {
      ...dailyProposal,
      result: {
        ...dailyProposal.result,
        proposal: {
          ...dailyProposal.result.proposal,
          schedule: { kind: "interval", timezone: "Europe/Berlin", everyMinutes: 5 },
        },
      },
    };
    const emptyName = {
      ...dailyProposal,
      result: {
        ...dailyProposal.result,
        proposal: { ...dailyProposal.result.proposal, name: "   " },
      },
    };

    expect(parseAutomationProposal(badSchedule)).toBeNull();
    expect(parseAutomationProposal(emptyName)).toBeNull();
  });
});
