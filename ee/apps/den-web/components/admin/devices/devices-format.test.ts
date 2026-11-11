import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ORGANIZATION_DEVICE_QUERY_KEYS,
  clearDeviceFilters,
  countLabel,
  deviceDetailPath,
  deviceListPath,
  devicePageCount,
  eventDataEntries,
  hasDeviceFilters,
  ownerLabel,
  readDeviceFilters,
  relativeTime,
  writeDeviceFilters,
} from "./devices-format";

const now = Date.parse("2026-11-10T12:00:00.000Z");
const ago = (ms: number) => new Date(now - ms).toISOString();
const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

test("relative time reads as a person would say it", () => {
  assert.equal(relativeTime(null, now), "Never");
  assert.equal(relativeTime("not a date", now), "Unknown");
  assert.equal(relativeTime(ago(20_000), now), "Just now");
  assert.equal(relativeTime(ago(-5 * minute), now), "Just now", "a computer whose clock runs ahead");
  assert.equal(relativeTime(ago(2 * minute + 30_000), now), "2 min ago");
  assert.equal(relativeTime(ago(59 * minute), now), "59 min ago");
  assert.equal(relativeTime(ago(hour), now), "1 hour ago");
  assert.equal(relativeTime(ago(23 * hour + 59 * minute), now), "23 hours ago");
  assert.equal(relativeTime(ago(day), now), "1 day ago");
  assert.equal(relativeTime(ago(3 * day + 5 * hour), now), "3 days ago");
});

test("the owner is a name, then an email, then everyone, then someone who left", () => {
  assert.equal(ownerLabel({ owner: { memberId: "mem_1", name: "Ada Lovelace", email: "ada@example.com" }, shared: false }), "Ada Lovelace");
  assert.equal(ownerLabel({ owner: { memberId: "mem_1", name: "  ", email: "ada@example.com" }, shared: false }), "ada@example.com");
  assert.equal(ownerLabel({ owner: { memberId: "mem_1", name: null, email: null }, shared: true }), "Shared with the organization");
  assert.equal(ownerLabel({ owner: null, shared: true }), "Shared with the organization");
  assert.equal(ownerLabel({ owner: null, shared: false }), "Former member");
});

test("filters are read from the address bar and unknown values are ignored", () => {
  const filters = readDeviceFilters(new URLSearchParams("organizationId=org_1&search=mac&kind=vm&provider=workbot&availability=needs_setup&problems=true&page=3&device=rdv_1"));
  assert.deepEqual(filters, { organizationId: "org_1", search: "mac", kind: "vm", provider: "workbot", availability: "needs_setup", problems: true, page: 3, device: "rdv_1" });

  const loose = readDeviceFilters(new URLSearchParams("kind=phone&provider=aws&availability=asleep&problems=yes&page=0"));
  assert.deepEqual(loose, { organizationId: "", search: "", kind: "all", provider: "all", availability: "all", problems: false, page: 1, device: "" });
  assert.equal(readDeviceFilters(new URLSearchParams("page=-2")).page, 1);
  assert.equal(readDeviceFilters(new URLSearchParams("page=1e3")).page, 1);
  assert.equal(readDeviceFilters(new URLSearchParams("page=5000")).page, 999);
  assert.equal(readDeviceFilters(new URLSearchParams(`search=${"a".repeat(400)}`)).search.length, 160);
});

test("an organization's tab keeps its own search and page beside the members list's", () => {
  const params = new URLSearchParams("search=bob&page=2&deviceSearch=studio&devicePage=4&organizationId=org_other");
  const filters = readDeviceFilters(params, ORGANIZATION_DEVICE_QUERY_KEYS, "org_1");
  assert.equal(filters.organizationId, "org_1");
  assert.equal(filters.search, "studio");
  assert.equal(filters.page, 4);

  const written = new URLSearchParams(writeDeviceFilters(params.toString(), { ...filters, search: "", page: 1, problems: true }, ORGANIZATION_DEVICE_QUERY_KEYS, true));
  assert.equal(written.get("search"), "bob");
  assert.equal(written.get("page"), "2");
  assert.equal(written.get("deviceSearch"), null);
  assert.equal(written.get("devicePage"), null);
  assert.equal(written.get("problems"), "true");
  assert.equal(written.get("organizationId"), "org_other", "the path names the organization, so this parameter is left alone");
});

test("writing filters keeps unrelated parameters and drops defaults", () => {
  const filters = readDeviceFilters(new URLSearchParams("kind=desktop&page=2&device=rdv_9"));
  assert.equal(writeDeviceFilters("returnTo=%2Fadmin&kind=vm", filters), "returnTo=%2Fadmin&kind=desktop&page=2&device=rdv_9");
  assert.equal(writeDeviceFilters("kind=vm&problems=true&page=7", clearDeviceFilters(filters)), "device=rdv_9");
  assert.equal(writeDeviceFilters("", { ...filters, device: "" , kind: "all", page: 1 }), "");
});

test("the list request carries only the filters that are on", () => {
  const none = readDeviceFilters(new URLSearchParams(""));
  assert.equal(deviceListPath(none), "/v1/admin/remote-devices");
  assert.equal(deviceListPath({ ...none, device: "rdv_1" }), "/v1/admin/remote-devices", "the open computer is not a filter");
  assert.equal(
    deviceListPath({ organizationId: "org_1", search: "  ada@example.com ", kind: "desktop", provider: "openwork_desktop", availability: "offline", problems: true, page: 2, device: "" }),
    "/v1/admin/remote-devices?organizationId=org_1&search=ada%40example.com&kind=desktop&provider=openwork_desktop&availability=offline&problems=true&page=2",
  );
  assert.equal(deviceDetailPath("rdv_a/b"), "/v1/admin/remote-devices/rdv_a%2Fb");
});

test("clear filters is offered only when something narrows the list", () => {
  const none = readDeviceFilters(new URLSearchParams("device=rdv_1"));
  assert.equal(hasDeviceFilters(none), false);
  assert.equal(hasDeviceFilters({ ...none, search: "   " }), false);
  assert.equal(hasDeviceFilters({ ...none, search: "mac" }), true);
  assert.equal(hasDeviceFilters({ ...none, problems: true }), true);
  assert.equal(hasDeviceFilters({ ...none, page: 2 }), true);
  assert.equal(hasDeviceFilters({ ...none, organizationId: "org_1" }), true);
  assert.equal(hasDeviceFilters({ ...none, organizationId: "org_1" }, true), false);
  assert.deepEqual(clearDeviceFilters({ ...none, organizationId: "org_1", kind: "vm", page: 3 }, true), { ...none, organizationId: "org_1" });
  assert.deepEqual(clearDeviceFilters({ ...none, organizationId: "org_1", availability: "online" }), none);
});

test("pages, counts and event codes", () => {
  assert.equal(devicePageCount(0, 50), 1);
  assert.equal(devicePageCount(50, 50), 1);
  assert.equal(devicePageCount(51, 50), 2);
  assert.equal(devicePageCount(10, 0), 1);
  assert.equal(countLabel(1, "computer"), "1 computer");
  assert.equal(countLabel(1280, "computer"), "1,280 computers");
  assert.deepEqual(eventDataEntries(null), []);
  assert.deepEqual(eventDataEntries({ code: "desktop_unavailable", control: false, attempts: 2, view: null }), [["code", "desktop_unavailable"], ["control", "false"], ["attempts", "2"], ["view", "none"]]);
});
