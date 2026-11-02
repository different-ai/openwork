import assert from "node:assert/strict";
import { test } from "node:test";
import {
  coverageLabel,
  dayBars,
  healthLabel,
  healthTone,
  lastActivity,
  parseFeatureUsageDetail,
  parseFeatureUsageReport,
  reasonLabel,
  showsSkips,
  sortFeatureUsage,
  unitCount,
  unitHeading,
  type FeatureUsageRow,
} from "./feature-usage-model";

const outcomes = {
  runs: 14, succeeded: 5, failed: 1, skipped: 8, delivered: null, limited: null, lastRunAt: "2026-10-28T12:00:00.000Z", unit: "meeting",
  days: [{ day: "2026-10-27", runs: 4, failed: 0 }, { day: "2026-10-28", runs: 10, failed: 1 }],
  coverage: null,
};

test("the report parses, keeps counts only and drops features this build does not know", () => {
  const report = parseFeatureUsageReport({
    range: "30d",
    organizations: 42,
    generatedAt: "2026-10-28T15:00:00.000Z",
    features: [
      { key: "workbotProactive", organizationsOn: 2, membersUsing: 3, lastUsedAt: "2026-10-28T10:00:00.000Z", health: { status: "mostly_skipped", count: null }, outcomes },
      { key: "administratorRecovery", organizationsOn: 0, membersUsing: 0, lastUsedAt: null, health: { status: "not_used", count: null }, outcomes: null },
      { key: "aFeatureFromANewerServer", organizationsOn: 1, membersUsing: 1, lastUsedAt: null, health: { status: "healthy", count: null }, outcomes: null },
    ],
  });
  assert.ok(report);
  assert.equal(report.range, "30d");
  assert.equal(report.organizations, 42);
  assert.deepEqual(report.features.map((row) => row.key), ["workbotProactive", "administratorRecovery"]);
  assert.equal(report.features[0]?.outcomes?.unit, "meeting");
  assert.equal(report.features[0]?.outcomes?.days.length, 2);
  assert.equal(report.features[1]?.outcomes, null);
  assert.equal(parseFeatureUsageReport({ features: "nope" }), null);
});

test("a feature's detail parses its reasons and organizations", () => {
  const detail = parseFeatureUsageDetail({
    feature: {
      key: "workbotProactive", organizationsOn: 2, membersUsing: 1, lastUsedAt: null, health: { status: "mostly_skipped", count: null }, outcomes,
      reasons: [{ reason: "execution_runtime_unavailable", outcome: "skipped", count: 5 }, { reason: "bad", outcome: "maybe", count: 1 }],
      byOrganization: [
        { organizationId: "org_a", name: "Acme Robotics", enabled: true, membersUsing: 1, lastUsedAt: "2026-10-28T10:00:00.000Z", outcomes: { runs: 10, succeeded: 1, failed: 1, skipped: 8, delivered: null, limited: null, lastRunAt: null } },
        { organizationId: 7, name: "Broken row" },
      ],
    },
  });
  assert.ok(detail);
  assert.deepEqual(detail.reasons, [{ reason: "execution_runtime_unavailable", outcome: "skipped", count: 5 }]);
  assert.deepEqual(detail.byOrganization.map((row) => row.name), ["Acme Robotics"]);
  assert.equal(detail.byOrganization[0]?.outcomes?.skipped, 8);
});

test("health reads as one plain label, red only for failures", () => {
  assert.equal(healthLabel({ status: "healthy", count: null }), "Healthy");
  assert.equal(healthLabel({ status: "mostly_skipped", count: null }, "meeting"), "Most meetings skipped");
  assert.equal(healthLabel({ status: "mostly_skipped", count: null }, "check"), "Most checks skipped");
  assert.equal(healthLabel({ status: "limited", count: 2 }), "2 hit the limit");
  assert.equal(healthLabel({ status: "failing", count: 3 }), "3 failed");
  assert.equal(healthLabel({ status: "not_used", count: null }), "Not used");
  assert.equal(healthLabel({ status: "in_use", count: null }), "In use");
  assert.equal(healthTone({ status: "failing", count: 3 }), "failure");
  assert.equal(healthTone({ status: "limited", count: 2 }), "attention");
  assert.equal(healthTone({ status: "healthy", count: null }), "neutral");
});

test("counts and reasons are in words, never raw codes", () => {
  assert.equal(unitCount(1, "meeting"), "1 meeting");
  assert.equal(unitCount(1200, "message"), "1,200 messages");
  assert.equal(unitHeading("check"), "Checks");
  assert.equal(showsSkips("meeting"), true);
  assert.equal(showsSkips("message"), false);
  assert.equal(reasonLabel("execution_runtime_unavailable"), "Turned off for the organization");
  assert.equal(reasonLabel("member_not_linked"), "Slack account not linked");
  assert.equal(reasonLabel("calendar_not_connected"), "Calendar not connected");
});

test("what needs a look comes first, then the most used", () => {
  const row = (key: FeatureUsageRow["key"], status: FeatureUsageRow["health"]["status"], membersUsing = 0): FeatureUsageRow =>
    ({ key, organizationsOn: 0, membersUsing, lastUsedAt: null, health: { status, count: null }, outcomes: null });
  const sorted = sortFeatureUsage([
    row("administratorRecovery", "not_used"),
    row("autoRouter", "in_use", 9),
    row("workbotProactive", "healthy", 2),
    row("nativeDictation", "limited", 1),
    row("computerUse", "failing", 1),
  ]);
  assert.deepEqual(sorted.map((entry) => entry.key), ["computerUse", "nativeDictation", "workbotProactive", "autoRouter", "administratorRecovery"]);
});

test("the day bars scale to the busiest day and mark the failed share", () => {
  const bars = dayBars([{ day: "a", runs: 0, failed: 0 }, { day: "b", runs: 10, failed: 5 }, { day: "c", runs: 1, failed: 0 }]);
  assert.deepEqual(bars.map((bar) => bar.height), [0, 1, 0.12]);
  assert.equal(bars[1]?.failedHeight, 0.5);
  assert.equal(lastActivity({ lastUsedAt: "2026-10-27T00:00:00.000Z", outcomes: { lastRunAt: "2026-10-28T00:00:00.000Z" } }), "2026-10-28T00:00:00.000Z");
  assert.equal(lastActivity({ lastUsedAt: null, outcomes: null }), null);
});

test("a store that keeps less than the range says so", () => {
  const now = Date.parse("2026-10-28T15:00:00.000Z");
  const format = (iso: string) => iso.slice(0, 10);
  assert.equal(coverageLabel({ from: "2026-10-27T15:00:00.000Z", counts: "all" }, format, now), "Last 24 hours only");
  assert.equal(coverageLabel({ from: "2026-10-14T15:00:00.000Z", counts: "failed" }, format, now), "Failures since 2026-10-14");
  assert.equal(coverageLabel(null, format, now), null);
});
