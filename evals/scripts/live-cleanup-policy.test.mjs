import { test } from "node:test";
import assert from "node:assert/strict";
import { assertLiveCleanupCandidate } from "../worlds/live-den-cleanup.ts";

const started = "2026-09-05T00:00:00Z";
const owned = { id: "test-owned-id", createdAt: started, organizations: [], workerCount: 0 };
test("cleanup accepts a fresh account only after its resources are gone", () => {
  assert.equal(assertLiveCleanupCandidate(owned, started), owned.id);
});
test("cleanup refuses old accounts, memberships, workers and incomplete admin responses", () => {
  for (const candidate of [
    { ...owned, createdAt: "2026-09-04T00:00:00Z" },
    { ...owned, organizations: [{ id: "another-org" }] },
    { ...owned, workerCount: 1 },
    { ...owned, workerCount: undefined },
    { ...owned, organizations: undefined },
    { ...owned, createdAt: "invalid" },
    { ...owned, id: undefined },
  ]) assert.throws(() => assertLiveCleanupCandidate(candidate, started), /Refusing account cleanup/);
  assert.throws(() => assertLiveCleanupCandidate(owned, "invalid"), /Refusing account cleanup/);
});
