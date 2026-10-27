import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { createX11Driver } from "@openwork/computer-use/computer-x11-driver";
import { createRemoteComputerAdapter } from "@openwork/computer-use/computer-remote";

const payload = (result) => JSON.parse(result.content.find((item) => item.type === "text").text);

test("X11 screenshots are private from their first write under a permissive umask", async t => {
  const bin = await mkdtemp(join(tmpdir(), "computer-capture-test-"));
  t.after(() => rm(bin, { recursive: true, force: true }));
  await writeFile(join(bin, "import"), '#!/usr/bin/env python3\nimport pathlib,sys\np=pathlib.Path(sys.argv[-1].removeprefix("png:"))\np.write_bytes(b"private pixels")\nassert p.stat().st_mode & 0o777 == 0o600\nassert p.parent.stat().st_mode & 0o777 == 0o700\n');
  await writeFile(join(bin, "identify"), '#!/bin/sh\nprintf "100 80"\n');
  await Promise.all([chmod(join(bin, "import"), 0o700), chmod(join(bin, "identify"), 0o700)]);
  const execute = promisify(execFile);
  const driver = createX11Driver({ machine: {
    run: async (command, timeoutMs) => {
      const result = await execute("/bin/sh", ["-c", `umask 022; ${command}`], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, timeout: timeoutMs });
      return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
    },
    read: async file => {
      t.after(() => rm(dirname(file), { recursive: true, force: true }));
      assert.equal((await stat(dirname(file))).mode & 0o777, 0o700);
      assert.equal((await stat(file)).mode & 0o777, 0o600);
      return readFile(file);
    },
  } });
  const screenshot = await driver.screenshot({ x: 0, y: 0, width: 100, height: 80 });
  assert.equal(Buffer.from(screenshot.png).toString(), "private pixels");
});
const deferred = () => {
  let resolve = () => {};
  const promise = new Promise((done) => { resolve = () => done(undefined); });
  return { promise, resolve };
};
async function fixture(t, overrides = {}) {
  const inputs = [];
  const events = [];
  const region = { x: 50, y: 60, width: 400, height: 300 };
  /** @type {import("@openwork/computer-use/computer-remote").ComputerDriver} */
  const driver = {
    platform: "linux", describe: async () => ({ readiness: "ready", detail: "Ready" }),
    windows: async () => [{ id: 42, title: "Draft", app: "Editor", region }],
    screen: async () => ({ x: 0, y: 0, width: 1024, height: 768 }), focus: async () => {},
    screenshot: async () => ({ png: new Uint8Array([1]), width: 400, height: 300 }),
    input: async (steps) => { inputs.push(...steps); return { completed: steps.length }; },
    ...overrides,
  };
  const adapter = createRemoteComputerAdapter({ id: "vm", label: "VM", driver, ...(overrides.now ? { now: overrides.now } : {}) });
  const transport = await adapter.connect({ signal: new AbortController().signal, onUi: (value) => events.push(value), onClose: () => {} });
  t.after(() => transport.close());
  const sessionId = payload(await transport.callTool("computer_open_session", { app_id: "Editor", mode: "control", purpose: "Edit the draft" })).session_id;
  const active = events.find(value => value.kind === "state" && value.phase === "working");
  assert.ok(active);
  assert.ok(!events.some(value => value.phase === "approval"));
  const observe = async () => payload(await transport.callTool("computer_observe", { session_id: sessionId })).observation_id;
  const act = (observationId, actions, requestId = "request") => transport.callTool("computer_act", { session_id: sessionId, observation_id: observationId, request_id: requestId, actions });
  const interact = (action) => transport.notifyUi({ id: active.id, action });
  return { driver, transport, sessionId, inputs, events, observe, act, interact };
}

test("rapid takeover and resume never continue the old input batch", async (t) => {
  const f = await fixture(t);
  f.driver.input = async (steps) => {
    f.inputs.push(...steps);
    await f.interact("takeover");
    await f.interact("resume");
    return { completed: 1 };
  };
  const result = payload(await f.act(await f.observe(), [{ type: "click", x: 10, y: 10 }, { type: "type", text: "must not run" }]));
  assert.equal(result.status, "partial");
  assert.equal(result.completed, 1);
  assert.equal(f.inputs.length, 1);
});

test("rapid takeover and resume stop the remainder of one long typing action", async (t) => {
  const f = await fixture(t);
  f.driver.input = async (steps) => {
    f.inputs.push(...steps);
    await f.interact("takeover"); await f.interact("resume");
    return { completed: 1 };
  };
  const result = payload(await f.act(await f.observe(), [{ type: "type", text: "x".repeat(96) }]));
  assert.equal(result.status, "partial");
  assert.equal(result.may_have_acted, true);
  assert.equal(f.inputs.length, 1);
  assert.equal(f.inputs[0].text.length, 32);
});

test("an input exception retains its receipt and cannot replay input", async (t) => {
  const f = await fixture(t);
  f.driver.input = async (steps) => { f.inputs.push(...steps); throw new Error("connection lost after dispatch"); };
  const observation = await f.observe();
  const actions = [{ type: "click", x: 10, y: 10 }];
  const first = await f.act(observation, actions);
  assert.equal(payload(first).status, "partial");
  assert.equal(payload(first).may_have_acted, true);
  assert.deepEqual(await f.act(observation, actions), first);
  assert.equal(f.inputs.length, 1);
  assert.equal(payload(await f.act(observation, [{ type: "click", x: 20, y: 20 }])).code, "request_conflict");
  assert.equal(f.inputs.length, 1);
});

test("Take over during focus prevents any input even if Continue follows immediately", async (t) => {
  const f = await fixture(t);
  f.driver.focus = async () => { await f.interact("takeover"); await f.interact("resume"); };
  const result = payload(await f.act(await f.observe(), [{ type: "click", x: 10, y: 10 }]));
  assert.equal(result.status, "partial");
  assert.equal(result.may_have_acted, false);
  assert.equal(f.inputs.length, 0);
});

test("a capture interrupted by takeover cannot return an old image after Continue", async (t) => {
  const f = await fixture(t);
  const started = deferred(); const complete = deferred();
  f.driver.screenshot = async () => { started.resolve(); await complete.promise; return { png: new Uint8Array([1]), width: 400, height: 300 }; };
  const result = f.transport.callTool("computer_observe", { session_id: f.sessionId });
  await started.promise;
  await f.interact("takeover"); await f.interact("resume"); complete.resolve();
  const response = await result;
  assert.equal(response.isError, true);
  assert.equal(response.content.some((item) => item.type === "image"), false);
});

test("invalid input preserves the observation for a corrected request", async (t) => {
  const f = await fixture(t);
  const observation = await f.observe();
  assert.equal(payload(await f.act(observation, [{ type: "click", x: 400, y: 10 }])).code, "out_of_bounds");
  assert.equal(payload(await f.act(observation, [{ type: "click", x: 399, y: 10 }], "corrected")).status, "dispatched");
  assert.equal(f.inputs[0].x, 399);
  assert.equal(f.inputs.length, 1);
});

test("an invalid VM display reports readiness without crashing app construction or contacting the VM", async () => {
  let contacted = false;
  const driver = createX11Driver({ display: ":99; invalid", machine: {
    run: async () => { contacted = true; return { exitCode: 0, stdout: "", stderr: "" }; },
    read: async () => new Uint8Array(),
  } });
  const status = await driver.describe();
  assert.equal(status.readiness, "unavailable");
  assert.match(status.detail, /X display/);
  assert.equal(contacted, false);
});


test("lease expiration and idle time never resume a human takeover", async t => {
  let time = 0;
  const f = await fixture(t, { now: () => time });
  const old = await f.observe();
  await f.interact("takeover");
  time += 901_000;
  assert.equal(payload(await f.transport.callTool("computer_session_status", { session_id: f.sessionId })).state, "paused");
  assert.equal(payload(await f.act(old, [{ type: "type", text: "never" }])).code, "paused");
  await f.interact("resume");
  assert.equal(payload(await f.act(old, [{ type: "type", text: "never" }])).code, "observation_expired");
  assert.equal(payload(await f.act(await f.observe(), [{ type: "type", text: "new work" }], "fresh")).status, "dispatched");
  assert.equal(f.inputs.length, 1);
  time += 901_000;
  assert.equal(payload(await f.transport.callTool("computer_observe", { session_id: f.sessionId })).ok, true);
});

test("multiple peer windows require target resolution, not approval", async t => {
  const f = await fixture(t);
  await f.transport.callTool("computer_close_session", { session_id: f.sessionId });
  const region = { x: 0, y: 0, width: 400, height: 300 };
  f.driver.windows = async () => [ { id: 41, title: "Notes", app: "Editor", region }, { id: 42, title: "Draft", app: "Editor", region } ];
  const args = { app_id: "Editor", mode: "control", purpose: "Edit the draft" };
  assert.equal(payload(await f.transport.callTool("computer_open_session", args)).code, "window_ambiguous");
  assert.equal(payload(await f.transport.callTool("computer_open_session", { ...args, window_id: 42 })).window_id, 42);
  assert.ok(!f.events.some(value => value.phase === "approval"));
});
