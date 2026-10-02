import assert from "node:assert/strict";
import test from "node:test";
import { FreestyleApiError } from "freestyle";
import { deleteSnapshots, isOurs, planCleanup, type CleanupSnapshot } from "../src/cleanup.ts";
import { snapshotSlug } from "../src/index.ts";

const now = Date.parse("2026-09-25T20:00:00Z");
const hours = (value: number) => new Date(now - value * 3600_000).toISOString();
const sha = (seed: string) => seed.repeat(40).slice(0, 40);
const digest = (seed: string) => seed.repeat(40).slice(0, 40);
let counter = 0;
function snapshot(slug: string, createdHoursAgo: number, usedHoursAgo?: number): CleanupSnapshot {
  return { id: `sh-${++counter}`, slug, createdAt: hours(createdHoursAgo), lastUsedAt: usedHoursAgo === undefined ? null : hours(usedHoursAgo) };
}
const reasons = (plan: { slug: string; reason: string }[]) => Object.fromEntries(plan.map((item) => [item.slug, item.reason]));

test("old preview naming versions are reclaimed; current ones only after a day without launches", () => {
  const current = snapshotSlug(sha("a"), "acme-web");
  const old = current.replace(/-v\d+-/, "-v3-");
  const idle = snapshotSlug(sha("b"), "app-web");
  const fresh = snapshotSlug(sha("c"), "desktop");
  const plan = reasons(planCleanup([snapshot(old, 30), snapshot(current, 5), snapshot(idle, 40, 30), snapshot(fresh, 40, 3)], { now, inUse: new Set() }));
  assert.equal(plan[old], "preview from an old naming version");
  assert.equal(plan[idle], "preview not launched for a day");
  assert.equal(plan[current], undefined);
  assert.equal(plan[fresh], undefined);
});

test("anything touched in the last two hours or booted by a VM is kept", () => {
  const recent = snapshot(snapshotSlug(sha("d"), "app-web").replace(/-v\d+-/, "-v1-"), 1);
  const parent = snapshot(snapshotSlug(sha("e"), "app-web"), 80, 50);
  const plan = planCleanup([recent, parent], { now, inUse: new Set([parent.id]) });
  assert.deepEqual(plan, []);
});

test("only the most recently used layer of each kind survives once superseded for a day", () => {
  const newest = snapshot(`ow-build-v1-acme-web-${digest("1")}`, 50, 3);
  const superseded = snapshot(`ow-build-v1-acme-web-${digest("2")}`, 60, 30);
  const recentlyUsed = snapshot(`ow-build-v1-acme-web-${digest("3")}`, 60, 10);
  const otherWorld = snapshot(`ow-build-v1-app-web-${digest("4")}`, 90, 80);
  const evidenceNewest = snapshot(`ow-evidence-web-v2-${digest("5")}`, 30, 4);
  const evidenceOld = snapshot(`ow-evidence-web-v2-${digest("6")}`, 60, 40);
  const plan = reasons(planCleanup([newest, superseded, recentlyUsed, otherWorld, evidenceNewest, evidenceOld], { now, inUse: new Set() }));
  assert.deepEqual(plan, {
    [superseded.slug ?? ""]: "superseded cache layer",
    [evidenceOld.slug ?? ""]: "superseded cache layer",
  });
});

test("old evidence template versions and expired checkpoints are reclaimed", () => {
  const oldTemplate = snapshot(`ow-evidence-web-v1-${digest("7")}`, 30, 25);
  const expired = snapshot(`ow-evidence-v1-${"f".repeat(32)}`, 30);
  const live = snapshot(`ow-evidence-v1-${"e".repeat(32)}`, 10);
  const plan = reasons(planCleanup([oldTemplate, expired, live], { now, inUse: new Set() }));
  assert.equal(plan[oldTemplate.slug ?? ""], "evidence template from an old naming version");
  assert.equal(plan[expired.slug ?? ""], "expired checkpoint");
  assert.equal(plan[live.slug ?? ""], undefined);
});

test("snapshots OpenWork did not create are never planned or counted", () => {
  const personal = [snapshot("jalil-openwork-dev-1234", 500), snapshot("test-something", 500), { ...snapshot("", 500), slug: null }];
  assert.deepEqual(planCleanup(personal, { now, inUse: new Set() }), []);
  for (const item of personal) assert.equal(isOurs(item.slug), false);
  assert.equal(isOurs(snapshotSlug(sha("a"), "acme-web")), true);
});

test("deletion retries rate limits, treats already-gone as deleted, and reports other failures", async () => {
  const calls = new Map<string, number>();
  const api = { vms: { snapshots: { delete: async (id: string) => {
    const count = (calls.get(id) ?? 0) + 1;
    calls.set(id, count);
    if (id === "busy" && count < 3) throw new FreestyleApiError(429, { code: "TOO_MANY_REQUESTS", message: "busy" });
    if (id === "gone") throw new FreestyleApiError(404, { code: "NOT_FOUND", message: "gone" });
    if (id === "denied") throw new FreestyleApiError(403, { code: "FORBIDDEN", message: "denied" });
  } } } };
  const items = ["ok", "busy", "gone", "denied"].map((id) => ({ id, slug: id, reason: "test" }));
  const result = await deleteSnapshots(api, items, 2, async () => undefined);
  assert.equal(result.deleted, 3);
  assert.deepEqual(result.failed.map((failure) => failure.item.id), ["denied"]);
  assert.equal(calls.get("busy"), 3);
});
