import assert from "node:assert/strict";
import { test } from "node:test";
import {
  countingSinceLabel,
  dailyLibraryUsage,
  failureLabel,
  filterLibraryUsage,
  lastUsedLabel,
  libraryUsageBreakdownPath,
  libraryUsageMember,
  parseLibraryUsageFocus,
  parseLibraryUsageKind,
  parseLibraryUsageWindow,
  sumLibraryUsageSources,
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

test("drill-down reads one item's people or one person's items by id", () => {
  assert.equal(libraryUsageBreakdownPath("skills", 30, "member", { itemId: "cob_1" }), "/v1/library-usage?kind=skills&days=30&groupBy=member&itemId=cob_1");
  assert.equal(libraryUsageBreakdownPath("connectors", 7, "item", { memberId: "om_1" }), "/v1/library-usage?kind=connectors&days=7&groupBy=item&memberId=om_1");
  const params = (entries: Record<string, string>) => ({ get: (name: string) => entries[name] ?? null });
  assert.deepEqual(parseLibraryUsageFocus(params({ item: "cob_1" })), { itemId: "cob_1" });
  assert.deepEqual(parseLibraryUsageFocus(params({ item: "cob_1", member: "om_1" })), { memberId: "om_1" });
  assert.equal(parseLibraryUsageFocus(params({ item: " " })), null);
});

test("every day of the range is listed, oldest first, with zeros for days nobody used it", () => {
  const days = dailyLibraryUsage({ from: "2026-10-11", to: "2026-10-13", rows: [
    { itemId: null, memberId: null, date: "2026-10-12", uses: 4, people: 2, failures: 1, lastUsedAt: null, sources: { agent: 4 } },
  ] });
  assert.deepEqual(days, [
    { date: "2026-10-11", uses: 0, failures: 0 },
    { date: "2026-10-12", uses: 4, failures: 1 },
    { date: "2026-10-13", uses: 0, failures: 0 },
  ]);
});

test("sources add up across rows, most used first, and unused sources are left out", () => {
  const sources = sumLibraryUsageSources([{ sources: { agent: 2, automation: 1 } }, { sources: { agent: 1, workflow: 4 } }]);
  assert.deepEqual(sources.map((entry) => [entry.label, entry.uses]), [["Workflows", 4], ["Agents", 3], ["Automations", 1]]);
});

test("people are named from the organization; a removed member reads Former member", () => {
  const members = [{ id: "om_1", user: { name: "Alice Teammate", email: "alice@example.test" } }, { id: "om_2", user: { name: " ", email: "blair@example.test" } }];
  assert.deepEqual(libraryUsageMember(members, "om_1"), { name: "Alice Teammate", email: "alice@example.test" });
  assert.equal(libraryUsageMember(members, "om_2").name, "blair@example.test");
  assert.deepEqual(libraryUsageMember(members, "om_gone"), { name: "Former member", email: null });
});
