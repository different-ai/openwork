import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addedLabel,
  clearComputerFilters,
  computerDetailPath,
  computerListPath,
  computerStatus,
  computersStateLine,
  devicePageCount,
  duplicateNameNotes,
  hasComputerFilters,
  isFormerOwner,
  ownerEmail,
  ownerLabel,
  readComputerFilters,
  relativeTime,
  staleLine,
  teamOwnerKey,
  versionLabel,
  writeComputerFilters,
} from "./computers-format";
import { computersQueryKey } from "./computers-data";

const empty = clearComputerFilters();

test("computer queries never take an organization id from the address bar", () => {
  const filters = readComputerFilters(new URLSearchParams("organizationId=other&search=Alex&kind=desktop&provider=openwork_desktop&availability=offline&page=2&instancePage=3&device=rdv_a"));
  assert.equal(computerListPath(filters), "/v1/org/computers?search=Alex&kind=desktop&provider=openwork_desktop&availability=offline&page=2&instancePage=3");
  assert.ok(!writeComputerFilters(filters).includes("organizationId"));
  assert.equal(computerDetailPath("rdv_a/b"), "/v1/org/computers/rdv_a%2Fb");
  assert.notDeepEqual(computersQueryKey("org_a", computerListPath(filters)), computersQueryKey("org_b", computerListPath(filters)));
});

test("filters validate bounded input and retain independent pagers", () => {
  const filters = readComputerFilters(new URLSearchParams("kind=invalid&provider=invalid&availability=online&page=-1&instancePage=99999"));
  assert.equal(filters.kind, "all");
  assert.equal(filters.provider, "all");
  assert.equal(filters.availability, "online");
  assert.equal(filters.page, 1);
  assert.equal(filters.instancePage, 999);
  assert.deepEqual(readComputerFilters(new URLSearchParams(writeComputerFilters({ ...empty, page: 3, instancePage: 2 }))), { ...empty, page: 3, instancePage: 2 });
  assert.equal(devicePageCount(51, 50), 2);
  assert.equal(devicePageCount(0, 50), 1);
  assert.equal(hasComputerFilters(empty), false);
  assert.equal(hasComputerFilters({ ...empty, search: "Alex" }), true);
});

test("computers not heard from in 30 days are asked for with stale=include, and only then", () => {
  assert.equal(readComputerFilters(new URLSearchParams("")).stale, false);
  assert.equal(readComputerFilters(new URLSearchParams("stale=exclude")).stale, false);
  const shown = readComputerFilters(new URLSearchParams("stale=include&kind=desktop"));
  assert.equal(shown.stale, true);
  assert.equal(computerListPath(shown), "/v1/org/computers?kind=desktop&stale=include");
  assert.equal(computerListPath(empty), "/v1/org/computers");
  // Showing them is not a filter: the header still counts the whole list.
  assert.equal(hasComputerFilters({ ...empty, stale: true }), false);
  assert.equal(staleLine(1), "1 not heard from in 30 days");
  assert.equal(staleLine(1280), "1,280 not heard from in 30 days");
});

test("an owner is a name, an address, everyone, or a former member, and never a placeholder address", () => {
  assert.equal(ownerLabel({ owner: { memberId: "member_a", name: "Alex", email: "alex@example.com" }, shared: false }), "Alex");
  assert.equal(ownerLabel({ owner: { memberId: "member_a", name: " ", email: "alex@example.com" }, shared: false }), "alex@example.com");
  assert.equal(ownerEmail({ owner: { memberId: "member_a", name: "Alex", email: "alex@example.com" }, shared: false }), "alex@example.com");
  assert.equal(ownerLabel({ owner: null, shared: true }), "Shared with your organization");
  assert.equal(ownerLabel({ owner: null, shared: false }), "Former member");

  const left = { owner: { memberId: "member_b", name: "Sam", email: "sam@example.com", former: true }, shared: false };
  assert.equal(ownerLabel(left), "Former member");
  assert.equal(ownerEmail(left), undefined);
  const placeholder = { owner: { memberId: "member_c", name: null, email: "retired-duplicate-usr_01HZX@deleted.INVALID", former: false }, shared: false };
  assert.ok(isFormerOwner(placeholder));
  assert.equal(ownerLabel(placeholder), "Former member");
  assert.equal(ownerEmail(placeholder), undefined);
  // Even with a name still attached, a placeholder address means the member is gone.
  assert.equal(ownerLabel({ owner: { name: "Old Name", email: "x@deleted.invalid" }, shared: false }), "Former member");
  assert.equal(teamOwnerKey({ owner: null, shared: true }), "shared");
  assert.equal(teamOwnerKey({ owner: { memberId: "member_a", name: null, email: null, former: false }, shared: false }), "member_a");
});

test("lists show the release and channel of a version, and say so when none was reported", () => {
  assert.equal(versionLabel("0.18.66-alpha.4137+053df1c"), "0.18.66 alpha");
  assert.equal(versionLabel("1.5.2"), "1.5.2");
  assert.equal(versionLabel("openwork-proof-1.5.2"), "openwork-proof-1.5.2");
  assert.equal(versionLabel(null), "Not reported");
  assert.equal(versionLabel("  "), "Not reported");
});

test("a status is its availability, unless the computer was disconnected", () => {
  const online = computerStatus({ availability: "online", statusDetail: null, disconnectedAt: null });
  assert.deepEqual(online, { label: "Online", tone: "success", detail: null, disconnected: false });
  assert.deepEqual(computerStatus({ availability: "needs_setup", statusDetail: " Screen Recording is off ", disconnectedAt: null }),
    { label: "Needs setup", tone: "warning", detail: "Screen Recording is off", disconnected: false });
  assert.equal(computerStatus({ availability: "unknown", statusDetail: null, disconnectedAt: null }).label, "Not checked yet");
  // Blocked on purpose is not a failure: neutral, whatever the last report said.
  assert.deepEqual(computerStatus({ availability: "online", statusDetail: "Screen Recording is off", disconnectedAt: "2026-11-10T12:00:00Z" }),
    { label: "Disconnected", tone: "neutral", detail: "Sign in on it again to reconnect", disconnected: true });
});

test("computers of one owner that share a name say when each was added", () => {
  const now = Date.parse("2026-11-10T12:00:00Z");
  const device = (id: string, label: string, owner: string, createdAt: string) => ({ id, label, owner, createdAt });
  const notes = duplicateNameNotes([
    device("a", "Jalil's MacBook Pro", "jalil", "2026-11-03T12:00:00Z"),
    device("b", "jalil's macbook pro ", "jalil", "2026-09-21T12:00:00Z"),
    device("c", "Jalil's MacBook Pro", "omar", "2026-10-01T12:00:00Z"),
    device("d", "Studio Mac", "jalil", "2025-12-24T12:00:00Z"),
  ], (entry) => entry.owner, now);
  assert.deepEqual([...notes], [["a", "Added 3 Nov"], ["b", "Added 21 Sep"]]);
  assert.equal(addedLabel("2025-12-24T12:00:00Z", now), "Added 24 Dec 2025");
  assert.equal(addedLabel("nonsense", now), null);
});

test("the line under the title says how many are online, and reads sensibly at zero and while filtered", () => {
  assert.equal(computersStateLine({ online: 6, total: 17 }), "6 of 17 online");
  assert.equal(computersStateLine({ online: 0, total: 3 }), "0 of 3 online");
  assert.equal(computersStateLine({ online: 0, total: 0 }), "No computers yet");
  assert.equal(computersStateLine({ online: 1, total: 4, filtered: true }), "4 matching computers, 1 online");
  assert.equal(computersStateLine({ online: 1, total: 1, filtered: true }), "1 matching computer, 1 online");
  assert.equal(computersStateLine({ online: 0, total: 0, filtered: true }), "No computers match");
  assert.equal(computersStateLine({ online: 1200, total: 1280 }), "1,200 of 1,280 online");
  // An API that sends no online count gets no count: only how many there are.
  assert.equal(computersStateLine({ total: 17 }), "17 computers");
  assert.equal(computersStateLine({ total: 3, filtered: true }), "3 matching computers");
});

test("contact times never imply live access", () => {
  assert.equal(relativeTime(null), "Never");
  assert.equal(relativeTime("invalid"), "Unknown");
});
