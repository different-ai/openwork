import assert from "node:assert/strict";
import test from "node:test";
import { advance, formatElapsed, readinessRows, startTracking, visibleSteps } from "../lib/build-readiness.ts";

const t0 = Date.parse("2026-09-25T10:00:00Z");
const at = (seconds: number) => t0 + seconds * 1000;
const summary = (rows: ReturnType<typeof readinessRows>) => rows.map((row) => `${row.state}:${row.label}${row.detail ? ` ${row.detail}` : ""}`);

test("before any builder appears, the commit is being read", () => {
  assert.deepEqual(summary(readinessRows(startTracking(t0), at(12))), [
    "running:Read this commit 12s", "pending:Dependencies", "pending:Build OpenWork", "pending:Start services", "pending:Apply this commit",
  ]);
});

test("skipped layers show as cached and the running step shows its elapsed time", () => {
  let tracker = startTracking(t0);
  tracker = advance(tracker, { layer: "running-template", steps: [] }, at(20));
  tracker = advance(tracker, { layer: "running-template", steps: [{ id: "checkout", ms: 5000 }] }, at(40));
  assert.deepEqual(summary(readinessRows(tracker, at(95))), [
    "done:Read this commit 20s", "done:Dependencies cached", "done:Build OpenWork cached", "running:Start services 1m 15s", "pending:Apply this commit",
  ]);
  assert.deepEqual(tracker.steps, [{ id: "checkout", ms: 5000 }]);
});

test("progress never moves backwards when no builder is alive between layers", () => {
  let tracker = startTracking(t0);
  tracker = advance(tracker, { layer: "compiled", steps: [] }, at(10));
  tracker = advance(tracker, { steps: [] }, at(50));
  assert.equal(tracker.furthest, 2);
  tracker = advance(tracker, { layer: "world", steps: [] }, at(60));
  const rows = summary(readinessRows(tracker, at(70)));
  assert.deepEqual(rows, ["done:Read this commit 10s", "done:Dependencies cached", "done:Build OpenWork 50s", "done:Start services cached", "running:Apply this commit 10s"]);
});

test("a failed build marks the step it stopped at", () => {
  let tracker = startTracking(t0);
  tracker = advance(tracker, { layer: "running-template", steps: [] }, at(20));
  const rows = readinessRows({ ...tracker, failed: true }, at(200));
  assert.equal(rows.find((row) => row.label === "Start services")?.state, "failed");
});

test("durations read like the world CLI", () => {
  assert.equal(formatElapsed(900), "1s");
  assert.equal(formatElapsed(59_000), "59s");
  assert.equal(formatElapsed(245_000), "4m 05s");
});

test("the umbrella boot step is hidden once individual services are reported", () => {
  const appWeb = [{ id: "checkout", ms: 5000 }, { id: "boot-and-verify", ms: 20000 }];
  assert.deepEqual(visibleSteps(appWeb), appWeb);
  const acme = [...appWeb, { id: "world-services", ms: 42000 }];
  assert.deepEqual(visibleSteps(acme).map((step) => step.id), ["checkout", "world-services"]);
});
