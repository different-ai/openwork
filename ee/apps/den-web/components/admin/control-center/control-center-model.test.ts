import assert from "node:assert/strict";
import { test } from "node:test";
import type { AdminControlCenter } from "@openwork/types/den/admin-control-center";
import { change, controlCenterSignals, relativeTime } from "./control-center-model";

const empty = { computedAt: "2026-10-28T12:00:00.000Z", stale: false, error: null, durationMs: 10, data: null };

function view(overrides: Partial<AdminControlCenter["sections"]>): AdminControlCenter {
  return {
    range: "7d",
    generatedAt: "2026-10-28T12:00:00.000Z",
    sections: { pulse: empty, lifecycle: empty, invitations: empty, sharing: empty, revenue: empty, accounts: empty, ...overrides },
    refresh: { fastIntervalMs: 300_000, heavyIntervalMs: 1_800_000, lastRequestedAt: null },
  };
}

const pulse = (failureRate: number) => ({
  taskUsers: { daily: 1, weekly: 1, monthly: 1, previousWeekly: 1, dailyOverMonthly: 1 },
  tasks: { weekly: 1, previousWeekly: 1, perWeekday: 1, perActiveUser: 1 },
  failures: { started: 100, completed: 80, failed: failureRate * 100, abandoned: 0, failureRate, abandonedRate: 0, previousFailureRate: 0.1 },
  teamOrganizations: { active: 1, previous: 1 },
  signups: { weekly: 1, previousWeekly: 1, workEmail: 1, workEmailShare: 1 },
  daily: [],
});

test("no signals when everything is healthy or still loading", () => {
  assert.deepEqual(controlCenterSignals(view({ pulse: { ...empty, data: pulse(0.05) } })), []);
  assert.deepEqual(controlCenterSignals(view({})), []);
});

test("each threshold raises its own signal", () => {
  const ids = controlCenterSignals(view({
    pulse: { ...empty, data: pulse(0.2) },
    invitations: { ...empty, data: {
      joinedThroughInvite: 100, joinedRanTask: 30, joinedRanTaskWithin7Days: 20, peopleWithAcceptedInvite: 100,
      invitations: { sent: 1, accepted: 1, expired: 0, pending: 0, canceled: 0, medianHoursToAccept: 1 }, pendingNow: 0, outreach: null,
    } },
    sharing: { ...empty, data: {
      weekly: [],
      skills: { creators: 0, teamSkills: 0, sharedTeamSkills: 0, sharingRate: null, teamUses: 0, teammateUses: 0, teammateReuseRate: null },
      mcp: { teamCalls: 0, sharedConnectionCalls: 0, sharedReuseRate: null },
      connectors: [
        { name: "Busy", people: 10, calls: 200, errors: 40, errorRate: 0.2 },
        { name: "Quiet", people: 1, calls: 10, errors: 5, errorRate: 0.5 },
      ],
      catalog: { plugins: 0, marketplaces: 0 },
    } },
    lifecycle: { ...empty, error: "timed out", data: {
      weeks: [{ week: "2026-10-19", new: 1, stillActive: 1, returned: 1, lost: 4, gainsVsLosses: 0.5 }],
      organizations: [],
      activation: { from: "2026-10-01", to: "2026-10-14", signedUp: 0, ranTaskWithin3Days: 0, backAfterDay1: 0, activeInWeek1: 0 },
      cohorts: [],
      reactivation: { week: "2026-10-19", reactivated: 0, returned: 0, lost: 0, inactivePool: 0, returnersStayed: { week: "2026-10-12", returned: 0, stayed: 0, rate: null } },
    } },
    revenue: { ...empty, data: { activePaidSeats: 1, activePlans: 1, pastDue: 2, monthly: [], atRisk: [] } },
  })).map((signal) => signal.id);
  // A connector with too few calls to judge stays quiet.
  assert.deepEqual(ids, ["failures", "invites", "connector:Busy", "gains", "past-due", "refresh"]);
});

test("a handful of invited members is too few to judge activation", () => {
  const invitations = (joined: number, active: number) => ({ ...empty, data: {
    joinedThroughInvite: joined, joinedRanTask: active, joinedRanTaskWithin7Days: active, peopleWithAcceptedInvite: joined,
    invitations: { sent: joined, accepted: joined, expired: 0, pending: 0, canceled: 0, medianHoursToAccept: 1 }, pendingNow: 0, outreach: null,
  } });
  assert.deepEqual(controlCenterSignals(view({ invitations: invitations(1, 0) })), []);
  assert.deepEqual(controlCenterSignals(view({ invitations: invitations(10, 2) })).map((signal) => signal.id), ["invites"]);
});

test("formatting helpers", () => {
  assert.equal(change(110, 100), 10);
  assert.equal(change(0, 0), 0);
  assert.equal(change(5, 0), null);
  const now = Date.parse("2026-10-28T12:04:00.000Z");
  assert.equal(relativeTime("2026-10-28T12:00:00.000Z", now), "Updated 4 min ago");
  assert.equal(relativeTime(null, now), "Not computed yet");
});
