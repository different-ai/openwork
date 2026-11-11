import assert from "node:assert/strict";
import { test } from "node:test";
import { clearComputerFilters, computerDetailPath, computerListPath, devicePageCount, hasComputerFilters, ownerLabel, readComputerFilters, relativeTime, writeComputerFilters } from "./computers-format";
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

test("device owner and contact labels never imply live access", () => {
  assert.equal(ownerLabel({ owner: { memberId: "member_a", name: "Alex", email: "alex@example.com" }, shared: false }), "Alex");
  assert.equal(ownerLabel({ owner: null, shared: false }), "Former member");
  assert.equal(relativeTime(null), "Never");
  assert.equal(relativeTime("invalid"), "Unknown");
});
