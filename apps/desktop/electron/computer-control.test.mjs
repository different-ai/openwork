import assert from "node:assert/strict";
import test from "node:test";
import { createComputerControl, COMPUTER_PROTOCOL } from "@openwork/computer-use/computer-control";

const deferred = () => {
  let resolve = () => {};
  const promise = new Promise((done) => { resolve = () => done(undefined); });
  return { promise, resolve };
};
const text = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const payload = (result) => JSON.parse(result.content.find((item) => item.type === "text").text);
function fixture(options = {}) {
  const calls = [];
  const requests = [];
  const selected = [];
  /** @type {import("@openwork/computer-use/computer-control").ComputerAdapter} */
  const adapter = {
    id: "local", label: "This computer", placement: "local",
    protocol: COMPUTER_PROTOCOL,
    setup: async () => ({ setupId: "setup" }),
    readiness: options.readiness ?? (async () => ({ readiness: "ready", detail: "Ready" })),
    connect: async ({ onClose, onUi }) => {
      calls.push("connect");
      const opened = deferred();
      return {
        callTool: async (name, args) => {
          calls.push(name);
          await options.beforeTool?.(name);
          if (name === "computer_open_session") {
            onUi({ kind: "state", id: "view", phase: "approval", appID: args.app_id, appName: "Editor", mode: args.mode, task: args.purpose, windows: [{ id: 17, title: "Draft" }, { id: 18, title: "Notes" }] });
            await opened.promise;
            onUi({ kind: "state", id: "view", phase: "working", appName: "Editor", windowTitle: "Draft", mode: args.mode });
            return text({ ok: true, session_id: "native", state: "active" });
          }
          return text({ ok: true, ...(name === "computer_observe" ? { observation_id: "observation" } : {}) });
        },
        notifyUi: async (value) => { selected.push(value); opened.resolve(); },
        close: async () => { calls.push("close"); opened.resolve(); onClose(); },
      };
    },
  };
  /** @type {import("@openwork/computer-use/computer-control").ComputerAdapter} */
  const remote = { ...adapter, id: "vm", label: "VM", placement: "remote" };
  const control = createComputerControl({ adapters: options.remote ? [adapter, remote] : [adapter], readRemoteFeatureEnabled: options.authority, onRequest: (_sessionId, value) => { requests.push(value); } });
  return { control, calls, requests, selected };
}

test("the rollout off blocks tools before connecting", async (t) => {
  const f = fixture(); t.after(() => f.control.reset(true));
  const result = await f.control.execute({ sessionId: "chat", name: "computer_discover", args: {} });
  assert.equal(payload(result).code, "computer_unavailable");
  assert.deepEqual(f.calls, []);
});

test("enabling the rollout gives a new chat access without a consent prompt", async (t) => {
  const f = fixture(); t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  assert.equal(payload(await f.control.execute({ sessionId: "chat", name: "computer_discover", args: {} })).ok, true);
  assert.deepEqual(f.requests, []);
  assert.ok(f.calls.includes("computer_discover"));
});

test("opening an app selects its window automatically and returns a fresh observation", async (t) => {
  const f = fixture(); t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  const result = await f.control.execute({ sessionId: "chat", name: "computer_open", args: { app_id: "editor", mode: "control", purpose: "Edit the draft" } });
  assert.equal(payload(result).ok, true);
  assert.deepEqual(f.selected, [{ id: "view", action: "approve", windowId: 17 }]);
  assert.ok(f.calls.includes("computer_observe"));
  assert.deepEqual(f.requests, []);
});

test("Stop ends the current task and the next turn works without asking again", async (t) => {
  const f = fixture(); t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  await f.control.execute({ sessionId: "chat", name: "computer_discover", args: {} });
  await f.control.halt({ sessionId: "chat" });
  assert.ok(f.calls.includes("close"));
  assert.equal(payload(await f.control.execute({ sessionId: "chat", name: "computer_discover", args: {} })).code, "not_allowed");
  await f.control.endTurn({ sessionId: "chat" });
  assert.equal(payload(await f.control.execute({ sessionId: "chat", name: "computer_discover", args: {} })).ok, true);
  assert.deepEqual(f.requests, []);
});

test("disable then re-enable during readiness cannot revive an old request", async (t) => {
  const probing = deferred(); const gate = deferred();
  const f = fixture({ readiness: async () => { probing.resolve(); await gate.promise; return { readiness: "ready", detail: "Ready" }; } });
  t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  const request = f.control.execute({ sessionId: "chat", name: "computer_discover", args: {} });
  await probing.promise;
  await f.control.setFeatureEnabled(false);
  await f.control.setFeatureEnabled(true);
  gate.resolve();
  assert.equal(payload(await request).code, "computer_unavailable");
  assert.deepEqual(f.calls, []);
});

test("a turn ending during an admitted tool releases the computer as soon as that tool settles", async (t) => {
  const started = deferred(); const finish = deferred();
  const f = fixture({ beforeTool: async (name) => { if (name === "computer_discover") { started.resolve(); await finish.promise; } } });
  t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  const request = f.control.execute({ sessionId: "chat", name: "computer_discover", args: {} });
  await started.promise;
  await f.control.endTurn({ sessionId: "chat" });
  finish.resolve();
  await request;
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(f.calls.includes("close"));
  assert.equal((await f.control.snapshot({ sessionId: "chat" })).enabled, true);
});

test("VMs stay hidden until the resolved rollout enables them, then run without chat consent", async (t) => {
  let authorized = false;
  const f = fixture({ remote: true, authority: async () => authorized });
  t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  assert.equal(await f.control.setRemoteEnabled(true), false);
  assert.deepEqual((await f.control.snapshot({ sessionId: "chat" })).targets.map((target) => target.id), ["local"]);
  await assert.rejects(f.control.choose({ sessionId: "chat", targetId: "vm" }), /listed computers/);
  authorized = true;
  assert.equal(await f.control.setRemoteEnabled(true), true);
  await f.control.choose({ sessionId: "chat", targetId: "vm" });
  assert.equal(payload(await f.control.execute({ sessionId: "chat", name: "computer_discover", args: {} })).ok, true);
  assert.deepEqual(f.requests, []);
  await f.control.setRemoteEnabled(false);
  assert.ok(f.calls.includes("close"));
  assert.equal((await f.control.snapshot({ sessionId: "chat" })).placement, "local");
});

test("a revoked VM rollout blocks the next tool before connecting", async (t) => {
  let authorized = true;
  const f = fixture({ remote: true, authority: async () => authorized });
  t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  await f.control.setRemoteEnabled(true);
  await f.control.choose({ sessionId: "chat", targetId: "vm" });
  authorized = false;
  const result = await f.control.execute({ sessionId: "chat", name: "computer_discover", args: {} });
  assert.equal(payload(result).code, "computer_unavailable");
  assert.deepEqual(f.calls, []);
});
