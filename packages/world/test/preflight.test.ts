import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { checksForPlace, runPreflight, unmetRequirements, type PreflightCheck, type PreflightContext } from "../src/preflight.ts";
import { createWorldView, type ViewSink } from "../src/view.ts";

test("preflight preserves passing, failing, and timed-out check order", async () => {
  const results = await runPreflight([
    { id: "pass", label: "passing", run: async () => ({ ok: true, detail: "ready" }) },
    { id: "fail", label: "failing", run: async () => ({ ok: false, detail: "offline", hint: "start it" }) },
    { id: "slow", label: "slow", run: async () => { await delay(50); return { ok: true }; } },
  ], 10);
  assert.deepEqual(results, [
    { id: "pass", label: "passing", ok: true, detail: "ready" },
    { id: "fail", label: "failing", ok: false, detail: "offline", hint: "start it" },
    { id: "slow", label: "slow", ok: false, detail: "timed out", timedOut: true },
  ]);
});

test("requirements are scoped to placements and block only on a definite failure", async () => {
  const contexts: PreflightContext[] = [];
  const checks: PreflightCheck[] = [
    { id: "badge", label: "badge", run: async () => ({ ok: false, detail: "offline" }) },
    { id: "local-only", label: "local only", places: ["local"], run: async () => ({ ok: true }) },
    {
      id: "key", label: "key", places: ["freestyle"], blocking: true,
      run: async (context) => { contexts.push(context); return { ok: false, detail: "KEY is not set", hint: `KEY=… ${context.command}` }; },
    },
    { id: "slow-login", label: "slow login", places: ["freestyle"], blocking: true, timeoutMs: 10, run: async () => { await delay(50); return { ok: false }; } },
  ];
  assert.deepEqual(checksForPlace(checks, "local").map((check) => check.id), ["badge", "local-only"]);
  const selected = checksForPlace(checks, "freestyle");
  assert.deepEqual(selected.map((check) => check.id), ["badge", "key", "slow-login"]);
  const results = await runPreflight(selected, 5_000, { place: "freestyle", command: "pnpm world up demo --place freestyle" });
  assert.deepEqual(contexts, [{ place: "freestyle", command: "pnpm world up demo --place freestyle" }]);
  assert.deepEqual(results[1], { id: "key", label: "key", ok: false, detail: "KEY is not set", hint: "KEY=… pnpm world up demo --place freestyle", blocking: true });
  assert.deepEqual(results[2], { id: "slow-login", label: "slow login", ok: false, detail: "timed out", timedOut: true, blocking: true }, "per-check timeout wins");
  // The non-blocking badge and the timed-out login warn; only the definite key failure blocks.
  assert.deepEqual(unmetRequirements(results).map((result) => result.id), ["key"]);
});

test("view header renders preflight badges and failure guidance", () => {
  let output = "";
  const sink: ViewSink = { write: (text) => { output += text; }, isTTY: false };
  const view = createWorldView({ sink, mode: "plain", color: false });
  view.header({
    name: "demo",
    receipt: "/tmp/demo.json",
    preflight: [
      { id: "docker", label: "docker", ok: true },
      { id: "mysql", label: "mysql", ok: false, detail: "unavailable", hint: "start mysql" },
    ],
  });
  view.stop();
  assert.match(output, /preflight  docker ✔  mysql ✖\n/);
  assert.match(output, /⚠ mysql unavailable — start mysql\n/);
});

test("view header renders warnings and notes; failure renders every hint", () => {
  let output = "";
  const sink: ViewSink = { write: (text) => { output += text; }, isTTY: false };
  const view = createWorldView({ sink, mode: "plain", color: false });
  view.header({
    name: "demo",
    receipt: "/tmp/demo.json",
    preflight: [
      { id: "docker", label: "docker", ok: true },
      { id: "daytona", label: "daytona", ok: true, warning: true, detail: "personal org", hint: "use the team key" },
    ],
    notes: ["source  abc1234 (origin/dev) feat: demo", "note  recipes differ"],
  });
  assert.match(output, /preflight  docker ✔  daytona ⚠\n/);
  assert.match(output, /⚠ daytona personal org — use the team key\n/);
  assert.doesNotMatch(output, /⚠ docker/);
  assert.match(output, /source  abc1234 \(origin\/dev\) feat: demo\n/);
  assert.match(output, /note  recipes differ\n/);
  view.failed({
    name: "demo",
    step: "boot",
    elapsedMs: 1000,
    lastLog: ["boom"],
    logPath: "/tmp/demo.log",
    hint: "check the log",
    hints: ["memory limit reached — use the team key", "unauthorized — log in again"],
  });
  view.stop();
  assert.match(output, /hint: check the log\nhint: memory limit reached — use the team key\nhint: unauthorized — log in again\n/);
});
