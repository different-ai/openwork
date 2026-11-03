import assert from "node:assert/strict";
import { test } from "node:test";
import { FEATURES } from "@openwork/features";
import { filterFeatureUsage, groupFeatureUsage, isNewFeature, NEW_FEATURE_DAYS, splitNewFeatures, groupUsageByMember, NO_FEATURE_FILTER, onFor, parseAdminOrganizationFeatureUsage, sortFeatureUsage, turnedOnAt, type AdminFeatureUsage } from "./admin-organization-feature-usage";

const member = { memberId: "om_a", name: "Member A", email: "a@example.test", enabled: false, firstUsedAt: "2026-10-01T10:00:00.000Z", lastUsedAt: "2026-10-26T10:00:00.000Z", daysUsed: 4 };

test("the usage payload parses and drops feature keys this build does not know", () => {
  const usage = parseAdminOrganizationFeatureUsage({
    activeMembers: 3,
    generatedAt: "2026-10-27T00:00:00.000Z",
    features: [
      { key: "administratorRecovery", enabledMembers: 2, usedLast7Days: 1, usedLast30Days: 1, lastChange: { scope: "organization", action: "on", at: "2026-10-20T09:00:00.000Z", by: null }, members: [member, { memberId: 7 }] },
      { key: "retiredOrFutureFeature", enabledMembers: 1, usedLast7Days: 0, usedLast30Days: 0, members: [] },
    ],
  });
  assert.ok(usage);
  assert.equal(usage.activeMembers, 3);
  assert.deepEqual(usage.features.map((feature) => feature.key), ["administratorRecovery"]);
  assert.deepEqual(usage.features[0]?.members, [member]);
  assert.equal(usage.features[0]?.lastChange?.action, "on");
  assert.equal(parseAdminOrganizationFeatureUsage({ features: "nope" }), null);
});

test("most used features come first, then most enabled, then registry order", () => {
  const base = { usedLast7Days: 0, lastChange: null, members: [] };
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

const other = { memberId: "om_b", name: "Member B", email: "b@example.test", enabled: true, firstUsedAt: "2026-10-02T10:00:00.000Z", lastUsedAt: "2026-10-28T10:00:00.000Z", daysUsed: 2 };
const turnedOn = (at: string) => ({ scope: "organization" as const, action: "on" as const, at, by: null });
const sample: AdminFeatureUsage[] = [
  { key: "autoRouter", enabledMembers: 3, usedLast7Days: 1, usedLast30Days: 2, lastChange: turnedOn("2026-11-02T08:00:00.000Z"), members: [other, member] },
  { key: "nativeDictation", enabledMembers: 1, usedLast7Days: 0, usedLast30Days: 1, lastChange: turnedOn("2026-10-12T08:00:00.000Z"), members: [member] },
  { key: "computerUse", enabledMembers: 3, usedLast7Days: 0, usedLast30Days: 0, lastChange: null, members: [] },
  { key: "administratorRecovery", enabledMembers: 0, usedLast7Days: 0, usedLast30Days: 0, lastChange: { scope: "organization", action: "off", at: "2026-10-30T08:00:00.000Z", by: null }, members: [] },
];
const keys = (features: readonly AdminFeatureUsage[]) => features.map((feature) => feature.key);

test("filters match status, category and a feature or member search", () => {
  assert.deepEqual(keys(filterFeatureUsage(sample, NO_FEATURE_FILTER, 3)), keys(sample));
  assert.deepEqual(keys(filterFeatureUsage(sample, { ...NO_FEATURE_FILTER, status: "used" }, 3)), ["autoRouter", "nativeDictation"]);
  assert.deepEqual(keys(filterFeatureUsage(sample, { ...NO_FEATURE_FILTER, status: "unused" }, 3)), ["computerUse", "administratorRecovery"]);
  assert.deepEqual(keys(filterFeatureUsage(sample, { ...NO_FEATURE_FILTER, status: "everyone" }, 3)), ["autoRouter", "computerUse"]);
  assert.deepEqual(keys(filterFeatureUsage(sample, { ...NO_FEATURE_FILTER, status: "some" }, 3)), ["nativeDictation"]);
  assert.deepEqual(keys(filterFeatureUsage(sample, { ...NO_FEATURE_FILTER, status: "off" }, 3)), ["administratorRecovery"]);
  assert.deepEqual(keys(filterFeatureUsage(sample, { ...NO_FEATURE_FILTER, category: FEATURES.autoRouter.category }, 3)), keys(sample.filter((feature) => FEATURES[feature.key].category === FEATURES.autoRouter.category)));
  assert.deepEqual(keys(filterFeatureUsage(sample, { ...NO_FEATURE_FILTER, search: "  B@EXAMPLE " }, 3)), ["autoRouter"]);
  assert.deepEqual(keys(filterFeatureUsage(sample, { ...NO_FEATURE_FILTER, search: FEATURES.nativeDictation.label.toLowerCase() }, 3)), ["nativeDictation"]);
});

test("turned-on dates come from a change that turned the feature on and left it on", () => {
  assert.equal(turnedOnAt(sample[0]!), "2026-11-02T08:00:00.000Z");
  assert.equal(turnedOnAt(sample[2]!), null);
  assert.equal(turnedOnAt(sample[3]!), null);
  assert.equal(turnedOnAt({ ...sample[0]!, enabledMembers: 0 }), null);
  const groups = groupFeatureUsage(sample, "turnedOn");
  assert.deepEqual(groups.map((group) => [group.id, keys(group.features)]), [["2026-11", ["autoRouter"]], ["2026-10", ["nativeDictation"]], ["on", ["computerUse"]], ["off", ["administratorRecovery"]]]);
});

test("date added groups by the registry month, newest first", () => {
  const groups = groupFeatureUsage(sample, "added");
  assert.deepEqual(groups.flatMap((group) => keys(group.features)).sort(), keys(sample).sort());
  for (const group of groups) for (const feature of group.features) assert.equal(FEATURES[feature.key].added.slice(0, 7), group.id);
  assert.deepEqual(groups.map((group) => group.id), [...groups.map((group) => group.id)].sort().reverse());
});

test("grouping by member lists each person's features, most recent use first", () => {
  const people = groupUsageByMember(sample);
  assert.deepEqual(people.map((person) => [person.memberId, person.lastUsedAt, person.uses.map((use) => use.key)]), [
    ["om_b", "2026-10-28T10:00:00.000Z", ["autoRouter"]],
    ["om_a", "2026-10-26T10:00:00.000Z", ["autoRouter", "nativeDictation"]],
  ]);
  // A member search keeps all their features; a feature search keeps only matching ones.
  assert.deepEqual(groupUsageByMember(sample, "member a").map((person) => person.uses.length), [2]);
  assert.deepEqual(groupUsageByMember(sample, FEATURES.nativeDictation.label).map((person) => [person.memberId, person.uses.map((use) => use.key)]), [["om_a", ["nativeDictation"]]]);
});

test("features added in the last two weeks are new and lead the default view, newest first", () => {
  const addedOn = (key: AdminFeatureUsage["key"]) => Date.parse(`${FEATURES[key].added}T00:00:00.000Z`);
  const now = addedOn("autoRouter") + 2 * 24 * 60 * 60 * 1000;
  assert.equal(isNewFeature("autoRouter", now), true);
  assert.equal(isNewFeature("autoRouter", addedOn("autoRouter") + NEW_FEATURE_DAYS * 24 * 60 * 60 * 1000), false);
  const { fresh, rest } = splitNewFeatures(sample, now);
  assert.deepEqual(keys(fresh), keys(sample.filter((feature) => isNewFeature(feature.key, now))).sort((a, b) => FEATURES[b].added.localeCompare(FEATURES[a].added)));
  assert.ok(keys(fresh).includes("autoRouter"));
  assert.deepEqual([...keys(fresh), ...keys(rest)].sort(), keys(sample).sort());
  assert.deepEqual(keys(filterFeatureUsage(sample, { ...NO_FEATURE_FILTER, status: "new" }, 3, now)), keys(sample.filter((feature) => isNewFeature(feature.key, now))));
});
