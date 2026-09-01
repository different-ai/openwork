import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createWorldView, detectViewMode, type ViewSink } from "../src/view.ts";

function eventTime(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

test("plain view emits stable event, ready, and failure lines without ANSI", () => {
  let output = "";
  let current = 0;
  const sink: ViewSink = { write: (text) => { output += text; }, isTTY: false };
  const view = createWorldView({ sink, mode: "plain", color: false, now: () => current });
  view.apply({ t: eventTime(0), type: "step", id: "one", label: "First", status: "start" });
  current = 1_234;
  view.apply({ t: eventTime(current), type: "step", id: "one", label: "First", status: "ok" });
  view.apply({ t: eventTime(current), type: "step", id: "two", label: "Second", status: "start" });
  view.apply({ t: eventTime(current), type: "step", id: "two", label: "Second", status: "fail", detail: "broken" });
  view.apply({ t: eventTime(current), type: "resource", kind: "tmpdir", id: "/tmp/a", label: "cache" });
  view.ready({
    name: "demo",
    outputs: { url: "http://localhost", token: "secret" },
    elapsedMs: 64_000,
    resources: 1,
    downHint: "pnpm world down demo",
    log: "/tmp/demo.log",
  });
  view.failed({
    name: "demo",
    step: "Second",
    elapsedMs: 12_340,
    lastLog: ["one", "two", "three"],
    logPath: "/tmp/demo.log",
    hint: "retry",
  });
  view.stop();

  assert.equal(output, [
    "▸ First",
    "✔ First (1.2s)",
    "▸ Second",
    "✖ Second — broken",
    "+ tmpdir  cache /tmp/a",
    "✔ demo is up (1m 04s · 1 resources)",
    "url  http://localhost",
    "token  secret",
    "Ctrl-C to stop · pnpm world down demo · log /tmp/demo.log",
    "✖ demo failed at \"Second\" (12.3s)",
    "last 3 lines of /tmp/demo.log:",
    "  one",
    "  two",
    "  three",
    "hint: retry",
    "",
  ].join("\n"));
  assert.doesNotMatch(output, /\u001b/);
});

test("ready output masks secrets and adds the reveal hint", () => {
  let output = "";
  const sink: ViewSink = { write: (text) => { output += text; }, isTTY: false };
  const view = createWorldView({ sink, mode: "plain", color: false });
  view.ready({
    name: "demo--preview",
    outputs: { url: "http://localhost", token: "s3cr3t" },
    outputMeta: { token: { secret: true } },
    elapsedMs: 100,
    resources: 0,
    downHint: "pnpm world down demo --stage preview",
    log: "/tmp/demo.log",
  });
  view.stop();
  assert.equal(output, [
    "✔ demo--preview is up (0.1s · 0 resources)",
    "url  http://localhost",
    `token  ••••••••`,
    "Ctrl-C to stop · pnpm world down demo --stage preview · log /tmp/demo.log · secrets: pnpm world outputs demo --stage preview --reveal",
    "",
  ].join("\n"));
  assert.equal(output.includes("s3cr3t"), false);
});

test("plain view emits a stalled-step heartbeat at most once per interval", async () => {
  const lines: string[] = [];
  let current = 0;
  const sink: ViewSink = {
    write: (text) => { lines.push(text.trimEnd()); },
    isTTY: false,
  };
  const view = createWorldView({
    sink,
    mode: "plain",
    color: false,
    now: () => current,
    heartbeatMs: 10,
    spinnerMs: 5,
  });
  view.apply({ t: eventTime(0), type: "step", id: "slow", label: "Slow", status: "start", log: "/tmp/slow.log" });
  current = 10;
  await delay(12);
  await delay(12);
  view.stop();
  assert.equal(lines.filter((line) => line.startsWith("…")).length, 1);
  assert.ok(lines.includes("… still waiting on \"Slow\" (<0.1s) · log /tmp/slow.log"));
});

test("tty view redraws spinner rows and collapses to ready outputs", async () => {
  let output = "";
  const sink: ViewSink = { write: (text) => { output += text; }, isTTY: true, columns: 100 };
  const view = createWorldView({ sink, mode: "tty", color: false, spinnerMs: 5, heartbeatMs: 1_000 });
  view.header({ name: "demo", receipt: "/tmp/demo.json" });
  view.apply({ t: new Date().toISOString(), type: "step", id: "one", label: "First", status: "start" });
  await delay(12);
  view.apply({ t: new Date().toISOString(), type: "step", id: "one", label: "First", status: "ok" });
  view.ready({
    name: "demo",
    outputs: { url: "http://localhost" },
    elapsedMs: 100,
    resources: 0,
    downHint: "pnpm world down demo",
  });
  view.stop();
  assert.match(output, /[◐◓◑◒] First/);
  assert.match(output, /✔ First/);
  assert.match(output, /url  http:\/\/localhost/);
  assert.match(output, /\u001b\[\d+A/);
});

test("view mode remains plain for plain, CI, no-color, and dumb terminals", () => {
  assert.deepEqual(detectViewMode({}, { plain: true }), { mode: "plain", color: false });
  assert.deepEqual(detectViewMode({ CI: "1" }, {}), { mode: "plain", color: false });
  assert.deepEqual(detectViewMode({ NO_COLOR: "" }, {}), { mode: "plain", color: false });
  assert.deepEqual(detectViewMode({ TERM: "dumb" }, {}), { mode: "plain", color: false });
});
