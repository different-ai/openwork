import assert from "node:assert/strict";
import { test } from "node:test";
import { countingSinceLabel, filterSkillUsage, lastUsedLabel, parseSkillUsageWindow, type SkillUsageRow } from "./skill-usage-data";

const now = Date.parse("2026-10-08T12:00:00Z");
const day = 86_400_000;
const rows: SkillUsageRow[] = [
  { skillId: "a", skillName: "Draft reply", pluginId: "p1", pluginName: "Support", uses: 12, people: 4, lastUsedAt: new Date(now - day).toISOString() },
  { skillId: "b", skillName: "Quote builder", pluginId: "p2", pluginName: "Sales", uses: 0, people: 0, lastUsedAt: null },
];

test("Not used keeps only skills with no uses, and the name filter matches skill or plugin", () => {
  assert.deepEqual(filterSkillUsage(rows, "unused", "").map((row) => row.skillId), ["b"]);
  assert.deepEqual(filterSkillUsage(rows, "all", "support").map((row) => row.skillId), ["a"]);
  assert.deepEqual(filterSkillUsage(rows, "unused", "support"), []);
});

test("the counting start shows only while it is inside the chosen window", () => {
  assert.equal(countingSinceLabel({ days: 30, trackingSince: null }, now), null);
  assert.equal(countingSinceLabel({ days: 30, trackingSince: new Date(now - 40 * day).toISOString() }, now), null);
  assert.match(countingSinceLabel({ days: 30, trackingSince: new Date(now - 3 * day).toISOString() }, now) ?? "", /^Counting since /);
});

test("last used reads as a short state", () => {
  assert.equal(lastUsedLabel(null, now), null);
  assert.equal(lastUsedLabel(new Date(now - 60_000).toISOString(), now), "Today");
  assert.equal(lastUsedLabel(new Date(now - day).toISOString(), now), "Yesterday");
  assert.equal(lastUsedLabel(new Date(now - 3 * day).toISOString(), now), "3 days ago");
});

test("an unknown window falls back to 30 days", () => {
  assert.equal(parseSkillUsageWindow("7"), 7);
  assert.equal(parseSkillUsageWindow("365"), 30);
  assert.equal(parseSkillUsageWindow(null), 30);
});
