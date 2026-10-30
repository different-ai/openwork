import assert from "node:assert/strict";
import { test } from "node:test";
import { onFor, parseAdminOrganizationFeatureUsage, sortFeatureUsage } from "./admin-organization-feature-usage";

const member = { memberId: "om_a", name: "Member A", email: "a@example.test", enabled: false, firstUsedAt: "2026-10-01T10:00:00.000Z", lastUsedAt: "2026-10-26T10:00:00.000Z", daysUsed: 4 };

test("the usage payload parses and drops feature keys this build does not know", () => {
  const usage = parseAdminOrganizationFeatureUsage({
    activeMembers: 3,
    generatedAt: "2026-10-27T00:00:00.000Z",
    features: [
      { key: "administratorRecovery", enabledMembers: 2, usedLast7Days: 1, usedLast30Days: 1, members: [member, { memberId: 7 }] },
      { key: "retiredOrFutureFeature", enabledMembers: 1, usedLast7Days: 0, usedLast30Days: 0, members: [] },
    ],
  });
  assert.ok(usage);
  assert.equal(usage.activeMembers, 3);
  assert.deepEqual(usage.features.map((feature) => feature.key), ["administratorRecovery"]);
  assert.deepEqual(usage.features[0]?.members, [member]);
  assert.equal(parseAdminOrganizationFeatureUsage({ features: "nope" }), null);
});

test("most used features come first, then most enabled, then registry order", () => {
  const base = { usedLast7Days: 0, members: [] };
  const sorted = sortFeatureUsage([
    { ...base, key: "administratorRecovery", enabledMembers: 0, usedLast30Days: 0 },
    { ...base, key: "nativeDictation", enabledMembers: 5, usedLast30Days: 0 },
    { ...base, key: "autoRouter", enabledMembers: 1, usedLast30Days: 2 },
    { ...base, key: "computerUse", enabledMembers: 0, usedLast30Days: 0 },
  ]);
  assert.deepEqual(sorted.map((feature) => feature.key), ["autoRouter", "nativeDictation", "administratorRecovery", "computerUse"]);
});

test("the on-for cell counts members in plain words", () => {
  assert.equal(onFor(3, 12), "3 of 12 members");
  assert.equal(onFor(0, 1), "0 of 1 member");
});
