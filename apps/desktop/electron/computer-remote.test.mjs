import assert from "node:assert/strict";
import test from "node:test";
import { createX11Driver } from "@openwork/computer-use/computer-x11-driver";
import { createRemoteComputerAdapter } from "@openwork/computer-use/computer-remote";

const payload = (result) => JSON.parse(result.content.find((item) => item.type === "text").text);
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
  const adapter = createRemoteComputerAdapter({ id: "vm", label: "VM", driver });
  const transport = await adapter.connect({ signal: new AbortController().signal, onUi: (value) => events.push(value), onClose: () => {} });
  t.after(() => transport.close());
  const opening = transport.callTool("computer_open_session", { app_id: "Editor", mode: "control", purpose: "Edit the draft" });
  await new Promise((resolve) => setImmediate(resolve));
  const approval = events.find((value) => value.kind === "state" && value.phase === "approval");
  assert.ok(approval);
  // The broker does this automatically under the rollout, not a user prompt.
  await transport.notifyUi({ id: approval.id, action: "approve", windowId: 42 });
  const sessionId = payload(await opening).session_id;
  const observe = async () => payload(await transport.callTool("computer_observe", { session_id: sessionId })).observation_id;
  const act = (observationId, actions, requestId = "request") => transport.callTool("computer_act", { session_id: sessionId, observation_id: observationId, request_id: requestId, actions });
  const interact = (action) => transport.notifyUi({ id: approval.id, action });
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
