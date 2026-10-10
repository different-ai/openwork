import assert from "node:assert/strict";
import { test } from "node:test";
import {
  countingSinceLabel,
  failureLabel,
  filterLibraryUsage,
  lastUsedLabel,
  parseLibraryUsageKind,
  parseLibraryUsageWindow,
  summarizeLibraryUsage,
  type LibraryUsageRow,
} from "./library-usage-data";

const now = Date.parse("2026-10-08T12:00:00Z");
const day = 86_400_000;
const connectors: LibraryUsageRow[] = [
  { id: "a", name: "Linear", detail: null, pluginId: null, uses: 12, people: 4, failures: 3, lastUsedAt: new Date(now - day).toISOString() },
  { id: "b", name: "Notion", detail: null, pluginId: null, uses: 5, people: 2, failures: 0, lastUsedAt: new Date(now - 2 * day).toISOString() },
  { id: "c", name: "Jira", detail: null, pluginId: null, uses: 0, people: 0, failures: 0, lastUsedAt: null },
];
const skills: LibraryUsageRow[] = [
  { id: "s", name: "Draft reply", detail: "Support kit", pluginId: "p1", uses: 2, people: 1, failures: null, lastUsedAt: null },
];

test("Not used, Failing and the name filter each narrow the list; the name filter also matches the second line", () => {
  assert.deepEqual(filterLibraryUsage(connectors, "unused", "").map((row) => row.name), ["Jira"]);
  assert.deepEqual(filterLibraryUsage(connectors, "failing", "").map((row) => row.name), ["Linear"]);
  assert.deepEqual(filterLibraryUsage(skills, "all", "support").map((row) => row.name), ["Draft reply"]);
  assert.deepEqual(filterLibraryUsage(connectors, "unused", "linear"), []);
});

test("the summary adds uses and failures, and has no failure count for skills", () => {
  assert.deepEqual(summarizeLibraryUsage(connectors), { total: 3, used: 2, unused: 1, uses: 17, failures: 3 });
  assert.equal(summarizeLibraryUsage(skills).failures, null);
  assert.equal(failureLabel(connectors[0]!), "3 of 12");
  assert.equal(failureLabel(connectors[1]!), "0");
  assert.equal(failureLabel(skills[0]!), null);
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

test("unknown views and ranges fall back to Plugins and 30 days", () => {
  assert.equal(parseLibraryUsageKind("connectors"), "connectors");
  assert.equal(parseLibraryUsageKind("apps"), "plugins");
  assert.equal(parseLibraryUsageWindow("7"), 7);
  assert.equal(parseLibraryUsageWindow("365"), 30);
});
