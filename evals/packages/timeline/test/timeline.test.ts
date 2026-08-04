import assert from "node:assert/strict";
import test from "node:test";
import { formatTimeline, resetTimeline, startSpan, timed, timeline, timelineTotals } from "../src/index.ts";

test("timed records a span even when the operation throws", async () => {
  resetTimeline();
  await assert.rejects(() => timed("boom", async () => { throw new Error("nope"); }));
  const spans = timeline();
  assert.equal(spans.length, 1);
  assert.equal(spans[0]?.label, "boom");
});

test("totals aggregate by label, slowest first", async () => {
  resetTimeline();
  startSpan("fast")();
  const slow = startSpan("slow");
  await new Promise((resolve) => setTimeout(resolve, 25));
  slow();
  startSpan("slow")();
  const totals = timelineTotals();
  assert.equal(totals[0]?.label, "slow");
  assert.equal(totals[0]?.calls, 2);
  // Timers can fire a millisecond early, so assert ordering and that time was
  // recorded — not an exact threshold.
  assert.ok(totals[0]!.totalMs > 0, JSON.stringify(totals));
  assert.ok(totals[0]!.totalMs >= (totals[1]?.totalMs ?? 0), JSON.stringify(totals));
  assert.match(formatTimeline(), /slow/);
});
