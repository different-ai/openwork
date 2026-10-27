import assert from "node:assert/strict";
import test from "node:test";
import { ViewerTickets } from "./viewer-tickets.mjs";

const viewer = { view: "computer", control: true, origin: "https://viewer.example" };
test("Continue revokes unused control tickets and delayed issuance", () => {
  const tickets = new ViewerTickets();
  const generation = tickets.generation;
  const token = tickets.issue(viewer, generation);
  tickets.revoke();
  assert.equal(tickets.consume(token, viewer.origin), null);
  assert.throws(() => tickets.issue(viewer, generation), { code: "viewer_revoked" });
  const fresh = tickets.issue(viewer, tickets.generation);
  assert.equal(tickets.consume(fresh, viewer.origin).control, true);
  assert.equal(tickets.consume(fresh, viewer.origin), null);
});

test("Continue finishes after an in-flight takeover and rejects queued stale requests", async () => {
  const tickets = new ViewerTickets();
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let paused = false;
  const generation = tickets.generation;
  const takeover = tickets.run(generation, async () => { started(); await gate; paused = true; return tickets.issue(viewer, generation); });
  const failed = assert.rejects(takeover, { code: "viewer_revoked" });
  await entered;
  const stale = tickets.run(generation, () => { assert.fail("A stale takeover ran"); });
  const staleFailed = assert.rejects(stale, { code: "viewer_revoked" });
  const current = tickets.revoke();
  const continued = tickets.run(current, () => { paused = false; });
  release();
  await Promise.all([failed, staleFailed, continued]);
  assert.equal(paused, false);
  assert.equal(tickets.consume(tickets.issue(viewer, current), viewer.origin).generation, current);
});

test("Viewer tickets remain origin bound, expiring, bounded and single use", () => {
  let now = 0;
  const tickets = new ViewerTickets(() => now);
  const issue = () => tickets.issue(viewer, tickets.generation);
  const wrongOrigin = issue();
  assert.equal(tickets.consume(wrongOrigin, "https://other.example"), null);
  assert.equal(tickets.consume(wrongOrigin, viewer.origin), null);
  const expired = issue(); now = 15_000;
  assert.equal(tickets.consume(expired, viewer.origin), null);
  for (let index = 0; index < 16; index++) issue();
  assert.throws(issue, { code: "too_many_viewers" });
  now += 15_000;
  assert.ok(issue());
});
