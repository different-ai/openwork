import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { runPreflight } from "../src/preflight.ts";
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
    { id: "slow", label: "slow", ok: false, detail: "timed out" },
  ]);
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
