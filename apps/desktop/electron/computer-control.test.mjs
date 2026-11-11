import assert from "node:assert/strict";
import test from "node:test";
import { runComputerProgram } from "@openwork/computer-use/runtime";
import { createComputerControl, COMPUTER_PROTOCOL } from "@openwork/computer-use/computer-control";
import { resolvePermissionEntry } from "./computer-permission-entry.mjs";
import { createComputerScripting } from "./computer-scripting.mjs";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

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
  /** @type {(value: unknown) => void} */
  let emit = (_value) => {};
  let disconnect = () => {};
  /** @type {import("@openwork/computer-use/computer-control").ComputerAdapter} */
  const adapter = {
    id: "local", label: "This computer", placement: "local",
    protocol: COMPUTER_PROTOCOL,
    setup: async () => ({ setupId: "setup" }),
    readiness: options.readiness ?? (async () => ({ readiness: "ready", detail: "Ready" })),
    connect: async ({ onClose, onUi, background }) => {
      calls.push("connect");
      options.connected?.push({ background: background === true });
      emit = onUi; disconnect = onClose;
      let paused = false;
      return {
        callTool: async (name, args) => {
          calls.push(name);
          options.seen?.push({ name, args });
          await options.beforeTool?.(name);
          const replaced = options.toolResult?.(name);
          if (replaced) return replaced;
          if (name === "computer_open_session") {
            onUi({ kind: "state", id: "view", phase: "working", appID: args.app_id, appName: "Editor", windowTitle: "Draft", mode: args.mode, task: args.purpose });
            return text({ ok: true, session_id: "native", window_id: 17, state: "active" });
          }
          if (name === "computer_session_status") return text({ ok: true, state: paused ? "paused" : "active" });
          return text({ ok: true, ...(name === "computer_observe" ? { observation_id: "observation" } : {}) });
        },
        notifyUi: async (value) => {
          selected.push(value);
          if (value.action === "takeover" || value.action === "resume") {
            paused = value.action === "takeover";
            onUi({ kind: "state", id: "view", phase: paused ? "paused" : "working", canContinue: paused });
          }
        },
        close: async () => { calls.push("close"); await options.beforeClose?.(); onClose(); },
      };
    },
  };
  /** @type {import("@openwork/computer-use/computer-control").ComputerAdapter} */
  const remote = { ...adapter, id: "vm", label: "VM", placement: "remote" };
  const control = createComputerControl({ adapters: options.remote ? [adapter, remote] : [adapter], readRemoteFeatureEnabled: options.authority, runProgram: options.runProgram, runScript: options.runScript, onTiming: options.onTiming, browserTask: options.browserTask, onRequest: (_sessionId, value) => { requests.push(value); }, movePolicy: options.movePolicy, idleMs: options.idleMs ?? 90_000, platform: options.platform, saveFolder: options.saveFolder });
  return { control, calls, requests, selected, emit: value => emit(value), disconnect: () => disconnect() };
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

for (const remote of [false, true]) test(`${remote ? "configured remote" : "personal Mac"} opens immediately with no approval exchange`, async (t) => {
  const f = fixture({ remote, authority: async () => true }); t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  if (remote) { await f.control.setRemoteEnabled(true); await f.control.choose({ sessionId: "chat", targetId: "vm" }); }
  assert.equal(payload(await f.control.execute({ sessionId: "chat", name: "computer_open", args: { app_id: "editor", mode: "control", purpose: "Edit the draft" } })).ok, true);
  assert.deepEqual(f.selected, []);
  assert.deepEqual(f.requests, []);
  assert.ok(f.calls.includes("computer_observe"));
  await assert.rejects(f.control.interact({ sessionId: "another-chat", id: "view", action: "takeover" }), /does not own/);
});

test("follow-ups and idle cleanup renew without approvals or replaying old input", async t => {
  const f = fixture({ idleMs: 10 }); t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  await f.control.execute({ sessionId: "chat", name: "computer_open", args: { app_id: "editor", mode: "control", purpose: "Edit the draft" } });
  await f.control.endTurn({ sessionId: "chat" });
  assert.equal(payload(await f.control.execute({ sessionId: "chat", name: "computer_observe", args: {} })).ok, true);
  await new Promise(resolve => setTimeout(resolve, 35));
  const looks = f.calls.filter(name => name === "computer_observe").length;
  const result = await f.control.execute({ sessionId: "chat", name: "computer_act", args: { observation_id: "old", action: { type: "click", x: 1, y: 1 } } });
  assert.equal(payload(result).code, "observation_required");
  assert.equal(f.calls.filter(name => name === "computer_open_session").length, 3);
  assert.ok(!f.calls.includes("computer_act"));
  assert.deepEqual(f.selected, []);
  // The refusal carries a look at the renewed window, so the next call can act on it.
  const [, post, view] = result.content.map(part => JSON.parse(part.text));
  assert.deepEqual(post, { post_observation: { ok: true }, actions_replayed: false, next: "act", note: "Nothing was sent. Act on this fresh observation." });
  assert.equal(view.observation_id, "observation");
  assert.equal(f.calls.filter(name => name === "computer_observe").length, looks + 1);
});

test("human takeover survives end-of-turn and idle cleanup until Continue", async t => {
  const f = fixture({ idleMs: 10 }); t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  await f.control.execute({ sessionId: "chat", name: "computer_open", args: { app_id: "editor", mode: "control", purpose: "Edit the draft" } });
  await f.control.interact({ sessionId: "chat", id: "view", action: "takeover" });
  await f.control.endTurn({ sessionId: "chat" });
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(payload(await f.control.execute({ sessionId: "chat", name: "computer_open", args: { app_id: "editor", mode: "control", purpose: "Follow up" } })).code, "session_paused");
  assert.equal((await f.control.presentation({ sessionId: "chat", visible: true })).phase, "paused");
  assert.equal((await f.control.snapshot({ sessionId: "chat" })).session.state, "paused");
  const count = f.calls.length;
  assert.equal(payload(await f.control.execute({ sessionId: "another", name: "computer_open", args: { app_id: "editor", mode: "control", purpose: "Other work" } })).code, "computer_busy");
  assert.equal(f.calls.length, count);
  assert.equal((await f.control.snapshot({ sessionId: "another" })).busyElsewhere, true);
  await assert.rejects(f.control.interact({ sessionId: "another", id: "view", action: "resume" }), /does not own/);
  await f.control.interact({ sessionId: "chat", id: "view", action: "resume" });
  assert.equal(payload(await f.control.execute({ sessionId: "chat", name: "computer_observe", args: {} })).ok, true);
  assert.ok(!f.calls.includes("computer_act"));
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

for (const [platform, expected] of [["win32", "local"], ["darwin", "local"], ["linux", "vm"]]) test(`a new chat on ${platform} starts on ${expected === "local" ? "this computer" : "an available VM"}`, async (t) => {
  const f = fixture({ remote: true, authority: async () => true, platform }); t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  await f.control.setRemoteEnabled(true);
  assert.equal((await f.control.snapshot({ sessionId: "chat" })).targetId, expected);
});

test("changing computers preserves Stop until the next turn", async (t) => {
  const f = fixture({ remote: true, authority: async () => true });
  t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  await f.control.setRemoteEnabled(true);
  await f.control.choose({ sessionId: "chat", targetId: "local" });
  await f.control.execute({ sessionId: "chat", name: "computer_discover", args: {} });
  await f.control.halt({ sessionId: "chat" });
  const count = f.calls.length;
  for (const targetId of ["vm", "local"]) {
    assert.equal((await f.control.choose({ sessionId: "chat", targetId })).enabled, false);
    assert.equal(payload(await f.control.execute({ sessionId: "chat", name: "computer_discover", args: {} })).code, "not_allowed");
    assert.equal(f.calls.length, count);
  }
  await f.control.endTurn({ sessionId: "chat" });
  assert.equal(payload(await f.control.execute({ sessionId: "chat", name: "computer_discover", args: {} })).ok, true);
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

test("a macOS permission lost mid-chat asks in the chat again and resumes from a fresh session", async (t) => {
  let readiness = "ready";
  let revoked = false;
  const f = fixture({
    readiness: async () => ({ readiness, detail: readiness === "ready" ? "Ready" : "Computer Use needs Accessibility permission." }),
    toolResult: (name) => revoked && name === "computer_observe"
      ? { ...text({ ok: false, code: "permissions_required", message: "Grant Accessibility.", next: "human_takeover" }), isError: true } : undefined,
  });
  t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  assert.equal(payload(await f.control.execute({ sessionId: "chat", name: "computer_open", args: { app_id: "editor", mode: "control", purpose: "Edit the draft" } })).ok, true);
  revoked = true; readiness = "setup-required";
  const pending = f.control.execute({ sessionId: "chat", name: "computer_observe", args: {} });
  for (let waited = 0; !f.requests.some(Boolean) && waited < 3_000; waited += 10) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(f.requests.find(Boolean)?.appId, "editor", "the chat shows the setup card again");
  assert.ok(f.calls.includes("close"), "the helper is released so a fresh one rereads the permissions");
  revoked = false; readiness = "ready";
  const restored = payload(await pending);
  assert.equal(restored.code, "permissions_restored");
  assert.equal(restored.next, "observe");
  assert.equal(f.requests.at(-1), null);
  assert.equal(payload(await f.control.execute({ sessionId: "chat", name: "computer_observe", args: {} })).ok, true);
  assert.equal(f.calls.filter((call) => call === "computer_open_session").length, 2);
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

test("Settings reads this computer without a chat and picks the computer every chat uses", async (t) => {
  const f = fixture({ remote: true, authority: async () => true });
  t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  const before = await f.control.status();
  assert.equal(before.targetId, "local");
  assert.equal(before.readiness, "ready");
  assert.deepEqual(before.targets.map((target) => target.id), ["local"]);
  await assert.rejects(f.control.chooseComputer({ targetId: "vm" }), /listed computers/);
  await f.control.setRemoteEnabled(true);
  await f.control.choose({ sessionId: "earlier-chat", targetId: "local" });
  assert.equal((await f.control.chooseComputer({ targetId: "vm" })).targetId, "vm");
  assert.equal((await f.control.snapshot({ sessionId: "earlier-chat" })).targetId, "vm");
  assert.equal((await f.control.snapshot({ sessionId: "new-chat" })).targetId, "vm");
  await f.control.setRemoteEnabled(false);
  assert.equal((await f.control.status()).targetId, "local");
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


test("unexpected helper exit renews access but a native Stop cannot be bypassed", async t => {
  const f = fixture(); t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  const open = () => f.control.execute({ sessionId: "chat", name: "computer_open", args: { app_id: "editor", mode: "control", purpose: "Edit the draft" } });
  await open(); f.disconnect();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(payload(await f.control.execute({ sessionId: "chat", name: "computer_observe", args: {} })).ok, true);
  f.emit({ kind: "state", id: "view", phase: "closed", cause: "human_stop" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(payload(await open()).code, "not_allowed");
  assert.deepEqual(f.selected, []);
});


test("Stop racing turn cleanup is not rearmed by its late completion", async t => {
  const started = deferred(), finish = deferred();
  const f = fixture({ beforeClose: async () => { started.resolve(); await finish.promise; } });
  t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  await f.control.execute({ sessionId: "chat", name: "computer_discover", args: {} });
  const ending = f.control.endTurn({ sessionId: "chat" }); await started.promise;
  const stopping = f.control.halt({ sessionId: "chat" }); finish.resolve();
  await ending; await stopping;
  assert.equal(payload(await f.control.execute({ sessionId: "chat", name: "computer_discover", args: {} })).code, "not_allowed");
});


test("native takeover cancels browser programs and neither chat can bypass it with another surface", async t => {
  const started = deferred(); let hold = true, calls = 0;
  const f = fixture({ runProgram: runComputerProgram, browserTask: async (request, { signal }) => {
    if (request.operation === "observe") return { ok: true, observationId: "fresh", viewport: { width: 800, height: 600 }, text: "Ready", elements: [] };
    calls++;
    if (hold) {
      started.resolve();
      await new Promise((_resolve, reject) => { signal.addEventListener("abort", () => reject(signal.reason), { once: true }); });
    }
    return { ok: true, tabId: "owned" };
  } });
  t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  await f.control.execute({ sessionId: "chat", name: "computer_open", args: { app_id: "editor", mode: "control", purpose: "Edit the draft" } });
  /** @type {import("@openwork/computer-use/runtime").ProgramRequest & { sessionId: string }} */
  const input = { sessionId: "chat", surface: "browser", code: 'return await tools.ui.open({url:"https://example.com"});' };
  const program = f.control.program(input); await started.promise;
  await f.control.interact({ sessionId: "chat", id: "view", action: "takeover" });
  assert.equal((await program).ok, false);
  await f.control.endTurn({ sessionId: "chat" });
  for (const sessionId of ["chat", "another"]) {
    assert.equal((await f.control.program({ ...input, sessionId })).error.code, "computer_paused");
  }
  assert.equal(calls, 1);
  await f.control.interact({ sessionId: "chat", id: "view", action: "resume" });
  hold = false;
  assert.equal((await f.control.program(input)).ok, true);
  assert.equal(calls, 2);
});

/** Fake ps and plutil: `processes` maps pid to [parent, command]; `plists` maps an app bundle to its Info.plist values. */
function fakeExec(processes, plists) {
  return async (command, args) => {
    if (command === "/bin/ps") {
      const entry = processes[args.at(-1)];
      return { stdout: entry ? `${entry[0]} ${entry[1]}\n` : "" };
    }
    const [, key, , , , file] = args;
    const value = plists[file.slice(0, file.indexOf("/Contents/Info.plist"))]?.[key];
    if (value === undefined) throw new Error("No such key.");
    return { stdout: `${value}\n` };
  };
}

test("a packaged app that ps lists without its path still names its own bundle", async () => {
  const entry = await resolvePermissionEntry({
    pid: 4100,
    execPath: "/Applications/OpenWork.app/Contents/MacOS/OpenWork",
    exec: fakeExec({ 4100: [1, "OpenWork"] }, {
      "/Applications/OpenWork.app": { CFBundleName: "OpenWork", CFBundleIdentifier: "com.differentai.openwork" },
    }),
  });
  assert.deepEqual(entry, { name: "OpenWork", bundleId: "com.differentai.openwork", ours: true });
});

test("a development build names the terminal that started it, which is not ours to reset", async () => {
  const electron = "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron";
  const entry = await resolvePermissionEntry({
    pid: 4200,
    execPath: electron,
    exec: fakeExec({
      4200: [4199, electron],
      4199: [4198, "node"],
      4198: [4100, "-zsh"],
      4100: [1, "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal"],
    }, {
      "/repo/node_modules/electron/dist/Electron.app": { CFBundleName: "Electron", CFBundleIdentifier: "com.github.Electron" },
      "/System/Applications/Utilities/Terminal.app": { CFBundleDisplayName: "Terminal", CFBundleIdentifier: "com.apple.Terminal" },
    }),
  });
  assert.deepEqual(entry, { name: "Terminal", bundleId: "com.apple.Terminal", ours: false });
});

test("the helper bundle is its own entry, since it disclaims OpenWork's responsibility", async () => {
  const helper = "/Applications/OpenWork.app/Contents/Resources/helpers/OpenWork Computer Use.app";
  const entry = await resolvePermissionEntry({
    helperBundle: helper,
    pid: 4100,
    exec: fakeExec({ 4100: [1, "OpenWork"] }, {
      [helper]: { CFBundleDisplayName: "OpenWork Computer Use", CFBundleIdentifier: "com.differentai.openwork.computer-use" },
    }),
  });
  assert.deepEqual(entry, { name: "OpenWork Computer Use", bundleId: "com.differentai.openwork.computer-use", ours: true });
});

test("screenshot false settles the act with elements only and never reaches the native call", async (t) => {
  const seen = [];
  const f = fixture({ seen, toolResult: (name) => name === "computer_act" ? text({ ok: true, status: "dispatched", next: "observe" }) : undefined });
  t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  const opened = payload(await f.control.execute({ sessionId: "chat", name: "computer_open", args: { app_id: "editor", mode: "control", purpose: "Edit the draft" } }));
  assert.equal(opened.ok, true);
  seen.length = 0;
  const acted = await f.control.execute({ sessionId: "chat", name: "computer_act", args: { observation_id: "observation", action: { type: "key", key: "return" }, screenshot: false } });
  assert.equal(payload(acted).ok, true);
  const act = seen.find((call) => call.name === "computer_act");
  assert.equal(Object.hasOwn(act.args, "screenshot"), false);
  assert.equal(seen.find((call) => call.name === "computer_observe")?.args.include_image, false);
  assert.equal(payload(await f.control.execute({ sessionId: "chat", name: "computer_act", args: { observation_id: "observation", action: { type: "key", key: "return" }, screenshot: "no" } })).code, "invalid_arguments");
});

test("a drag longer than the helpers take keeps its shape in 32 of its own points", async (t) => {
  const seen = [];
  const f = fixture({ seen, toolResult: (name) => name === "computer_act" ? text({ ok: true, status: "dispatched", next: "observe" }) : undefined });
  t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  await f.control.execute({ sessionId: "chat", name: "computer_open", args: { app_id: "editor", mode: "control", purpose: "Draw the outline" } });
  // A closed outline: 40 points along three straight sides, back to where it started.
  const side = (from, to) => Array.from({ length: 13 }, (_, index) => ({ x: from.x + (to.x - from.x) * index / 13, y: from.y + (to.y - from.y) * index / 13 }));
  const corners = [{ x: 100, y: 600 }, { x: 400, y: 100 }, { x: 700, y: 600 }];
  const path = [...side(corners[0], corners[1]), ...side(corners[1], corners[2]), ...side(corners[2], corners[0]), corners[0]];
  const drag = (points) => f.control.execute({ sessionId: "chat", name: "computer_act", args: { observation_id: "observation", actions: [{ type: "drag", path: points }] } });

  seen.length = 0;
  const acted = await drag(path);
  const sent = seen.find((call) => call.name === "computer_act").args.actions[0].path;
  assert.equal(sent.length, 32);
  assert.ok(sent.every((point) => path.some((own) => own.x === point.x && own.y === point.y)), "only the stroke's own points");
  for (const corner of [...corners, corners[0]]) assert.ok(sent.some((point) => point.x === corner.x && point.y === corner.y), "the start, end and corners stay");
  assert.deepEqual(acted.content.map((part) => JSON.parse(part.text)).find((part) => part.drag_paths_fitted)?.drag_paths_fitted, [{ from: 40, to: 32 }]);

  seen.length = 0;
  await drag(path.slice(0, 32));
  assert.deepEqual(seen.find((call) => call.name === "computer_act").args.actions[0].path, path.slice(0, 32), "a path the helpers take is untouched");

  seen.length = 0;
  const huge = Array.from({ length: 257 }, (_, index) => ({ x: index, y: index }));
  assert.equal(payload(await drag(huge)).code, "invalid_arguments");
  assert.ok(!seen.some((call) => call.name === "computer_act"), "nothing is sent past the accepted size");
});

test("a smooth drag curves through its points and stays where they were checked", async (t) => {
  const seen = [];
  const f = fixture({ seen, toolResult: (name) => name === "computer_act" ? text({ ok: true, status: "dispatched", next: "observe" }) : undefined });
  t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  await f.control.execute({ sessionId: "chat", name: "computer_open", args: { app_id: "editor", mode: "control", purpose: "Draw a wave" } });
  // Three points of a wave: straight lines would meet at a sharp peak.
  const path = [{ x: 100, y: 400 }, { x: 300, y: 100 }, { x: 500, y: 400 }];
  seen.length = 0;
  await f.control.execute({ sessionId: "chat", name: "computer_act", args: { observation_id: "observation", action: { type: "drag", path, smooth: true } } });
  const sent = seen.find((call) => call.name === "computer_act").args.action;
  assert.equal(Object.hasOwn(sent, "smooth"), false, "the helpers never see the mark");
  assert.equal(sent.path.length, 32);
  assert.deepEqual([sent.path[0], sent.path.at(-1)], [path[0], path[2]], "it starts and ends where asked");
  assert.ok(sent.path.some((point) => point.y === 100), "it still reaches the peak");
  assert.ok(sent.path.every((point) => point.x >= 100 && point.x <= 500 && point.y >= 100 && point.y <= 400), "it never leaves the points' box");
  // Near the peak a curve is rounded: points just beside it sit above the straight lines.
  const beside = sent.path.filter((point) => Math.abs(point.x - 300) > 10 && Math.abs(point.x - 300) < 60);
  assert.ok(beside.length && beside.every((point) => point.y < 100 + Math.abs(point.x - 300) * 1.5), "the peak is rounded, not a corner");
});

test("without a screenshot choice the computer decides whether the settled view needs an image", async (t) => {
  const seen = [];
  const f = fixture({ seen, toolResult: (name) => name === "computer_act" ? text({ ok: true, status: "dispatched", next: "observe" }) : undefined });
  t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  const postRead = () => seen.find((call) => call.name === "computer_observe")?.args;
  assert.equal(payload(await f.control.execute({ sessionId: "chat", name: "computer_open", args: { app_id: "editor", mode: "control", purpose: "Edit the draft" } })).ok, true);
  assert.equal(Object.hasOwn(postRead(), "include_image"), false, "opening leaves the image to the computer");
  seen.length = 0;
  await f.control.execute({ sessionId: "chat", name: "computer_act", args: { observation_id: "observation", action: { type: "key", key: "return" } } });
  assert.equal(Object.hasOwn(postRead(), "include_image"), false, "an act without a choice leaves the image to the computer");
  seen.length = 0;
  await f.control.execute({ sessionId: "chat", name: "computer_act", args: { observation_id: "observation", action: { type: "key", key: "return" }, screenshot: true } });
  assert.equal(postRead().include_image, true, "screenshot true always asks for an image");
  seen.length = 0;
  await f.control.execute({ sessionId: "chat", name: "computer_act", args: { observation_id: "observation", action: { type: "key", key: "return" } } }, { includePostImage: false });
  assert.equal(postRead().include_image, false, "programs never receive a post-action image");
});

test("input the app gave no read-back for comes back with an image to check it by", async (t) => {
  const seen = [];
  let receipt = { ok: true, status: "dispatched", next: "observe", steps: [{ index: 0, action: "type", status: "dispatched", path: "raw_input_unverified" }] };
  const f = fixture({ seen, toolResult: (name) => name === "computer_act" ? text(receipt) : undefined });
  t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  assert.equal(payload(await f.control.execute({ sessionId: "chat", name: "computer_open", args: { app_id: "editor", mode: "control", purpose: "Edit the flyer" } })).ok, true);
  const act = (args, options) => { seen.length = 0; return f.control.execute({ sessionId: "chat", name: "computer_act", args: { observation_id: "observation", ...args } }, options); };
  const postRead = () => seen.find((call) => call.name === "computer_observe")?.args;
  await act({ action: { type: "type", text: "Come have coffee", target: "focused" } });
  assert.equal(postRead().include_image, true, "raw_input_unverified asks for an image");
  await act({ action: { type: "type", text: "Come have coffee", target: "focused" }, screenshot: false });
  assert.equal(postRead().include_image, false, "the model's screenshot choice still holds");
  receipt = { ...receipt, steps: [{ index: 0, action: "type", status: "dispatched", path: "targeted_input" }] };
  await act({ action: { type: "type", text: "Come have coffee" } });
  assert.equal(Object.hasOwn(postRead(), "include_image"), false, "verified input leaves the image to the computer");
});

test("an act refused before anything was sent returns a fresh observation instead of a retry", async (t) => {
  const seen = [];
  const unsent = { ok: false, status: "failed", completed: 0, may_have_acted: false, next: "observe" };
  let refusal = { ...unsent, code: "stale_observation", message: "The window image changed. Observe before coordinate input." };
  const f = fixture({ seen, toolResult: (name) => name === "computer_act" ? { isError: true, ...text(refusal) } : undefined });
  t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  assert.equal(payload(await f.control.execute({ sessionId: "chat", name: "computer_open", args: { app_id: "editor", mode: "control", purpose: "Draw" } })).ok, true);
  const act = (args, options) => { seen.length = 0; return f.control.execute({ sessionId: "chat", name: "computer_act", args: { observation_id: "observation", ...args } }, options); };

  const refused = await act({ action: { type: "drag", path: [{ x: 10, y: 10 }, { x: 40, y: 40 }] } });
  const [receipt, post, view] = refused.content.map((part) => JSON.parse(part.text));
  assert.equal(refused.isError, true);
  assert.equal(receipt.code, "stale_observation");
  assert.deepEqual(post, { post_observation: { ok: true }, actions_replayed: false, next: "act", note: "Nothing was sent. Act on this fresh observation." });
  assert.equal(view.observation_id, "observation");
  assert.deepEqual(seen.map((call) => call.name), ["computer_act", "computer_observe"], "the refused drag is never sent again");
  assert.equal(seen[1].args.include_image, true, "pointer steps are re-aimed from a new image");

  refusal = { ...unsent, code: "focus_required", message: "Observe a focused normal text field or control before using the keyboard." };
  await act({ action: { type: "key", key: "return" }, screenshot: false });
  assert.equal(seen[1]?.args.include_image, false, "the model's screenshot choice still holds");

  // A refusal the helper gives before any step starts carries no step status: it gets a look too.
  refusal = { ok: false, code: "observation_required", message: "A dialog opened or closed since the last observation. Observe again; nothing was sent.", next: "observe" };
  await act({ action: { type: "press", ref: "e2" } });
  assert.deepEqual(seen.map((call) => call.name), ["computer_act", "computer_observe"], "a dialog the last step opened is looked at in this call");
  refusal = { ok: false, code: "protected_input", message: "Take over for this step.", next: "human_takeover" };
  await act({ action: { type: "type", text: "x" } });
  assert.deepEqual(seen.map((call) => call.name), ["computer_act"], "a refusal that hands over gets no look");

  refusal = { ...unsent, code: "scope_denied", next: "open_session" };
  await act({ action: { type: "click", x: 1, y: 1 } });
  assert.deepEqual(seen.map((call) => call.name), ["computer_act"], "only refusals that ask for a new look get one");

  refusal = { ...unsent, code: "stale_observation" };
  await act({ action: { type: "click", x: 1, y: 1 } }, { includePostImage: false, program: true });
  assert.deepEqual(seen.map((call) => call.name), ["computer_act"], "programs observe for themselves");
});

test("after an act the model gets only changed elements, while programs and opens get the full list", async (t) => {
  const seen = [];
  let display = "0";
  const button = (ref, label, x) => ({ ref, role: "Button", label, press: true, x, y: 300, w: 48, h: 48 });
  const view = () => text({ ok: true, observation_id: "observation", window_id: 17, refs: "stable", elements_filter: "interactive", elements: [
    { ref: "e1", role: "StaticText", value: display, x: 160, y: 90, w: 60, h: 36 },
    button("e2", "1", 10), button("e3", "2", 64), button("e4", "3", 118), button("e5", "Add", 172),
  ] });
  const f = fixture({ seen, toolResult: (name) => name === "computer_observe" ? view()
    : name === "computer_act" ? (display = "12", text({ ok: true, status: "dispatched", next: "observe" })) : undefined });
  t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  const opened = await f.control.execute({ sessionId: "chat", name: "computer_open", args: { app_id: "calculator", mode: "assist", purpose: "Add", screenshot: false } });
  const openedView = opened.content.map((part) => part.type === "text" ? JSON.parse(part.text) : {}).find((value) => value.observation_id);
  assert.equal(openedView.elements.length, 5);
  assert.equal(seen.find((call) => call.name === "computer_observe")?.args.include_image, false);
  // Opening an app on this Mac lists its menu-bar commands as quick actions.
  assert.equal(seen.find((call) => call.name === "computer_observe")?.args.menus, process.platform === "darwin" ? true : undefined);
  assert.equal(Object.hasOwn(seen.find((call) => call.name === "computer_open_session").args, "screenshot"), false);

  seen.length = 0;
  const acted = await f.control.execute({ sessionId: "chat", name: "computer_act", args: { observation_id: "observation", actions: [{ type: "press", ref: "e2" }, { type: "press", ref: "e3" }], screenshot: false, pacing: "wait_retry", retry_ms: 800, input: "real" } });
  const native = seen.find((call) => call.name === "computer_act").args;
  assert.equal(native.pacing, "wait_retry");
  assert.equal(native.retry_ms, 800);
  assert.equal(native.input, "real", "the agent can ask for real input in any app");
  assert.equal(seen.find((call) => call.name === "computer_observe")?.args.menus, undefined, "menus are listed on open, not after every act");
  const changes = acted.content.map((part) => part.type === "text" ? JSON.parse(part.text) : {}).find((value) => value.observation_id);
  assert.equal(changes.elements_listing, "changes");
  assert.deepEqual(changes.elements, [{ ref: "e1", role: "StaticText", value: "12", x: 160, y: 90, w: 60, h: 36 }]);
  assert.equal(changes.elements_unchanged, 4);

  // A program reads every element itself.
  const program = await f.control.execute({ sessionId: "chat", name: "computer_act", args: { observation_id: "observation", action: { type: "press", ref: "e4" } } }, { includePostImage: false, program: true });
  const full = program.content.map((part) => part.type === "text" ? JSON.parse(part.text) : {}).find((value) => value.observation_id);
  assert.equal(full.elements.length, 5);
  assert.equal(full.elements_listing, undefined);
});

test("change listing falls back to the full list on another window, filter or a mostly new list", async () => {
  const { listChanges } = await import("@openwork/computer-use/computer-control");
  const part = (value) => [{ type: "text", text: JSON.stringify({ observation_id: "o", refs: "stable", window_id: 1, elements_filter: "all", ...value }) }];
  const first = listChanges(null, part({ elements: [{ ref: "e1", label: "A" }, { ref: "e2", label: "B" }, { ref: "e3", label: "C" }] }));
  const shown = (result) => JSON.parse(result.content[0].text);
  assert.equal(shown(first).elements.length, 3);
  assert.equal(shown(listChanges(first.listing, part({ window_id: 2, elements: [{ ref: "e1", label: "A" }] }))).elements_listing, undefined);
  assert.equal(shown(listChanges(first.listing, part({ elements_filter: "interactive", elements: [{ ref: "e1", label: "A" }] }))).elements_listing, undefined);
  assert.equal(shown(listChanges(first.listing, part({ elements: [{ ref: "e4", label: "D" }, { ref: "e5", label: "E" }, { ref: "e3", label: "C" }] }))).elements_listing, undefined);
  const six = ["A", "B", "C", "D", "E", "F"].map((label, index) => ({ ref: `e${index + 1}`, label }));
  const before = listChanges(null, part({ elements: six }));
  const removed = shown(listChanges(before.listing, part({ elements: [...six.filter((element) => element.ref !== "e2"), { ref: "e9", label: "Z" }] })));
  assert.deepEqual(removed.elements_removed, ["e2"]);
  assert.deepEqual(removed.elements, [{ ref: "e9", label: "Z" }]);
  assert.equal(removed.elements_unchanged, 5);
  const unstable = [{ type: "text", text: JSON.stringify({ observation_id: "o", elements: [{ ref: "e1" }] }) }];
  assert.equal(listChanges(first.listing, unstable).listing, null);
});

test("each step records computer time and the model's time since the previous step", async (t) => {
  const steps = [];
  const f = fixture({ onTiming: (_sessionId, step) => steps.push(step) }); t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  await f.control.execute({ sessionId: "chat", name: "computer_discover", args: {} });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await f.control.execute({ sessionId: "chat", name: "computer_discover", args: {} });
  assert.equal(steps.length, 2);
  assert.equal(steps[0].modelMs, undefined);
  assert.ok(steps[1].modelMs >= 15);
  const snapshot = await f.control.snapshot({ sessionId: "chat" });
  assert.equal(snapshot.timing.steps, 2);
  await f.control.endTurn({ sessionId: "chat" });
  await f.control.execute({ sessionId: "chat", name: "computer_discover", args: {} });
  assert.equal(steps[2].modelMs, undefined, "a new turn's first step is not timed against the last turn");
});

/** Waits for the script request showing `code` and returns it. */
async function scriptRequest(f, code) {
  for (let waited = 0; waited < 2_000; waited += 5) {
    const request = f.requests.findLast((value) => value?.reason === "script" && value.script.code === code);
    if (request) return request;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("No script request was shown.");
}

test("scripts run under the computer use flag and the chat's access, on this Mac only, without a question", async (t) => {
  const ran = [];
  const f = fixture({ remote: true, authority: async () => true, runScript: async (request) => { ran.push(request); return { ok: true, stdout: "done" }; } });
  t.after(() => f.control.reset(true));
  assert.equal((await f.control.script({ sessionId: "chat", app: "applescript", code: "return 1" })).error.code, "computer_unavailable");
  await f.control.setFeatureEnabled(true);
  assert.equal((await f.control.script({ sessionId: "chat", app: "terminal", code: "ls" })).error.code, "invalid_arguments");
  assert.deepEqual(await f.control.script({ sessionId: "chat", app: "applescript", code: "return 1" }), { ok: true, stdout: "done" });
  assert.deepEqual(ran, [{ app: "applescript", code: "return 1", timeoutMs: 30_000 }]);
  assert.equal(f.requests.filter((request) => request?.reason === "script").length, 0, "computer use being on is the person's yes");
  await f.control.setRemoteEnabled(true);
  await f.control.choose({ sessionId: "chat", targetId: "vm" });
  assert.equal((await f.control.script({ sessionId: "chat", app: "jxa", code: "1" })).error.code, "script_unavailable");
  assert.equal(ran.length, 1);
});

test("turning computer use off stops a running script and one waiting for the organization's question", async (t) => {
  const ran = [];
  let release = () => {};
  const f = fixture({ runScript: async (request, signal) => {
    ran.push(request.code);
    if (request.code !== "slow") return { ok: true };
    await new Promise((resolve, reject) => { release = () => resolve(undefined); signal.addEventListener("abort", () => reject(signal.reason), { once: true }); });
    return { ok: true };
  } });
  t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  const waiting = f.control.script({ sessionId: "chat", app: "blender", code: "result = 1" }, { approveEachScript: true });
  await scriptRequest(f, "result = 1");
  const running = f.control.script({ sessionId: "other", app: "jxa", code: "slow" });
  for (let waited = 0; !ran.includes("slow") && waited < 2_000; waited += 5) await new Promise((resolve) => setTimeout(resolve, 5));
  await f.control.setFeatureEnabled(false);
  assert.equal((await waiting).error.code, "script_declined", "a pending approval ends when computer use is turned off");
  assert.equal((await running).error.code, "script_failed", "a running script is stopped");
  release();
  assert.deepEqual(ran, ["slow"]);
});

test("organization ask shows every exact script, runs only on Run and never remembers an answer", async (t) => {
  const ran = [];
  const f = fixture({ runScript: async input => { ran.push(input.code); return { ok: true }; } });
  t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  const declined = f.control.script({ sessionId: "chat", app: "jxa", code: "first" }, { approveEachScript: true });
  const asked = await scriptRequest(f, "first");
  assert.deepEqual(asked.script, { app: "jxa", code: "first" }, "the person sees the exact full script");
  assert.equal(asked.standing, false);
  assert.deepEqual(ran, [], "nothing runs before the answer");
  assert.deepEqual(f.control.pendingRequest({ sessionId: "chat" }), asked, "another surface reads the request the card shows");
  assert.equal(f.control.pendingRequest({ sessionId: "never-used" }), null);
  await assert.rejects(f.control.answerRequest({ sessionId: "chat", answer: "allow", id: "another-request" }), /changed/);
  await f.control.answerRequest({ sessionId: "chat", answer: "dismiss", id: asked.id });
  assert.equal((await declined).error.code, "script_declined");
  assert.equal(f.control.pendingRequest({ sessionId: "chat" }), null);
  for (const code of ["second", "third"]) {
    const pending = f.control.script({ sessionId: "chat", app: "jxa", code }, { approveEachScript: true });
    const request = await scriptRequest(f, code);
    assert.equal(request.standing, false);
    await f.control.answerRequest({ sessionId: "chat", answer: "allow", id: request.id });
    assert.equal((await pending).ok, true);
  }
  assert.equal(f.requests.at(-1), null);
  assert.deepEqual(ran, ["second", "third"]);
});

/** A fake osascript: records its arguments and stdin, then exits as told. */
function fakeOsascript(result) {
  const runs = [];
  const spawn = (command, args) => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: () => true });
    let input = "";
    child.stdin.on("data", (chunk) => { input += chunk; });
    child.stdin.on("finish", () => {
      runs.push({ command, args, input });
      if (result.stdout) child.stdout.end(result.stdout); else child.stdout.end();
      if (result.stderr) child.stderr.end(result.stderr); else child.stderr.end();
      setImmediate(() => child.emit("close", result.status));
    });
    return child;
  };
  return { spawn, runs };
}

test("AppleScript and JXA run through osascript, and a missing Automation grant says where to allow it", async () => {
  const signal = new AbortController().signal;
  const ok = fakeOsascript({ status: 0, stdout: "Inbox\n" });
  const script = createComputerScripting({ platform: "darwin", stateDir: "/tmp/unused", bridgeScript: "/bridge.py", spawn: ok.spawn });
  assert.deepEqual(await script({ app: "jxa", code: "Application('Mail').name()", timeoutMs: 5_000 }, signal), { ok: true, stdout: "Inbox" });
  assert.deepEqual(ok.runs, [{ command: "/usr/bin/osascript", args: ["-l", "JavaScript", "-"], input: "Application('Mail').name()" }]);
  const denied = fakeOsascript({ status: 1, stderr: "execution error: Not authorized to send Apple events to Mail. (-1743)" });
  const blocked = await createComputerScripting({ platform: "darwin", stateDir: "/tmp/unused", bridgeScript: "/bridge.py", spawn: denied.spawn })({ app: "applescript", code: "tell application \"Mail\" to count messages of inbox", timeoutMs: 5_000 }, signal);
  assert.equal(blocked.error.code, "automation_denied");
  assert.match(blocked.error.message, /Privacy & Security › Automation/);
  assert.equal((await createComputerScripting({ platform: "linux", stateDir: "/tmp/unused", bridgeScript: "/bridge.py" })({ app: "applescript", code: "1", timeoutMs: 5_000 }, signal)).error.code, "script_unavailable");
});

test("A failed script always says why, and an app macOS quit says how to start it again", async () => {
  const signal = new AbortController().signal;
  const run = (stderr, status = 1) => createComputerScripting({ platform: "darwin", stateDir: "/tmp/unused", bridgeScript: "/bridge.py", spawn: fakeOsascript({ status, stderr }).spawn })
    ({ app: "applescript", code: "tell application \"TextEdit\" to make new document", timeoutMs: 5_000 }, signal);
  const quit = await run("30:105: execution error: TextEdit got an error: Application isn’t running. (-600)");
  assert.equal(quit.ok, false);
  assert.equal(quit.error.code, "app_not_running");
  assert.match(quit.error.message, /Application isn’t running/, "macOS's own words stay");
  assert.match(quit.error.message, /computer_open/);
  const other = await run("12:20: syntax error: Expected end of line. (-2741)");
  assert.equal(other.error.code, "script_error");
  assert.match(other.error.message, /Expected end of line/);
  assert.match((await run("", 2)).error.message, /status 2/, "even with nothing on stderr");
});

test("Blender scripts reach the bridge with its token, and an open Blender without the bridge is not relaunched", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "ow-script-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const signal = new AbortController().signal;
  const unbridged = createComputerScripting({ platform: "darwin", stateDir, bridgeScript: "/bridge.py", blenderRunning: async () => true, locateBlender: async () => { throw new Error("must not launch"); } });
  await assert.rejects(unbridged({ app: "blender", code: "result = 1", timeoutMs: 5_000 }, signal), /already open without OpenWork's script bridge/);
  await writeFile(join(stateDir, "blender.token"), "secret-token");
  const received = [];
  const bridge = createServer((socket) => {
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk;
      if (!data.endsWith("\n")) return;
      const request = JSON.parse(data);
      received.push(request);
      if (request.code !== "hang") socket.end(`${JSON.stringify({ ok: true, result: 3, stdout: "" })}\n`);
    });
  });
  await new Promise((resolve) => { bridge.listen(join(stateDir, "blender.sock"), () => resolve(undefined)); });
  t.after(() => new Promise((resolve) => bridge.close(resolve)));
  const script = createComputerScripting({ platform: "darwin", stateDir, bridgeScript: "/bridge.py", blenderRunning: async () => true });
  assert.deepEqual(await script({ app: "blender", code: "result = len(bpy.data.objects)", timeoutMs: 5_000 }, signal), { ok: true, result: 3, stdout: "" });
  assert.deepEqual(received, [{ token: "secret-token", code: "result = len(bpy.data.objects)", timeoutMs: 5_000 }]);
  const stop = new AbortController();
  const hanging = script({ app: "blender", code: "hang", timeoutMs: 5_000 }, stop.signal);
  for (let waited = 0; received.length < 2 && waited < 2_000; waited += 5) await new Promise((resolve) => setTimeout(resolve, 5));
  stop.abort();
  await assert.rejects(hanging, /stopped/);
  for (let waited = 0; received.length < 3 && waited < 2_000; waited += 5) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(received.at(-1), { token: "secret-token", cancel: true }, "stopping asks Blender to stop the script");
});

/** A computer whose helper locks each window: every native call is logged as app:tool:start/end. */
function parallelFixture(options = {}) {
  const events = [];
  let connections = 0;
  /** The connect options each helper started with. */
  const started = [];
  /** Who each helper's cursor says is acting. */
  const presences = [];
  const windows = { blender: 11, photoshop: 12, notes: 13, maps: 14, powerpoint: 15 };
  /** Each app's helper's UI channel, to stand in for its pill. */
  const uis = {};
  /** @type {import("@openwork/computer-use/computer-control").ComputerAdapter} */
  const adapter = {
    id: "local", label: "This Mac", placement: "local", parallel: true, protocol: COMPUTER_PROTOCOL,
    setup: async () => ({ setupId: "setup" }),
    readiness: async () => ({ readiness: "ready", detail: "Ready" }),
    connect: async ({ onUi, onClose, background, presence }) => {
      connections++;
      started.push({ background: background === true });
      presences.push(presence);
      let app = "";
      return {
        callTool: async (name, args) => {
          if (name === "computer_open_session") { app = String(args.app_id); uis[app] = onUi; options.onOpen?.(args); }
          events.push(`${app}:${name}:start`);
          await options.beforeTool?.(name, app);
          events.push(`${app}:${name}:end`);
          if (name === "computer_open_session") {
            onUi({ kind: "state", id: `view-${app}`, phase: "working", appID: app, appName: app, windowTitle: app, mode: args.mode, task: args.purpose });
            return text({ ok: true, session_id: `native-${app}`, window_id: args.window_id ?? windows[app], state: "active",
              delivery: options.delivery?.(app) ?? "foreground" });
          }
          if (name === "computer_session_status") return text({ ok: true, state: "active" });
          if (name === "computer_act") return options.act?.(app, args) ?? text({ ok: true, status: "dispatched" });
          return text({ ok: true, ...(name === "computer_observe" ? { observation_id: `observation-${app}` } : {}) });
        },
        notifyUi: async (value) => {
          options.onNotify?.(app, value);
          if (value.action === "takeover") onUi({ kind: "state", id: `view-${app}`, phase: "paused", canContinue: true });
          if (value.action === "resume") onUi({ kind: "state", id: `view-${app}`, phase: "working" });
        },
        close: async () => { events.push(`${app}:close`); onClose(); },
      };
    },
  };
  const control = createComputerControl({ adapters: [adapter], ...options.control });
  return { control, events, started, presences, connections: () => connections, ui: (app, value) => uis[app](value) };
}
const openApp = (control, sessionId, app, mode = "control", windowId) =>
  control.execute({ sessionId, name: "computer_open", args: { app_id: app, mode, purpose: `Work in ${app}`, ...(windowId ? { window_id: windowId } : {}) } });
const click = (control, sessionId, options) =>
  control.execute({ sessionId, name: "computer_act", args: { observation_id: "observation", action: { type: "click", x: 1, y: 1 } } }, options);
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test("on a parallel computer two chats each control their own window at the same time", async (t) => {
  const f = parallelFixture(); t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  assert.equal(payload(await openApp(f.control, "chat-blender", "blender")).ok, true);
  assert.equal(payload(await openApp(f.control, "chat-photoshop", "photoshop")).ok, true);
  assert.equal(f.connections(), 2, "each chat has its own helper session");
  const [blender, photoshop] = await Promise.all([click(f.control, "chat-blender"), click(f.control, "chat-photoshop")]);
  assert.equal(payload(blender).status, "dispatched");
  assert.equal(payload(photoshop).status, "dispatched");
  assert.equal((await f.control.snapshot({ sessionId: "chat-photoshop" })).busyElsewhere, false);
});

test("a window another chat holds is refused before any helper starts", async (t) => {
  const f = parallelFixture(); t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  await openApp(f.control, "chat-blender", "blender");
  const result = payload(await openApp(f.control, "chat-other", "blender", "control", 11));
  assert.equal(result.code, "window_busy");
  assert.equal(f.connections(), 1);
});

test("the chat the person watches works in view, beside OpenWork, and other chats in the background", async (t) => {
  const opens = [];
  const notes = [];
  const f = parallelFixture({ onOpen: (args) => opens.push(args), onNotify: (app, value) => { if (value.action === "watch") notes.push([app, value]); } });
  t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  f.control.follow({ sessionId: "chat", watching: true });
  await openApp(f.control, "chat", "blender");
  await openApp(f.control, "other-chat", "notes");
  assert.deepEqual([opens[0].following, opens[0].beside], [true, true], "the watched chat's app opens in view, beside OpenWork");
  assert.deepEqual([opens[1].following, opens[1].beside], [false, true], "a chat not on screen opens in the background");
  // A second app in the watched chat follows too, and the agent arranges the two itself.
  await openApp(f.control, "chat", "photoshop");
  assert.deepEqual([opens[2].following, opens[2].beside], [true, false]);
  assert.deepEqual(notes.find(([app]) => app === "blender"), ["blender", { id: "view-blender", action: "watch", following: true, beside: false }]);
  // Another thread selected: each of the chat's helpers hears it once, and the other chat nothing.
  notes.length = 0;
  f.control.follow({ sessionId: "chat", watching: false });
  f.control.follow({ sessionId: "chat", watching: false });
  assert.deepEqual(notes.map(([app, value]) => [app, value.following]).sort(), [["blender", false], ["photoshop", false]]);
  assert.throws(() => f.control.follow({ sessionId: "chat", watching: "yes" }), /required/);
  assert.throws(() => f.control.follow({ sessionId: "chat", watching: true, beside: true }), /required/);
});

test("subagents follow along while the person watches their chat, taking turns at the keyboard there", async (t) => {
  const opens = [];
  const notes = [];
  let hold = null;
  const f = parallelFixture({ delivery: () => "background", onOpen: (args) => opens.push(args),
    onNotify: (app, value) => { if (value.action === "watch") notes.push([app, value]); },
    beforeTool: async (name, app) => { if (name === "computer_act" && app === "maps" && hold) await hold.promise; } });
  t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  const agent = (sessionId, name, args) => f.control.execute({ sessionId, rootSessionId: "chat", name, args });
  const open = (sessionId, app) => agent(sessionId, "computer_open", { app_id: app, mode: "control", purpose: `Work in ${app}` });
  const act = (sessionId) => agent(sessionId, "computer_act", { observation_id: "observation", action: { type: "click", x: 1, y: 1 } });
  const started = (app) => f.events.filter((event) => event === `${app}:computer_act:start`).length;
  f.control.setParallelAgents(true);
  f.control.follow({ sessionId: "chat", watching: true });
  await open("maps-agent", "maps");
  assert.deepEqual([opens[0].following, opens[0].beside], [true, true], "the watched chat's only app opens in view, beside OpenWork");
  await open("slides-agent", "powerpoint");
  assert.deepEqual([opens[1].following, opens[1].beside], [true, false], "with two agents' apps open, neither goes beside on its own");
  assert.deepEqual(notes.find(([app]) => app === "maps")?.[1], { id: "view-maps", action: "watch", following: true, beside: false, stage_slot: 0, stage_count: 2 });
  // In view, the agents take turns at the keyboard and pointer, one whole call at a time.
  hold = deferred();
  const first = act("maps-agent"); await settle();
  const second = act("slides-agent"); await settle();
  assert.equal(started("powerpoint"), 0, "the other agent waits for its turn");
  hold.resolve(); await Promise.all([first, second]);
  assert.ok(f.events.indexOf("maps:computer_act:end") < f.events.indexOf("powerpoint:computer_act:start"));
  // Another thread selected: every agent's helper hears it, and they work in the background at the same time.
  notes.length = 0;
  f.control.follow({ sessionId: "chat", watching: false });
  assert.deepEqual(notes.map(([app, value]) => [app, value.following]).sort(), [["maps", false], ["powerpoint", false]]);
  hold = deferred();
  const third = act("maps-agent"); await settle();
  const fourth = act("slides-agent"); await settle();
  assert.equal(started("powerpoint"), 2, "out of view, neither waits for the other");
  hold.resolve(); await Promise.all([third, fourth]);
});

test("with parallel computer use off, watching the chat leaves its subagents in the background, as before", async (t) => {
  const opens = [];
  const f = parallelFixture({ onOpen: (args) => opens.push(args) }); t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  f.control.follow({ sessionId: "chat", watching: true });
  await f.control.execute({ sessionId: "maps-agent", rootSessionId: "chat", name: "computer_open", args: { app_id: "maps", mode: "control", purpose: "Find it" } });
  assert.deepEqual([opens[0].following, opens[0].beside], [false, true]);
});

test("while the person watches, the chat's agents' windows share one stage that re-tiles as apps open and close", async (t) => {
  const opens = [];
  const notes = [];
  const f = parallelFixture({ onOpen: (args) => opens.push(args), onNotify: (app, value) => { if (value.action === "watch") notes.push([app, value]); } });
  t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  f.control.setParallelAgents(true);
  const open = (sessionId, app) => f.control.execute({ sessionId, rootSessionId: "chat", name: "computer_open", args: { app_id: app, mode: "control", purpose: `Work in ${app}` } });
  const stage = (value) => [value.stage_slot, value.stage_count];
  const last = (app) => notes.filter(([name]) => name === app).at(-1)?.[1];
  f.control.follow({ sessionId: "chat", watching: true });
  await open("maps-agent", "maps");
  assert.deepEqual([opens[0].beside, opens[0].stage_count], [true, 0], "one agent alone goes beside OpenWork");
  await open("slides-agent", "powerpoint");
  assert.deepEqual(stage(opens[1]), [1, 2]);
  assert.deepEqual(stage(last("maps")), [0, 2], "the first agent's window moves to its tile");
  await open("photo-agent", "photoshop");
  assert.deepEqual(stage(opens[2]), [2, 3]);
  assert.deepEqual([stage(last("maps")), stage(last("powerpoint"))], [[0, 3], [1, 3]]);
  // An agent closes its app: the others re-tile.
  await f.control.execute({ sessionId: "slides-agent", rootSessionId: "chat", name: "computer_close", args: {} });
  assert.deepEqual([stage(last("maps")), stage(last("photoshop"))], [[0, 2], [1, 2]]);
  // Out of view nothing is staged, so nothing moves.
  f.control.follow({ sessionId: "chat", watching: false });
  assert.deepEqual([last("maps").stage_count, last("photoshop").stage_count], [0, 0]);
  // With parallel computer use off, no stage at all.
  f.control.setParallelAgents(false);
  f.control.follow({ sessionId: "maps-agent", watching: true });
  assert.equal("stage_count" in last("maps"), false);
});

test("the chat's crew lists each subagent with its cursor, app, state, latest step and a live frame", async (t) => {
  let hold = null;
  const f = parallelFixture({ beforeTool: async (name, app) => { if (name === "computer_act" && app === "maps" && hold) await hold.promise; } });
  t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  const agent = (sessionId, agentName, name, args) => f.control.execute({ sessionId, rootSessionId: "chat", agentName, name, args });
  const act = (sessionId, agentName, intent) => agent(sessionId, agentName, "computer_act", { observation_id: "observation", action: { type: "click", x: 1, y: 1 }, intent });
  assert.deepEqual(await f.control.crew({ sessionId: "chat" }), [], "nothing before any agent works");
  f.control.setParallelAgents(true);
  await agent("maps-agent", "Maps", "computer_open", { app_id: "maps", mode: "control", purpose: "Find the place" });
  await agent("slides-agent", "Slides", "computer_open", { app_id: "powerpoint", mode: "control", purpose: "Title slide" });
  await act("maps-agent", "Maps", "searching for the café");
  const rows = (list) => list.map(({ name, app, state, intent }) => [name, app, state, intent]);
  assert.deepEqual(rows(await f.control.crew({ sessionId: "chat" })), [["Maps", "maps", "working", "searching for the café"], ["Slides", "powerpoint", "working", null]]);
  const [maps, slides] = await f.control.crew({ sessionId: "chat" });
  assert.notEqual(maps.color, slides.color);
  // In view, one agent waits for its turn at the keyboard while the other acts.
  f.control.follow({ sessionId: "chat", watching: true });
  hold = deferred();
  const first = act("maps-agent", "Maps", "zooming in"); await settle();
  const second = act("slides-agent", "Slides", "typing the title"); await settle();
  assert.deepEqual((await f.control.crew({ sessionId: "chat" })).map((row) => row.state), ["working", "waiting"]);
  hold.resolve(); await Promise.all([first, second]);
  hold = null;
  // A thumbnail: asking streams frames, and the newest one comes back.
  await f.control.crew({ sessionId: "chat", thumbnails: true });
  f.ui("maps", { kind: "frame", id: "view-maps", sequence: 1, capturedAt: 1, width: 4, height: 3, mimeType: "image/png", data: "iVBORw0KGgoAAAAA" });
  const watched = await f.control.crew({ sessionId: "chat", thumbnails: true });
  assert.deepEqual(watched[0].frame, { mimeType: "image/png", data: "iVBORw0KGgoAAAAA", width: 4, height: 3 });
  assert.equal(watched[1].frame, undefined);
  // Take over in the chat pauses every agent for the person.
  await f.control.interact({ sessionId: "chat", id: "view-maps", action: "takeover" });
  assert.deepEqual((await f.control.crew({ sessionId: "chat" })).map((row) => row.state), ["paused", "paused"]);
  await f.control.interact({ sessionId: "chat", id: "view-maps", action: "resume" });
  // An agent whose turn ended is done.
  await f.control.endTurn({ sessionId: "slides-agent" });
  assert.deepEqual((await f.control.crew({ sessionId: "chat" })).map((row) => row.state), ["working", "done"]);
  assert.deepEqual(await f.control.crew({ sessionId: "maps-agent" }), [], "a subagent's own thread has no crew");
  f.control.setParallelAgents(false);
  assert.deepEqual(await f.control.crew({ sessionId: "chat" }), [], "nothing with parallel computer use off");
});

test("a computer that is not This Mac gets no follow-along arguments", async (t) => {
  const seen = [];
  const f = fixture({ seen }); t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  f.control.follow({ sessionId: "chat", watching: true });
  await f.control.execute({ sessionId: "chat", name: "computer_open", args: { app_id: "com.apple.TextEdit", mode: "control", purpose: "Write" } });
  const open = seen.find((call) => call.name === "computer_open_session");
  assert.ok(open && !("following" in open.args) && !("beside" in open.args));
  assert.ok(!f.selected.some((value) => value.action === "watch"));
});

const look = (control, sessionId, session) =>
  control.execute({ sessionId, name: "computer_observe", args: session ? { session_id: session } : {} });

test("one chat keeps several apps open, each with its own helper, and session_id picks one", async (t) => {
  const f = parallelFixture(); t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  assert.equal(payload(await openApp(f.control, "chat", "blender")).session_id, "native-blender");
  const second = await openApp(f.control, "chat", "photoshop");
  assert.equal(payload(second).session_id, "native-photoshop");
  assert.equal(f.connections(), 2, "the first app stays open while the second one opens");
  const listed = second.content.map((part) => part.type === "text" ? JSON.parse(part.text) : {}).find((part) => part.open_sessions);
  assert.deepEqual(listed.open_sessions.map((open) => open.session_id), ["native-blender", "native-photoshop"]);
  assert.equal(payload(await look(f.control, "chat")).observation_id, "observation-photoshop", "without session_id, the app opened last");
  assert.equal(payload(await look(f.control, "chat", "native-blender")).observation_id, "observation-blender");
  const count = f.events.length;
  assert.equal(payload(await look(f.control, "chat", "native-unknown")).code, "session_unknown");
  assert.equal(payload(await look(f.control, "other-chat", "native-blender")).code, "session_unknown", "another chat's session_id selects nothing");
  assert.equal(f.events.length, count, "nothing reached a helper");
  assert.equal(payload(await f.control.execute({ sessionId: "chat", name: "computer_close", args: { session_id: "native-blender" } })).ok, true);
  assert.ok(f.events.includes("blender:close"));
  assert.ok(!f.events.includes("photoshop:close"), "closing one app keeps the other");
  assert.equal(payload(await look(f.control, "chat", "native-blender")).code, "session_unknown");
  assert.equal(payload(await look(f.control, "chat")).observation_id, "observation-photoshop");
});

test("a chat opens a few apps, each window once", async (t) => {
  const f = parallelFixture(); t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  for (const app of ["blender", "photoshop", "notes"]) assert.equal(payload(await openApp(f.control, "chat", app)).ok, true);
  const again = payload(await openApp(f.control, "chat", "blender", "control", 11));
  assert.equal(again.code, "session_open");
  assert.equal(again.session_id, "native-blender", "the window's session is named so the agent can keep using it");
  const fourth = payload(await openApp(f.control, "chat", "keynote", "control", 14));
  assert.equal(fourth.code, "too_many_sessions");
  assert.equal(fourth.open_sessions.length, 3);
  assert.equal(f.connections(), 3);
  // After idle cleanup a closed helper's app is only forgotten, which frees its place.
  await f.control.endTurn({ sessionId: "chat" });
  assert.equal(payload(await f.control.execute({ sessionId: "chat", name: "computer_close", args: { session_id: "native-notes" } })).ok, true);
  assert.equal(f.connections(), 3, "closing a released app starts no helper");
  assert.equal(payload(await openApp(f.control, "chat", "keynote", "control", 14)).ok, true);
});

test("end of turn, takeover and Stop cover every app in the chat", async (t) => {
  const f = parallelFixture(); t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  await openApp(f.control, "chat", "blender");
  await openApp(f.control, "chat", "photoshop");
  await f.control.endTurn({ sessionId: "chat" });
  assert.ok(f.events.includes("blender:close") && f.events.includes("photoshop:close"), "the turn's end releases every helper");
  // Each app renews on its own from the window it opened.
  assert.equal(payload(await look(f.control, "chat", "native-blender")).observation_id, "observation-blender");
  assert.equal(f.events.filter((event) => event === "blender:computer_open_session:start").length, 2);
  assert.equal(f.events.filter((event) => event === "photoshop:computer_open_session:start").length, 1);
  assert.equal(payload(await look(f.control, "chat", "native-photoshop")).observation_id, "observation-photoshop");
  // Watch live follows the app being worked in, not only the one opened last.
  assert.equal((await f.control.presentation({ sessionId: "chat", visible: true })).id, "view-photoshop");
  await look(f.control, "chat", "native-blender");
  assert.equal((await f.control.presentation({ sessionId: "chat", visible: true })).appName, "blender");
  // Taking over one app holds the whole chat until Continue.
  await f.control.interact({ sessionId: "chat", id: "view-blender", action: "takeover" });
  const act = payload(await f.control.execute({ sessionId: "chat", name: "computer_act", args: { session_id: "native-photoshop", observation_id: "observation-photoshop", action: { type: "click", x: 1, y: 1 } } }));
  assert.equal(act.code, "session_paused");
  assert.equal((await f.control.presentation({ sessionId: "chat", visible: true })).id, "view-blender", "the view shows the app the person took");
  // Stop on one app's pill ends the others too.
  f.ui("blender", { kind: "state", id: "view-blender", phase: "closed", cause: "human_stop" });
  await settle();
  assert.equal(f.events.filter((event) => event === "photoshop:close").length, 2);
  assert.equal(payload(await look(f.control, "chat", "native-photoshop")).code, "not_allowed");
});

test("subagents work in their chat's computer: one folder, one Stop and Take over, their own apps", async (t) => {
  const f = parallelFixture({
    control: { platform: "darwin", saveFolder: async (sessionId) => `/Users/me/Downloads/OpenWork/${sessionId}` },
    act: (app, args) => args.action?.type === "save_image" ? text({ ok: true, status: "dispatched", path: "file_saved", saved_file: { path: args.action.path, bytes: 42 } }) : undefined,
  });
  t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  f.control.setParallelAgents(true);
  // The bridge names each subagent's chat; the model never does.
  const agent = (sessionId, name, args) => f.control.execute({ sessionId, rootSessionId: "chat", name, args });
  const open = (sessionId, app) => agent(sessionId, "computer_open", { app_id: app, mode: "control", purpose: `Work in ${app}` });
  const notes = (result) => Object.assign({}, ...result.content.map((part) => part.type === "text" ? JSON.parse(part.text) : {}));
  const [maps, slides] = await Promise.all([open("maps-agent", "maps"), open("slides-agent", "powerpoint")]);
  assert.equal(notes(maps).session_id, "native-maps");
  assert.equal(notes(slides).session_id, "native-powerpoint");
  assert.equal(f.connections(), 2, "each subagent has its own app session and helper");
  for (const opened of [maps, slides]) assert.equal(notes(opened).save_folder, "/Users/me/Downloads/OpenWork/chat", "both save in the chat's folder");
  assert.equal(payload(await agent("slides-agent", "computer_observe", { session_id: "native-maps" })).code, "session_unknown", "a subagent never drives another's app");
  assert.equal(f.control.chatOf({ sessionId: "maps-agent" }), "chat");
  // What a subagent saves, its chat can open from its own card.
  const image = "/Users/me/Downloads/OpenWork/chat/place.png";
  assert.equal(payload(await agent("maps-agent", "computer_act", { observation_id: "observation", action: { type: "save_image", path: image } })).path, "file_saved");
  assert.ok(f.control.savedFile({ sessionId: "chat", path: image }) && f.control.savedFile({ sessionId: "maps-agent", path: image }));
  assert.equal(f.control.savedFile({ sessionId: "slides-agent", path: image }), false);
  // The chat's Computer view shows its subagents' apps, and Take over there pauses every agent.
  assert.ok(["view-maps", "view-powerpoint"].includes((await f.control.presentation({ sessionId: "chat", visible: true })).id));
  await f.control.interact({ sessionId: "chat", id: "view-maps", action: "takeover" });
  assert.equal(payload(await agent("slides-agent", "computer_act", { observation_id: "observation", action: { type: "click", x: 1, y: 1 } })).code, "session_paused");
  assert.equal(payload(await openApp(f.control, "chat", "notes")).code, "session_paused", "the chat itself waits too");
  assert.equal((await f.control.presentation({ sessionId: "chat", visible: true })).id, "view-maps", "the chat's view shows the app the person took");
  await f.control.interact({ sessionId: "chat", id: "view-maps", action: "resume" });
  assert.equal(payload(await agent("slides-agent", "computer_act", { observation_id: "observation", action: { type: "click", x: 1, y: 1 } })).status, "dispatched");
  // Stop in the chat ends every subagent's apps, and holds for subagents that start later in the turn.
  await f.control.halt({ sessionId: "chat" });
  assert.ok(f.events.includes("maps:close") && f.events.includes("powerpoint:close"));
  assert.equal(payload(await agent("slides-agent", "computer_observe", {})).code, "not_allowed");
  assert.equal(payload(await open("late-agent", "notes")).code, "not_allowed");
  // The chat's next turn turns it back on for them.
  await f.control.endTurn({ sessionId: "chat" });
  assert.equal(notes(await open("maps-agent", "maps")).ok, true);
});

test("with parallel computer use off, a subagent is its own chat, as before", async (t) => {
  const f = parallelFixture({ control: { platform: "darwin", saveFolder: async (sessionId) => `/Users/me/Downloads/OpenWork/${sessionId}` } });
  t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  const open = (sessionId, app) => f.control.execute({ sessionId, rootSessionId: "chat", name: "computer_open", args: { app_id: app, mode: "control", purpose: `Work in ${app}` } });
  const folder = (result) => Object.assign({}, ...result.content.map((part) => part.type === "text" ? JSON.parse(part.text) : {})).save_folder;
  assert.equal(folder(await open("maps-agent", "maps")), "/Users/me/Downloads/OpenWork/maps-agent", "its own folder");
  assert.equal(f.control.chatOf({ sessionId: "maps-agent" }), "maps-agent");
  await f.control.halt({ sessionId: "chat" });
  assert.equal(payload(await f.control.execute({ sessionId: "maps-agent", rootSessionId: "chat", name: "computer_observe", args: {} })).observation_id, "observation-maps", "the chat's Stop does not reach it");
  // Turned on later, the link counts from the next call (after the stopped chat's next turn).
  await f.control.endTurn({ sessionId: "chat" });
  f.control.setParallelAgents(true);
  assert.equal(folder(await open("slides-agent", "powerpoint")), "/Users/me/Downloads/OpenWork/chat");
});

test("each subagent's cursor has its own name and a color that stays its own, and the chat keeps OpenWork's", async (t) => {
  const openwork = { name: "OpenWork", color: "#4585f2" };
  const f = parallelFixture({ control: { presence: openwork } }); t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  f.control.setParallelAgents(true);
  const open = (sessionId, app, extra = {}) => f.control.execute({ sessionId, ...extra, name: "computer_open", args: { app_id: app, mode: "control", purpose: `Work in ${app}` } });
  await open("chat", "notes");
  await Promise.all([open("maps-agent", "maps", { rootSessionId: "chat", agentName: "  Maps\n  " }), open("slides-agent", "powerpoint", { rootSessionId: "chat", agentName: "general" })]);
  await open("unnamed-agent", "photoshop", { rootSessionId: "chat" });
  const [chat, maps, slides, unnamed] = f.presences;
  assert.deepEqual(chat, openwork, "the chat itself stays OpenWork");
  assert.equal(maps.name, "Maps");
  assert.equal(slides.name, "general", "without a description, the agent's name");
  assert.equal(unnamed.name, "Agent 3");
  assert.equal(new Set([openwork.color, maps.color, slides.color, unnamed.color]).size, 4, "every agent has a color of its own");
  for (const presence of [maps, slides, unnamed]) assert.match(presence.color, /^#[0-9a-f]{6}$/);
  // A later helper for the same subagent, after its turn ends, keeps its name and color; a later name never renames it.
  await f.control.endTurn({ sessionId: "maps-agent" });
  await f.control.execute({ sessionId: "maps-agent", rootSessionId: "chat", agentName: "Renamed", name: "computer_observe", args: {} });
  assert.deepEqual(f.presences.at(-1), maps);
});

test("with parallel computer use off, every helper shows the one presence, as before", async (t) => {
  const openwork = { name: "OpenWork", color: "#4585f2" };
  const f = parallelFixture({ control: { presence: openwork } }); t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  await f.control.execute({ sessionId: "maps-agent", rootSessionId: "chat", agentName: "Maps", name: "computer_open", args: { app_id: "maps", mode: "control", purpose: "Find it" } });
  assert.deepEqual(f.presences, [openwork]);
});

test("a computer that is not parallel keeps one app per chat", async (t) => {
  const f = fixture(); t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  await f.control.execute({ sessionId: "chat", name: "computer_open", args: { app_id: "editor", mode: "control", purpose: "Edit" } });
  const second = payload(await f.control.execute({ sessionId: "chat", name: "computer_open", args: { app_id: "mail", mode: "control", purpose: "Send" } }));
  assert.equal(second.code, "session_open");
  assert.equal(f.calls.filter((name) => name === "connect").length, 1);
  assert.equal(payload(await f.control.execute({ sessionId: "chat", name: "computer_observe", args: { session_id: "native" } })).ok, true, "the one session_id still works");
});

for (const [where, options] of [["a Windows PC", { platform: "win32" }], ["a remote computer", { platform: "darwin", remote: true, authority: async () => true }]]) {
  test(`arranging windows is refused on ${where} before anything is sent`, async (t) => {
    const f = fixture(options); t.after(() => f.control.reset(true));
    await f.control.setFeatureEnabled(true);
    if (options.remote) { await f.control.setRemoteEnabled(true); await f.control.choose({ sessionId: "chat", targetId: "vm" }); }
    await f.control.execute({ sessionId: "chat", name: "computer_open", args: { app_id: "editor", mode: "control", purpose: "Edit" } });
    const result = payload(await f.control.execute({ sessionId: "chat", name: "computer_act", args: { observation_id: "observation", action: { type: "arrange", layout: "left_half" } } }));
    assert.equal(result.code, "arrange_unavailable");
    assert.ok(!f.calls.includes("computer_act"));
  });
}

test("on a Mac, arranging a window reaches its helper and returns a fresh look at the new frame", async (t) => {
  const seen = [];
  const f = fixture({ platform: "darwin", seen, toolResult: (name) => name === "computer_act" ? text({ ok: true, status: "dispatched", steps: [{ action: "arrange", path: "window_arranged" }] }) : null });
  t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  await f.control.execute({ sessionId: "chat", name: "computer_open", args: { app_id: "editor", mode: "control", purpose: "Edit" } });
  const looks = seen.filter(({ name }) => name === "computer_observe").length;
  const result = await f.control.execute({ sessionId: "chat", name: "computer_act", args: { session_id: "native", observation_id: "observation", action: { type: "arrange", layout: "beside_openwork" } } });
  assert.equal(payload(result).status, "dispatched");
  const sent = seen.find(({ name }) => name === "computer_act").args;
  assert.deepEqual(sent.action, { type: "arrange", layout: "beside_openwork" });
  assert.equal(sent.session_id, "native", "the helper gets its own session, never the model's argument");
  assert.equal(seen.filter(({ name }) => name === "computer_observe").length, looks + 1, "the moved window is observed again");
});

test("control calls take turns at the keyboard and pointer, one whole call at a time", async (t) => {
  const started = deferred(); const gate = deferred();
  const f = parallelFixture({ beforeTool: async (name, app) => { if (name === "computer_act" && app === "blender") { started.resolve(); await gate.promise; } } });
  t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  await openApp(f.control, "chat-blender", "blender");
  await openApp(f.control, "chat-photoshop", "photoshop");
  const blender = click(f.control, "chat-blender");
  await started.promise;
  const photoshop = click(f.control, "chat-photoshop");
  await settle();
  assert.ok(!f.events.includes("photoshop:computer_act:start"), "the second chat waits while the first chat's input runs");
  gate.resolve();
  await Promise.all([blender, photoshop]);
  const order = (event) => f.events.indexOf(event);
  // The first chat's settled look after its input is part of its turn.
  assert.ok(order("blender:computer_act:end") < order("photoshop:computer_act:start"));
  assert.ok(f.events.lastIndexOf("blender:computer_observe:end") < order("photoshop:computer_act:start"));
});

test("looking without control, status and listing apps never wait for another chat's turn", async (t) => {
  const started = deferred(); const gate = deferred();
  const f = parallelFixture({ beforeTool: async (name, app) => { if (name === "computer_act" && app === "blender") { started.resolve(); await gate.promise; } } });
  t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  await openApp(f.control, "chat-blender", "blender");
  await openApp(f.control, "chat-notes", "notes", "assist");
  const blender = click(f.control, "chat-blender");
  await started.promise;
  assert.equal(payload(await f.control.execute({ sessionId: "chat-notes", name: "computer_observe", args: {} })).ok, true);
  assert.equal(payload(await f.control.execute({ sessionId: "chat-notes", name: "computer_status", args: {} })).ok, true);
  assert.equal(payload(await f.control.execute({ sessionId: "chat-third", name: "computer_discover", args: {} })).ok, true);
  gate.resolve();
  await blender;
});

test("a takeover while a chat waits its turn dispatches nothing for that chat", async (t) => {
  const started = deferred(); const gate = deferred();
  const f = parallelFixture({ beforeTool: async (name, app) => { if (name === "computer_act" && app === "blender") { started.resolve(); await gate.promise; } } });
  t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  await openApp(f.control, "chat-blender", "blender");
  await openApp(f.control, "chat-photoshop", "photoshop");
  const blender = click(f.control, "chat-blender");
  await started.promise;
  const photoshop = click(f.control, "chat-photoshop");
  await settle();
  await f.control.interact({ sessionId: "chat-blender", id: "view-blender", action: "takeover" });
  gate.resolve();
  await blender;
  assert.equal(payload(await photoshop).code, "computer_busy");
  assert.ok(!f.events.includes("photoshop:computer_act:start"));
});

test("a call cancelled while it waits its turn leaves the line for the others", async (t) => {
  const started = deferred(); const gate = deferred();
  const f = parallelFixture({ beforeTool: async (name, app) => { if (name === "computer_act" && app === "blender") { started.resolve(); await gate.promise; } } });
  t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  await openApp(f.control, "chat-blender", "blender");
  await openApp(f.control, "chat-photoshop", "photoshop");
  await openApp(f.control, "chat-notes", "notes");
  const blender = click(f.control, "chat-blender");
  await started.promise;
  const cancel = new AbortController();
  const photoshop = click(f.control, "chat-photoshop", { signal: cancel.signal });
  const notes = click(f.control, "chat-notes");
  await settle();
  cancel.abort();
  assert.equal(payload(await photoshop).ok, false);
  gate.resolve();
  await blender;
  assert.equal(payload(await notes).status, "dispatched");
  assert.ok(!f.events.includes("photoshop:computer_act:start"));
});

test("chats on different computers no longer block each other", async (t) => {
  const f = fixture({ remote: true, authority: async () => true }); t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  await f.control.setRemoteEnabled(true);
  // A new chat's default computer depends on the platform; choose each one.
  for (const [sessionId, targetId] of [["chat-mac", "local"], ["chat-vm", "vm"], ["chat-other", "local"]]) await f.control.choose({ sessionId, targetId });
  assert.equal(payload(await f.control.execute({ sessionId: "chat-mac", name: "computer_open", args: { app_id: "editor", mode: "control", purpose: "Edit" } })).ok, true);
  assert.equal(payload(await f.control.execute({ sessionId: "chat-vm", name: "computer_open", args: { app_id: "editor", mode: "control", purpose: "Edit" } })).ok, true);
  assert.equal(payload(await f.control.execute({ sessionId: "chat-other", name: "computer_open", args: { app_id: "editor", mode: "control", purpose: "Edit" } })).code, "computer_busy",
    "a computer that is not parallel still serves one chat");
});

test("background sessions act at the same time instead of taking turns", async (t) => {
  const started = deferred(); const gate = deferred();
  const f = parallelFixture({ delivery: () => "background",
    beforeTool: async (name, app) => { if (name === "computer_act" && app === "blender") { started.resolve(); await gate.promise; } } });
  t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  await openApp(f.control, "chat-blender", "blender");
  await openApp(f.control, "chat-photoshop", "photoshop");
  assert.deepEqual(f.started, [{ background: true }, { background: true }], "each helper starts with background delivery");
  const blender = click(f.control, "chat-blender");
  await started.promise;
  assert.equal(payload(await click(f.control, "chat-photoshop")).status, "dispatched", "the second chat acts while the first one's input is still running");
  gate.resolve();
  await blender;
});

test("a session the helper keeps in front still takes turns, without holding up background ones", async (t) => {
  const started = deferred(); const gate = deferred();
  const f = parallelFixture({ delivery: (app) => app === "photoshop" ? "background" : "foreground",
    beforeTool: async (name, app) => { if (name === "computer_act" && app === "blender") { started.resolve(); await gate.promise; } } });
  t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  for (const app of ["blender", "photoshop", "notes"]) await openApp(f.control, `chat-${app}`, app);
  const blender = click(f.control, "chat-blender");
  await started.promise;
  const notes = click(f.control, "chat-notes");
  assert.equal(payload(await click(f.control, "chat-photoshop")).status, "dispatched");
  await settle();
  assert.ok(!f.events.includes("notes:computer_act:start"), "another foreground session waits for its turn");
  gate.resolve();
  await Promise.all([blender, notes]);
  assert.ok(f.events.indexOf("blender:computer_act:end") < f.events.indexOf("notes:computer_act:start"));
});

test("older renderers cannot disable background delivery independently of computer use", async (t) => {
  const f = parallelFixture({ delivery: () => "background" }); t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  await openApp(f.control, "chat-notes", "notes");
  assert.equal(await f.control.setBackgroundEnabled(false), true);
  assert.ok(!f.events.includes("notes:close"), "the obsolete child flag cannot end an active session");
  assert.equal(payload(await f.control.execute({ sessionId: "chat-notes", name: "computer_observe", args: {} })).ok, true);
  assert.deepEqual(f.started.at(-1), { background: true });
  await f.control.setFeatureEnabled(false);
  assert.ok(f.events.includes("notes:close"), "the parent switch still hands the session back");
  assert.equal(await f.control.setBackgroundEnabled(true), false);
  assert.equal(payload(await f.control.execute({ sessionId: "chat-notes", name: "computer_observe", args: {} })).code, "computer_unavailable");
});

test("background stays off on a computer that is not parallel", async (t) => {
  const connected = [];
  const f = fixture({ connected }); t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  assert.equal(payload(await f.control.execute({ sessionId: "chat", name: "computer_open", args: { app_id: "editor", mode: "control", purpose: "Edit" } })).ok, true);
  assert.deepEqual(connected, [{ background: false }]);
});

const askFirst = async () => ({ effect: "ask" });
/**
 * A native helper in a file panel: it asks before showing the panel, and confirms only the exact approved names.
 * The cards it shows are the organization's Ask first; with no rule nothing asks.
 */
function filePanelFixture({ files = ["launch.mp4"], browsing = false, movePolicy = askFirst } = {}) {
  const seen = [];
  let allowed = !browsing;
  // null: no policy given to the broker at all.
  const f = fixture({ seen, movePolicy: movePolicy ?? undefined, toolResult: (name) => {
    const args = seen.at(-1).args;
    // The first look is the one opening the session makes; the panel opens after it.
    const looks = seen.filter((call) => call.name === "computer_observe").length;
    if (name === "computer_observe" && !allowed && looks > 1) {
      if (args.file_panel_access !== 31) return text({ ok: false, code: "file_panel_approval_required", app: "Safari", panel_id: 31, dispatched: false, next: "observe" });
      allowed = true;
    }
    if (name !== "computer_act") return undefined;
    return JSON.stringify(args.file_approval) === JSON.stringify(files) ? text({ ok: true, status: "dispatched" })
      : text({ ok: false, code: "files_approval_required", files, app: "Safari", dispatched: false, next: "observe" });
  } });
  const acts = () => seen.filter((call) => call.name === "computer_act").map((call) => call.args.file_approval ?? null);
  const looks = () => seen.filter((call) => call.name === "computer_observe").map((call) => call.args.file_panel_access ?? null);
  return { ...f, acts, looks };
}
const confirmPanel = (control) => control.execute({ sessionId: "chat", name: "computer_act", args: { observation_id: "observation", action: { type: "press", ref: "e1" } } });
async function answerFiles(f, answer) {
  const listing = () => f.requests.filter((request) => request?.reason === "files" && request.files.names.length).at(-1);
  const before = listing();
  for (let waited = 0; listing() === before && waited < 2_000; waited += 5) await new Promise((resolve) => setTimeout(resolve, 5));
  const request = listing();
  assert.deepEqual(request.files, { app: "Safari", names: ["launch.mp4"] });
  await f.control.answerRequest({ sessionId: "chat", answer, id: request.id });
}

test("confirming a file panel asks the person, then sends the press with their approval", async (t) => {
  const f = filePanelFixture(); t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  await f.control.execute({ sessionId: "chat", name: "computer_open", args: { app_id: "editor", mode: "control", purpose: "Upload" } });
  const pending = confirmPanel(f.control);
  await answerFiles(f, "allow");
  assert.equal(payload(await pending).status, "dispatched");
  assert.deepEqual(f.acts(), [null, ["launch.mp4"]], "the second native act carries exactly the approved names");
});

/** A Mac helper that opens an app onto a file only when the broker sends back that exact file. */
function openOnFileFixture(options = {}) {
  const seen = [];
  const report = "/Users/person/Desktop/report.pdf";
  const f = fixture({ platform: "darwin", ...options, seen, toolResult: (name) => {
    const args = seen.at(-1).args;
    if (name !== "computer_open_session" || args.file === undefined || JSON.stringify(args.file_approval) === JSON.stringify([report])) return undefined;
    return text({ ok: false, code: "files_approval_required", files: [report], app: "Preview", dispatched: false, next: "open_session" });
  } });
  const opens = () => seen.filter((call) => call.name === "computer_open_session").map((call) => call.args);
  const openOnFile = (sessionId = "chat") => f.control.execute({ sessionId, name: "computer_open", args: { app_id: "com.apple.Preview", mode: "control", purpose: "Read the report", file: report } });
  async function answer(reply) {
    for (let waited = 0; !f.requests.some((request) => request?.reason === "files") && waited < 2_000; waited += 5) await new Promise((resolve) => setTimeout(resolve, 5));
    const request = f.requests.find((value) => value?.reason === "files");
    assert.deepEqual(request.files, { app: "Preview", names: [report] });
    await f.control.answerRequest({ sessionId: "chat", answer: reply, id: request.id });
  }
  return { ...f, report, opens, openOnFile, answer };
}

test("by default an app opens onto a file with no card, once, and renewals never reopen it", async (t) => {
  const asked = [];
  const f = openOnFileFixture({ movePolicy: async (input) => { asked.push(input); return { effect: "allow" }; } }); t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  assert.equal(payload(await f.openOnFile()).ok, true);
  assert.ok(!f.requests.some((request) => request?.reason === "files"), "the person is not asked");
  assert.deepEqual(asked, [{ kind: "computer_files", sessionId: "chat" }], "the organization's rule for moving files is looked up once");
  assert.deepEqual(f.opens().map((args) => args.file_approval ?? null), [null, [f.report]], "the helper still checks the exact file");
  // The turn ends and the session is released; the next look renews it without the file.
  await f.control.endTurn({ sessionId: "chat" });
  await f.control.execute({ sessionId: "chat", name: "computer_observe", args: {} });
  const renewal = f.opens().at(-1);
  assert.equal(f.opens().length, 3);
  assert.equal(renewal.file, undefined);
  assert.equal(renewal.file_approval, undefined);
  assert.equal(renewal.clipboard, f.opens()[0].clipboard, "the chat keeps its clipboard key across its helpers");
});

test("with no rule given, files move between apps without a card", async (t) => {
  const f = openOnFileFixture(); t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  assert.equal(payload(await f.openOnFile()).ok, true);
  assert.ok(!f.requests.some((request) => request?.reason === "files"));
});

test("an organization that asks shows the file every time, and a declined file is never opened", async (t) => {
  const f = openOnFileFixture({ movePolicy: askFirst }); t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  const pending = f.openOnFile();
  await f.answer("dismiss");
  const result = payload(await pending);
  assert.equal(result.code, "files_declined");
  assert.match(result.message, /Nothing was opened/);
  assert.equal(f.requests.find((request) => request?.reason === "files").standing, false, "no Always: nothing is remembered");
  assert.equal(f.opens().length, 1);
  assert.equal((await f.control.snapshot({ sessionId: "chat" })).session ?? null, null, "no session shows as opening");
});

test("an organization that blocks moving files refuses opening an app onto a file", async (t) => {
  const message = "Your organization does not let agents move files between apps.";
  for (const movePolicy of [async () => ({ effect: "deny", message }), async () => { throw new Error("rules unavailable"); }]) {
    const f = openOnFileFixture({ movePolicy }); t.after(() => f.control.reset(true));
    await f.control.setFeatureEnabled(true);
    const refused = payload(await f.openOnFile());
    assert.equal(refused.code, "organization_policy_denied");
    assert.match(refused.message, /organization.*Nothing was opened\./);
    assert.ok(!f.requests.some((request) => request?.reason === "files"));
    assert.equal(f.opens().length, 1, "the file never reached the helper with an approval");
  }
});

test("each chat gets its own clipboard key, which the model can never set", async (t) => {
  const f = openOnFileFixture(); t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  const open = (sessionId) => f.control.execute({ sessionId, name: "computer_open", args: { app_id: "numbers", mode: "control", purpose: "Copy the table" } });
  await open("chat");
  await f.control.execute({ sessionId: "chat", name: "computer_close", args: {} });
  await open("chat");
  await open("other-chat");
  const keys = f.opens().map((args) => args.clipboard);
  assert.match(keys[0], /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(keys[1], keys[0], "the next app's session in the chat pastes what the last one copied");
  assert.notEqual(keys[2], keys[0], "another chat never pastes this chat's copy");
  for (const args of [{ clipboard: keys[0] }, { file_approval: ["/etc/hosts"] }]) {
    const refused = await f.control.execute({ sessionId: "third", name: "computer_open", args: { app_id: "numbers", mode: "control", purpose: "Paste", ...args } });
    assert.equal(payload(refused).code, "invalid_arguments");
  }
});

test("only a Mac opens an app onto a file or keeps an agent clipboard", async (t) => {
  for (const platform of ["win32", "linux"]) {
    const f = openOnFileFixture({ platform }); t.after(() => f.control.reset(true));
    await f.control.setFeatureEnabled(true);
    const refused = payload(await f.openOnFile());
    assert.equal(refused.code, "file_unavailable", platform);
    assert.equal(f.opens().length, 0, "nothing reached the helper");
    await f.control.execute({ sessionId: "chat", name: "computer_open", args: { app_id: "editor", mode: "control", purpose: "Edit" } });
    assert.equal(f.opens().at(-1).clipboard, undefined, platform);
  }
});

test("a save the helper confirmed on disk is the only file the chat may open, and only in that chat", async (t) => {
  const seen = [];
  const f = fixture({ seen, toolResult: (name) => {
    if (name !== "computer_act") return undefined;
    const { observation_id: id } = seen.at(-1).args;
    return text(id === "saved" ? { ok: true, status: "dispatched", path: "file_saved", saved_file: { path: "/Users/me/Desktop/report.pdf", bytes: 42 } }
      : { ok: true, status: "dispatched", path: "file_save_unconfirmed" });
  } });
  t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  await f.control.execute({ sessionId: "chat", name: "computer_open", args: { app_id: "editor", mode: "control", purpose: "Export" } });
  const save = (id, path) => f.control.execute({ sessionId: "chat", name: "computer_act", args: { observation_id: id, action: { type: "save_as", path } } });
  await save("unconfirmed", "/Users/me/Desktop/ghost.pdf");
  assert.equal(f.control.savedFile({ sessionId: "chat", path: "/Users/me/Desktop/ghost.pdf" }), false, "pressed Save is not a saved file");
  await save("saved", "/Users/me/Desktop/report.pdf");
  assert.equal(f.control.savedFile({ sessionId: "chat", path: "/Users/me/Desktop/report.pdf" }), true);
  assert.equal(f.control.savedFile({ sessionId: "other", path: "/Users/me/Desktop/report.pdf" }), false, "another chat cannot open it");
  assert.equal(f.control.savedFile({ sessionId: "chat", path: "/Applications/Calculator.app" }), false);
});

/** A Mac helper that asks for the destination of each save_as, then saves once it is approved. */
function saveFixture(options = {}) {
  const seen = [];
  const f = fixture({ seen, platform: "darwin", saveFolder: async (sessionId) => `/Users/me/Downloads/OpenWork/${sessionId}`, ...options, toolResult: (name) => {
    if (name !== "computer_act") return undefined;
    const { action, file_approval: approved } = seen.at(-1).args;
    return text(JSON.stringify(approved) === JSON.stringify([action.path])
      ? { ok: true, status: "dispatched", path: "file_saved", saved_file: { path: action.path, bytes: 42 } }
      : { ok: false, code: "files_approval_required", files: [action.path], save: true, app: "Preview", dispatched: false, next: "observe" });
  } });
  const save = (path) => f.control.execute({ sessionId: "chat", name: "computer_act", args: { observation_id: "observation", action: { type: "save_as", path } } });
  const cards = () => f.requests.filter((request) => request?.reason === "files");
  const acts = () => seen.filter((call) => call.name === "computer_act").length;
  return { ...f, save, cards, acts };
}
const openForSaving = (f) => f.control.setFeatureEnabled(true).then(() => f.control.execute({ sessionId: "chat", name: "computer_open", args: { app_id: "editor", mode: "control", purpose: "Make a PDF" } }));

test("a save goes ahead without a card by default, and the chat learns its own folder", async (t) => {
  const f = saveFixture(); t.after(() => f.control.reset(true));
  const opened = await openForSaving(f);
  assert.ok(opened.content.some((part) => part.type === "text" && JSON.parse(part.text).save_folder === "/Users/me/Downloads/OpenWork/chat"));
  assert.equal(payload(await f.save("/Users/me/Desktop/report.pdf")).path, "file_saved");
  assert.deepEqual(f.cards(), [], "the agent decides");
  assert.ok(f.control.savedFile({ sessionId: "chat", path: "/Users/me/Desktop/report.pdf" }));
});

test("an organization that asks shows the save card each time, and one that blocks saves refuses them", async (t) => {
  const asked = [];
  const f = saveFixture({ movePolicy: async (input) => { asked.push(input); return { effect: "ask" }; } }); t.after(() => f.control.reset(true));
  await openForSaving(f);
  const card = async (count) => {
    for (let waited = 0; f.cards().length < count && waited < 2_000; waited += 5) await new Promise((resolve) => setTimeout(resolve, 5));
    return f.cards().at(-1);
  };
  const first = f.save("/Users/me/Desktop/report.pdf");
  const request = await card(1);
  assert.deepEqual(request.files, { app: "Preview", names: ["/Users/me/Desktop/report.pdf"], save: true });
  assert.equal(request.standing, false, "no Always: nothing is remembered");
  assert.deepEqual(asked, [{ kind: "computer_files", sessionId: "chat" }], "saves use the organization's rule for moving files");
  await f.control.answerRequest({ sessionId: "chat", answer: "allow", id: request.id });
  assert.equal(payload(await first).path, "file_saved");
  const second = f.save("/Users/me/Desktop/report.pdf");
  await f.control.answerRequest({ sessionId: "chat", answer: "dismiss", id: (await card(2)).id });
  assert.equal(payload(await second).code, "save_declined", "asked again, and declined");

  const b = saveFixture({ movePolicy: async () => ({ effect: "deny", message: "Your organization does not let agents move files between apps." }) }); t.after(() => b.control.reset(true));
  await openForSaving(b);
  const blocked = payload(await b.save("/Users/me/Desktop/report.pdf"));
  assert.equal(blocked.code, "organization_policy_denied");
  assert.match(blocked.message, /organization.*Nothing was saved/);
  assert.deepEqual(b.cards(), []);
  assert.equal(b.acts(), 1, "nothing was sent with an approval");

  const broken = saveFixture({ movePolicy: async () => { throw new Error("policy unavailable"); } }); t.after(() => broken.control.reset(true));
  await openForSaving(broken);
  assert.equal(payload(await broken.save("/Users/me/Desktop/report.pdf")).code, "organization_policy_denied", "a rule that cannot be read refuses");
  assert.deepEqual(broken.cards(), []);
  assert.equal(broken.acts(), 1);
});

test("the agent saves what it sees as an image under the same file rule as save_as, on a Mac only", async (t) => {
  const saveImage = (f, path) => f.control.execute({ sessionId: "chat", name: "computer_act", args: { observation_id: "observation", action: { type: "save_image", path } } });
  const f = saveFixture(); t.after(() => f.control.reset(true));
  await openForSaving(f);
  assert.equal(payload(await saveImage(f, "/Users/me/Desktop/map.png")).path, "file_saved");
  assert.deepEqual(f.cards(), [], "by default the agent decides");
  assert.ok(f.control.savedFile({ sessionId: "chat", path: "/Users/me/Desktop/map.png" }), "the session card can open it");

  const ask = saveFixture({ movePolicy: async () => ({ effect: "ask" }) }); t.after(() => ask.control.reset(true));
  await openForSaving(ask);
  const pending = saveImage(ask, "/Users/me/Desktop/map.png");
  for (let waited = 0; !ask.cards().length && waited < 2_000; waited += 5) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(ask.cards()[0].files, { app: "Preview", names: ["/Users/me/Desktop/map.png"], save: true }, "the save card");
  await ask.control.answerRequest({ sessionId: "chat", answer: "dismiss", id: ask.cards()[0].id });
  assert.equal(payload(await pending).code, "save_declined");

  const blocked = saveFixture({ movePolicy: async () => ({ effect: "deny", message: "Your organization does not let agents move files between apps." }) }); t.after(() => blocked.control.reset(true));
  await openForSaving(blocked);
  assert.equal(payload(await saveImage(blocked, "/Users/me/Desktop/map.png")).code, "organization_policy_denied");
  assert.equal(blocked.acts(), 1, "nothing was sent with an approval");

  const windows = saveFixture({ platform: "win32" }); t.after(() => windows.control.reset(true));
  await openForSaving(windows);
  assert.equal(payload(await saveImage(windows, "C:/map.png")).code, "unsupported_platform");
  assert.equal(windows.acts(), 0, "a Windows PC never receives it");
});

/** A Mac helper with an Open panel in front: it asks before showing the panel, and picks the file once its path is approved. */
function openPanelFixture(options = {}) {
  const seen = [];
  // As the helper does, a panel once allowed stays allowed until it closes; picking a file closes it.
  let open = false, allowed = false;
  const f = fixture({ seen, platform: "darwin", ...options, toolResult: (name) => {
    const args = seen.at(-1).args;
    if (name === "computer_observe" && open && !allowed) {
      if (args.file_panel_access !== 31) return text({ ok: false, code: "file_panel_approval_required", app: "Photoshop", panel_id: 31, dispatched: false, next: "observe" });
      allowed = true;
    }
    if (name !== "computer_act") return undefined;
    const chosen = JSON.stringify(args.file_approval) === JSON.stringify([args.action.path]);
    if (chosen) open = false;
    return text(chosen ? { ok: true, status: "dispatched", path: "file_chosen" }
      : { ok: false, code: "files_approval_required", files: [args.action.path], open: true, app: "Photoshop", dispatched: false, next: "observe" });
  } });
  // Each explicit look is at a panel the app has just opened.
  const look = () => { open = true; allowed = false; return f.control.execute({ sessionId: "chat", name: "computer_observe", args: {} }); };
  const pick = (path) => f.control.execute({ sessionId: "chat", name: "computer_act", args: { observation_id: "observation", action: { type: "open_in_panel", path } } });
  const cards = () => f.requests.filter((request) => request?.reason === "files");
  const acts = () => seen.filter((call) => call.name === "computer_act").map((call) => call.args.file_approval ?? null);
  const card = async (count) => {
    for (let waited = 0; cards().length < count && waited < 2_000; waited += 5) await new Promise((resolve) => setTimeout(resolve, 5));
    return cards().at(-1);
  };
  const answer = async (count, reply) => f.control.answerRequest({ sessionId: "chat", answer: reply, id: (await card(count)).id });
  return { ...f, look, pick, cards, acts, card, answer };
}
/** A Mac helper whose next act opens a Save panel: looks after it ask first, as the helper does for any file panel. */
function savePanelFixture(movePolicy) {
  const seen = [];
  let opened = false;
  const f = fixture({ seen, platform: "darwin", movePolicy, toolResult: (name) => {
    const args = seen.at(-1).args;
    if (name === "computer_act") { opened = true; return text({ ok: true, status: "dispatched", completed: 1, next: "observe", steps: [{ index: 0, action: "key", status: "dispatched", path: "menu_for_shortcut" }] }); }
    if (name === "computer_observe" && opened && args.file_panel_access !== 31) {
      return text({ ok: false, code: "file_panel_approval_required", app: "TextEdit", panel_id: 31, dispatched: false, next: "observe" });
    }
    return undefined;
  } });
  const looks = () => seen.filter((call) => call.name === "computer_observe").map((call) => call.args.file_panel_access ?? null);
  const save = () => f.control.execute({ sessionId: "chat", name: "computer_act", args: { observation_id: "observation", action: { type: "key", key: "s", modifiers: ["command"] } } });
  const open = () => f.control.setFeatureEnabled(true).then(() => f.control.execute({ sessionId: "chat", name: "computer_open", args: { app_id: "editor", mode: "control", purpose: "Save the letter" } }));
  return { ...f, looks, save, open };
}

test("a Save panel the agent's own step opened is shown in that step's receipt, with no second look", async (t) => {
  const asked = [];
  const f = savePanelFixture(async (input) => { asked.push(input); return { effect: "allow" }; }); t.after(() => f.control.reset(true));
  await f.open();
  const before = f.looks().length;
  const parts = (await f.save()).content.map((part) => JSON.parse(part.text));
  assert.deepEqual(parts[1], { post_observation: { ok: true }, actions_replayed: false }, "the panel is looked at in the same call");
  assert.deepEqual(f.looks().slice(before), [null, 31], "the second look carries the panel the organization's rule allowed");
  assert.deepEqual(asked, [{ kind: "computer_files", sessionId: "chat" }]);
  assert.deepEqual(f.requests.filter((request) => request?.reason === "files"), [], "by default nothing asks");
});

test("an organization that blocks file panels still keeps the agent out of one its step opened", async (t) => {
  const f = savePanelFixture(async () => ({ effect: "deny", message: "Blocked here." })); t.after(() => f.control.reset(true));
  await f.open();
  const before = f.looks().length;
  const parts = (await f.save()).content.map((part) => JSON.parse(part.text));
  assert.equal(parts[1].post_observation.code, "file_panel_approval_required");
  assert.equal(parts.length, 2, "no view of the panel");
  assert.deepEqual(f.looks().slice(before), [null], "never looked at with access");
});

const openForPlacing = (f) => f.control.setFeatureEnabled(true).then(() => f.control.execute({ sessionId: "chat", name: "computer_open", args: { app_id: "editor", mode: "control", purpose: "Place the map" } }));

test("an Open panel is looked through and a file picked in it without a card by default", async (t) => {
  const asked = [];
  const f = openPanelFixture({ movePolicy: async (input) => { asked.push(input); return { effect: "allow" }; } }); t.after(() => f.control.reset(true));
  await openForPlacing(f);
  assert.equal(payload(await f.look()).ok, true, "the panel opens to the agent");
  assert.equal(payload(await f.pick("/Users/me/Desktop/map.png")).path, "file_chosen");
  assert.deepEqual(f.cards(), [], "the agent decides");
  assert.deepEqual(asked, [{ kind: "computer_files", sessionId: "chat" }, { kind: "computer_files", sessionId: "chat" }],
    "the organization's rule is checked for the panel and for the file");
  assert.deepEqual(f.acts(), [null, ["/Users/me/Desktop/map.png"]], "the pick carries exactly the file's path");
});

test("an organization that asks shows the picked file each time, and one that blocks refuses the pick", async (t) => {
  const f = openPanelFixture({ movePolicy: askFirst }); t.after(() => f.control.reset(true));
  await openForPlacing(f);
  const look = f.look();
  await f.answer(1, "allow");
  await look;
  const first = f.pick("/Users/me/Desktop/map.png");
  const request = await f.card(2);
  assert.deepEqual(request.files, { app: "Photoshop", names: ["/Users/me/Desktop/map.png"] });
  assert.equal(request.standing, false, "no Always: nothing is remembered");
  await f.control.answerRequest({ sessionId: "chat", answer: "always", id: request.id });
  assert.equal(payload(await first).path, "file_chosen");
  const again = f.look();
  await f.answer(3, "allow");
  await again;
  const second = f.pick("/Users/me/Desktop/map.png");
  await f.answer(4, "dismiss");
  assert.equal(payload(await second).code, "files_declined", "asked again, and declined");

  const b = openPanelFixture({ movePolicy: async () => ({ effect: "deny", message: "Your organization does not let agents move files between apps." }) });
  t.after(() => b.control.reset(true));
  await openForPlacing(b);
  assert.equal(payload(await b.look()).code, "organization_policy_denied", "a blocked panel is never shown to the agent");
  assert.equal(payload(await b.pick("/Users/me/Desktop/map.png")).code, "organization_policy_denied");
  assert.deepEqual(b.cards(), []);
  assert.deepEqual(b.acts(), [null], "nothing was sent with an approval");
});

test("declined files are never handed over", async (t) => {
  const f = filePanelFixture(); t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  await f.control.execute({ sessionId: "chat", name: "computer_open", args: { app_id: "editor", mode: "control", purpose: "Upload" } });
  const pending = confirmPanel(f.control);
  await answerFiles(f, "dismiss");
  assert.equal(payload(await pending).code, "files_declined");
  assert.deepEqual(f.acts(), [null]);
});

test("with no organization rule, files and file panels reach the app without a card", async (t) => {
  const policy = [];
  const f = filePanelFixture({ browsing: true, movePolicy: async (input) => { policy.push(input); return { effect: "allow" }; } }); t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  await f.control.execute({ sessionId: "chat", name: "computer_open", args: { app_id: "editor", mode: "control", purpose: "Upload" } });
  assert.equal(payload(await f.control.execute({ sessionId: "chat", name: "computer_observe", args: {} })).ok, true);
  assert.equal(payload(await confirmPanel(f.control)).status, "dispatched");
  assert.equal(f.requests.filter((request) => request?.reason === "files").length, 0, "nothing asked the person");
  assert.ok(f.looks().includes(31), "the panel opens to the agent bound to its own window");
  assert.deepEqual(f.acts(), [null, ["launch.mp4"]], "the handover carries exactly the helper's files");
  assert.deepEqual(policy, [{ kind: "computer_files", sessionId: "chat" }, { kind: "computer_files", sessionId: "chat" }]);
});

test("the default broker, with no policy given, never asks about files", async (t) => {
  const f = filePanelFixture({ movePolicy: null }); t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  await f.control.execute({ sessionId: "chat", name: "computer_open", args: { app_id: "editor", mode: "control", purpose: "Upload" } });
  assert.equal(payload(await confirmPanel(f.control)).status, "dispatched");
  assert.equal(f.requests.filter((request) => request?.reason === "files").length, 0);
});

test("an organization that blocks moving files refuses the handover and the panel without a card", async (t) => {
  const deny = async () => ({ effect: "deny", message: "Your organization's agent permissions block moving files between apps and folders (set for Contractors)." });
  for (const browsing of [false, true]) {
    const f = filePanelFixture({ browsing, movePolicy: deny }); t.after(() => f.control.reset(true));
    await f.control.setFeatureEnabled(true);
    await f.control.execute({ sessionId: "chat", name: "computer_open", args: { app_id: "editor", mode: "control", purpose: "Upload" } });
    const refused = payload(browsing ? await f.control.execute({ sessionId: "chat", name: "computer_observe", args: {} }) : await confirmPanel(f.control));
    assert.equal(refused.code, "organization_policy_denied");
    assert.match(refused.message, /block moving files between apps and folders \(set for Contractors\)\./);
    assert.equal(f.requests.filter((request) => request?.reason === "files").length, 0, "a block never becomes a question");
    if (browsing) assert.equal(f.looks().includes(31), false, "the panel was never opened to the agent");
    else assert.deepEqual(f.acts(), [null], "nothing was handed over");
  }
});

test("a policy that cannot answer blocks moving files", async (t) => {
  const f = filePanelFixture({ movePolicy: async () => { throw new Error("offline"); } }); t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  await f.control.execute({ sessionId: "chat", name: "computer_open", args: { app_id: "editor", mode: "control", purpose: "Upload" } });
  assert.equal(payload(await confirmPanel(f.control)).code, "organization_policy_denied");
  assert.deepEqual(f.acts(), [null]);
});

test("Ask first asks about every handover and offers no standing approval", async (t) => {
  const f = filePanelFixture(); t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  await f.control.execute({ sessionId: "chat", name: "computer_open", args: { app_id: "editor", mode: "control", purpose: "Upload" } });
  const first = confirmPanel(f.control);
  await answerFiles(f, "always");
  assert.equal(payload(await first).status, "dispatched");
  assert.equal(f.requests.filter((request) => request?.reason === "files").at(-1).standing, false);
  const asked = f.requests.filter((request) => request?.reason === "files").length;
  const second = confirmPanel(f.control);
  await answerFiles(f, "allow");
  assert.equal(payload(await second).status, "dispatched");
  assert.equal(f.requests.filter((request) => request?.reason === "files").length, asked + 1, "the same files to the same app are asked about again");
});

test("browser uploads keep their own always-allow per recipient", async (t) => {
  const f = filePanelFixture(); t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  await f.control.execute({ sessionId: "chat", name: "computer_open", args: { app_id: "editor", mode: "control", purpose: "Upload" } });
  const first = f.control.approveFiles({ sessionId: "chat", app: "Safari", files: ["launch.mp4"] });
  await answerFiles(f, "always");
  assert.equal(await first, true);
  const asked = f.requests.filter((request) => request?.reason === "files").length;
  assert.equal(await f.control.approveFiles({ sessionId: "chat", app: "Safari", files: ["launch.mp4"] }), true);
  assert.equal(f.requests.filter((request) => request?.reason === "files").length, asked);
  // Another recipient is asked again: "always" covered only Safari.
  const other = f.control.approveFiles({ sessionId: "chat", app: "example.com", files: ["/tmp/a.txt"] });
  for (let waited = 0; f.requests.filter((request) => request?.reason === "files").length === asked && waited < 2_000; waited += 5) await new Promise((resolve) => setTimeout(resolve, 5));
  const card = f.requests.filter((request) => request?.reason === "files").at(-1);
  assert.equal(card.files.app, "example.com");
  await f.control.answerRequest({ sessionId: "chat", answer: "dismiss", id: card.id });
  assert.equal(await other, false);
});

async function browserFileCard(f, pending, answer = "dismiss") {
  for (let waited = 0; !f.requests.at(-1) && waited < 2_000; waited += 5) await new Promise((resolve) => setTimeout(resolve, 5));
  const card = f.requests.at(-1);
  assert.equal(card.reason, "files");
  await f.control.answerRequest({ sessionId: "chat", answer, id: card.id });
  return { card, answer: await pending };
}

test("browser files ask with computer use off and remember only the exact pending browser request", async (t) => {
  const f = fixture({ remote: true, authority: async () => true }); t.after(() => f.control.reset(true));
  await f.control.setRemoteEnabled(true);
  await f.control.choose({ sessionId: "chat", targetId: "vm" });
  const pending = f.control.requestBrowserFiles({ sessionId: "chat", site: "https://example.com", files: ["/local/report.pdf"], canRemember: true, accountScope: "a".repeat(64) });
  for (let waited = 0; !f.requests.at(-1) && waited < 2_000; waited += 5) await new Promise((resolve) => setTimeout(resolve, 5));
  const card = f.requests.at(-1);
  assert.equal(card.computer, "This computer");
  assert.equal(card.placement, "local");
  assert.deepEqual(card.files, { app: "https://example.com", site: "https://example.com", names: ["/local/report.pdf"], canRemember: true });
  await assert.rejects(f.control.answerRequest({ sessionId: "chat", answer: "remember", id: "stale" }), /changed/);
  await f.control.answerRequest({ sessionId: "chat", answer: "remember", id: card.id });
  assert.equal(await pending, "remember");
  // Remember is not broker persistence; only the trusted service may save a folder grant.
  const again = f.control.requestBrowserFiles({ sessionId: "chat", site: "https://example.com", files: ["/local/report.pdf"], canRemember: true, accountScope: "a".repeat(64) });
  assert.equal((await browserFileCard(f, again)).answer, "dismiss");
});

test("browser always is chat-only, disjoint from native approval and ignored by managed Ask", async (t) => {
  const f = fixture(); t.after(() => f.control.reset(true));
  const input = { sessionId: "chat", site: "https://example.com", files: ["/local/report.pdf"], canRemember: true, accountScope: "a".repeat(64) };
  assert.equal((await browserFileCard(f, f.control.requestBrowserFiles(input), "always")).answer, "always");
  assert.equal(await f.control.requestBrowserFiles(input), "always");
  const pending = f.control.requestBrowserFiles({ ...input, canRemember: false });
  for (let waited = 0; !f.requests.at(-1) && waited < 2_000; waited += 5) await new Promise((resolve) => setTimeout(resolve, 5));
  const card = f.requests.at(-1);
  assert.equal(card.standing, false);
  for (const answer of ["always", "remember"]) await assert.rejects(f.control.answerRequest({ sessionId: "chat", answer, id: card.id }));
  await f.control.answerRequest({ sessionId: "chat", answer: "allow", id: card.id });
  assert.equal(await pending, "allow");
  await f.control.setFeatureEnabled(true);
  const native = f.control.approveFiles({ sessionId: "chat", app: input.site, files: input.files });
  for (let waited = 0; !f.requests.at(-1) && waited < 2_000; waited += 5) await new Promise((resolve) => setTimeout(resolve, 5));
  const nativeCard = f.requests.at(-1);
  assert.equal(nativeCard.files.site, undefined);
  await assert.rejects(f.control.answerRequest({ sessionId: "chat", answer: "remember", id: nativeCard.id }), /only available/);
  await f.control.answerRequest({ sessionId: "chat", answer: "always", id: nativeCard.id });
  assert.equal(await native, true);
  assert.equal(await f.control.approveFiles({ sessionId: "chat", app: input.site, files: input.files }), true);
});

test("browser file requests reject invalid origins, stay isolated from native always, and abort", async (t) => {
  const f = fixture(); t.after(() => f.control.reset(true));
  const input = { sessionId: "chat", files: ["/local/report.pdf"], canRemember: true };
  for (const site of ["file:///report.pdf", "https://example.com/path", "https://example.com/", "HTTPS://EXAMPLE.COM", "https://user:pass@example.com", "null"]) {
    assert.equal(await f.control.requestBrowserFiles({ ...input, site }), "dismiss");
  }
  assert.equal(f.requests.length, 0);
  await f.control.setFeatureEnabled(true);
  await browserFileCard(f, f.control.approveFiles({ ...input, app: "https://example.com" }), "always");
  const controller = new AbortController();
  const pending = f.control.requestBrowserFiles({ ...input, site: "https://example.com" }, { signal: controller.signal });
  for (let waited = 0; !f.requests.at(-1) && waited < 2_000; waited += 5) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(f.requests.at(-1).files.site, "https://example.com");
  controller.abort();
  assert.equal(await pending, "aborted");
  await assert.rejects(f.control.answerRequest({ sessionId: "chat", answer: "remember", id: "old" }));
});

test("the browser types a password only on a site the person confirmed, with computer use off", async (t) => {
  const f = fixture(); t.after(() => f.control.reset(true));
  const credentialCards = () => f.requests.filter((request) => request?.reason === "credential");
  const answerSite = async (site, answer) => {
    const before = credentialCards().length;
    for (let waited = 0; credentialCards().length === before && waited < 2_000; waited += 5) await new Promise((resolve) => setTimeout(resolve, 5));
    const card = credentialCards().at(-1);
    assert.deepEqual(card.credential, { site });
    await f.control.answerRequest({ sessionId: "chat", answer, id: card.id });
  };
  const declined = f.control.approveCredential({ sessionId: "chat", site: "https://example.com" });
  await answerSite("https://example.com", "dismiss");
  assert.equal(await declined, false);
  const always = f.control.approveCredential({ sessionId: "chat", site: "https://example.com" });
  await answerSite("https://example.com", "always");
  assert.equal(await always, true);
  const asked = credentialCards().length;
  assert.equal(await f.control.approveCredential({ sessionId: "chat", site: "https://example.com" }), true);
  assert.equal(credentialCards().length, asked, "Always covers that exact site in this chat");
  // Another origin, even a lookalike or the same host over http, asks again.
  const other = f.control.approveCredential({ sessionId: "chat", site: "http://example.com" });
  await answerSite("http://example.com", "dismiss");
  assert.equal(await other, false);
});

function credentialFixture() {
  const seen = [];
  const f = fixture({ seen, toolResult: (name) => {
    if (name !== "computer_act") return undefined;
    // Like the Mac helper with a secure field in the window: nothing is typed until the host sends the approved app.
    return seen.at(-1).args.credential_approval === "com.example.editor" ? text({ ok: true, status: "dispatched" })
      : text({ ok: false, code: "credential_approval_required", app: "Editor", app_id: "com.example.editor", dispatched: false, next: "observe" });
  } });
  const acts = () => seen.filter((call) => call.name === "computer_act").map((call) => call.args);
  const cards = () => f.requests.filter((request) => request?.reason === "credential");
  const answer = async (app, reply, appId = "com.example.editor") => {
    const before = cards().length;
    for (let waited = 0; cards().length === before && waited < 2_000; waited += 5) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(cards().at(-1).credential, { app, appId });
    await f.control.answerRequest({ sessionId: "chat", answer: reply, id: cards().at(-1).id });
  };
  return { ...f, acts, cards, answer };
}
const typeInto = (control, action) => control.execute({ sessionId: "chat", name: "computer_act", args: { observation_id: "observation", action } });

test("typing on a canvas goes straight to the app, and a confirmed password never does", async (t) => {
  const seen = [];
  const f = fixture({ seen, toolResult: (name) => {
    if (name !== "computer_act") return undefined;
    // Like the Mac helper with no observed text field focused: a password or code the person confirmed is refused there.
    return seen.at(-1).args.credential_approval ? text({ ok: false, code: "protected_input", dispatched: false, next: "human_takeover" })
      : text({ ok: true, status: "dispatched" });
  } });
  t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  await f.control.execute({ sessionId: "chat", name: "computer_open", args: { app_id: "com.example.canvas", mode: "control", purpose: "Add a title" } });
  const acts = () => seen.filter((call) => call.name === "computer_act").map((call) => call.args);
  assert.equal(payload(await typeInto(f.control, { type: "type", text: "THE GEOMETRY PLAYGROUND" })).status, "dispatched");
  assert.equal(acts().length, 1, "one call, no second round trip");
  assert.equal(f.requests.filter((request) => request && request.reason !== "credential").length, 0, "no question before canvas text");
  // A secret first asks about the app as usual, then reaches the helper marked, which keeps it out of an unidentified editor.
  const secret = typeInto(f.control, { type: "type", text: "a code", secret: true });
  for (let waited = 0; !f.requests.some((request) => request?.reason === "credential") && waited < 2_000; waited += 5) await new Promise((resolve) => setTimeout(resolve, 5));
  await f.control.answerRequest({ sessionId: "chat", answer: "allow", id: f.requests.find((request) => request?.reason === "credential").id });
  assert.equal(payload(await secret).code, "protected_input", "a password never goes into an unidentified editor");
  assert.equal(acts().at(-1).credential_approval, "com.example.canvas");
});

test("typing next to a password field waits for the person to confirm the app", async (t) => {
  const f = credentialFixture(); t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  await f.control.execute({ sessionId: "chat", name: "computer_open", args: { app_id: "com.example.editor", mode: "control", purpose: "Sign in" } });
  const declined = typeInto(f.control, { type: "type", text: "given-password" });
  await f.answer("Editor", "dismiss");
  assert.equal(payload(await declined).code, "credential_declined");
  assert.equal(f.acts().length, 1, "Nothing is sent again without the person's yes");
  const allowed = typeInto(f.control, { type: "type", text: "given-password" });
  await f.answer("Editor", "allow");
  assert.equal(payload(await allowed).status, "dispatched");
  assert.equal(f.acts().at(-1).credential_approval, "com.example.editor");
});

test("text marked secret goes only to an app the person confirmed, where no field can be detected", async (t) => {
  const f = credentialFixture(); t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  await f.control.execute({ sessionId: "chat", name: "computer_open", args: { app_id: "com.example.editor", mode: "control", purpose: "Sign in" } });
  const declined = typeInto(f.control, { type: "type", text: "given-password", secret: true });
  await f.answer("com.example.editor", "dismiss");
  assert.equal(payload(await declined).code, "credential_declined");
  assert.equal(f.acts().length, 0, "A declined secret never reaches the computer");
  const allowed = typeInto(f.control, { type: "type", text: "given-password", secret: true });
  await f.answer("com.example.editor", "allow");
  assert.equal(payload(await allowed).status, "dispatched");
  // One question covered both the mark and the helper's own check, in one call, and the mark never reaches it.
  assert.equal(f.cards().length, 2);
  assert.equal(f.acts().length, 1);
  assert.equal(f.acts()[0].credential_approval, "com.example.editor");
  assert.ok(f.acts().every((args) => !("secret" in args.action)));
  // Another program can carry the same id, so an app never gets a standing approval.
  assert.equal(f.cards().at(-1).standing, false);
  const again = typeInto(f.control, { type: "type", text: "given-password", secret: true });
  await f.answer("com.example.editor", "always");
  assert.equal(payload(await again).status, "dispatched");
  const asked = f.cards().length;
  const third = typeInto(f.control, { type: "type", text: "given-password", secret: true });
  await f.answer("com.example.editor", "dismiss");
  assert.equal(payload(await third).code, "credential_declined");
  assert.equal(f.cards().length, asked + 1, "An app is asked about every time, even after an always answer");
});

test("a browser app never takes a password: the site cannot be confirmed there", async (t) => {
  const f = credentialFixture(); t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  // Mac bundle ids, Windows executables and Linux window classes.
  const open = async (app) => {
    await f.control.execute({ sessionId: "chat", name: "computer_close", args: {} });
    assert.notEqual(payload(await f.control.execute({ sessionId: "chat", name: "computer_open", args: { app_id: app, mode: "control", purpose: "Sign in" } })).code, "session_open", app);
  };
  for (const app of ["com.apple.Safari", "com.microsoft.edgemac.Dev", "chrome", "msedge", "google-chrome", "microsoft-edge", "Navigator", "firefox-esr", "brave-browser", "org.gnome.Epiphany"]) {
    await open(app);
    assert.equal(payload(await typeInto(f.control, { type: "type", text: "given-password", secret: true })).code, "browser_app", app);
  }
  assert.equal(f.cards().length, 0, "Nobody is asked to approve a browser for every site in it");
  assert.equal(f.acts().length, 0);
  // An app whose name merely contains a browser word is still an app.
  await open("com.example.knowledge");
  const app = typeInto(f.control, { type: "type", text: "given-password", secret: true });
  await f.answer("com.example.knowledge", "dismiss", "com.example.knowledge");
  assert.equal(payload(await app).code, "credential_declined");
});

test("a remote computer never takes a password: a whole-screen session names no app", async (t) => {
  const f = fixture({ remote: true, authority: async () => true }); t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  await f.control.setRemoteEnabled(true);
  await f.control.choose({ sessionId: "chat", targetId: "vm" });
  await f.control.execute({ sessionId: "chat", name: "computer_open", args: { app_id: "desktop", mode: "control", purpose: "Sign in" } });
  assert.equal(payload(await typeInto(f.control, { type: "type", text: "given-password", secret: true })).code, "remote_computer");
  assert.equal(f.requests.filter((request) => request?.reason === "credential").length, 0);
});

test("allowing a file panel to be browsed never becomes a standing approval", async (t) => {
  const f = filePanelFixture({ browsing: true }); t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  await f.control.execute({ sessionId: "chat", name: "computer_open", args: { app_id: "editor", mode: "control", purpose: "Upload" } });
  const look = f.control.execute({ sessionId: "chat", name: "computer_observe", args: {} });
  for (let waited = 0; !f.requests.some((request) => request?.reason === "files") && waited < 2_000; waited += 5) await new Promise((resolve) => setTimeout(resolve, 5));
  await f.control.answerRequest({ sessionId: "chat", answer: "always", id: f.requests.find((request) => request?.reason === "files").id });
  await look;
  const before = f.requests.filter((request) => request?.reason === "files").length;
  const press = confirmPanel(f.control);
  await answerFiles(f, "allow");
  assert.equal(payload(await press).status, "dispatched");
  assert.ok(f.requests.filter((request) => request?.reason === "files").length > before, "handing over files was still asked about");
});

test("a file panel's contents reach the agent only after the person allows it", async (t) => {
  const f = filePanelFixture({ browsing: true }); t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  await f.control.execute({ sessionId: "chat", name: "computer_open", args: { app_id: "editor", mode: "control", purpose: "Upload" } });
  const look = f.control.execute({ sessionId: "chat", name: "computer_observe", args: {} });
  for (let waited = 0; !f.requests.some((request) => request?.reason === "files") && waited < 2_000; waited += 5) await new Promise((resolve) => setTimeout(resolve, 5));
  const request = f.requests.find((request) => request?.reason === "files");
  assert.deepEqual(request.files, { app: "Safari", names: [] }, "browsing is asked about with no files yet");
  await f.control.answerRequest({ sessionId: "chat", answer: "dismiss", id: request.id });
  assert.equal(payload(await look).code, "file_panel_declined");
});

test("a selection longer than one card can show is never approved", async (t) => {
  const many = Array.from({ length: 21 }, (_, index) => `clip-${index}.mp4`);
  const f = filePanelFixture({ files: many }); t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  await f.control.execute({ sessionId: "chat", name: "computer_open", args: { app_id: "editor", mode: "control", purpose: "Upload" } });
  assert.equal(payload(await confirmPanel(f.control)).code, "files_declined");
  assert.ok(!f.requests.some((request) => request?.reason === "files"), "the person is not shown a partial list");
  assert.equal(await f.control.approveFiles({ sessionId: "chat", app: "example.com", files: many }), false);
});

test("a recipient too long to show is refused, never shortened into another's approval", async (t) => {
  const f = filePanelFixture(); t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  await f.control.execute({ sessionId: "chat", name: "computer_open", args: { app_id: "editor", mode: "control", purpose: "Upload" } });
  assert.equal(await f.control.approveFiles({ sessionId: "chat", app: `${"a".repeat(200)}.example.com`, files: ["/tmp/a.txt"] }), false);
  assert.ok(!f.requests.some((request) => request?.reason === "files"));
});

test("same-named selected files are each shown and each approved", async (t) => {
  const f = filePanelFixture({ files: ["clip.mp4", "clip.mp4"] }); t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  await f.control.execute({ sessionId: "chat", name: "computer_open", args: { app_id: "editor", mode: "control", purpose: "Upload" } });
  const press = confirmPanel(f.control);
  for (let waited = 0; !f.requests.some((request) => request?.reason === "files") && waited < 2_000; waited += 5) await new Promise((resolve) => setTimeout(resolve, 5));
  const card = f.requests.find((request) => request?.reason === "files");
  assert.deepEqual(card.files.names, ["clip.mp4", "clip.mp4"]);
  await f.control.answerRequest({ sessionId: "chat", answer: "allow", id: card.id });
  assert.equal(payload(await press).status, "dispatched");
  assert.deepEqual(f.acts().at(-1), ["clip.mp4", "clip.mp4"]);
});

const copyStep = { type: "key", key: "c", modifiers: ["command"] };
test("copy and paste between apps run without a card unless the organization blocks them", async (t) => {
  for (const [effect, expected] of [["allow", "ok"], ["ask", "organization_policy_denied"], ["deny", "organization_policy_denied"]]) {
    const seen = [];
    const policy = [];
    const f = fixture({ seen, movePolicy: async (input) => {
      policy.push(input);
      return effect === "deny" ? { effect, message: "Your organization's agent permissions block copying and pasting between apps (set for Everyone)." } : { effect };
    } }); t.after(() => f.control.reset(true));
    await f.control.setFeatureEnabled(true);
    await f.control.execute({ sessionId: "chat", name: "computer_open", args: { app_id: "editor", mode: "control", purpose: "Copy" } });
    for (const step of [copyStep, { ...copyStep, key: "v" }]) {
      const result = payload(await f.control.execute({ sessionId: "chat", name: "computer_act", args: { observation_id: "observation", action: step } }));
      assert.equal(expected === "ok" ? result.ok : result.code, expected === "ok" ? true : expected, `${effect} ${step.key}`);
    }
    assert.equal(seen.filter((call) => call.name === "computer_act").length, expected === "ok" ? 2 : 0, "a refused copy never reaches the app");
    assert.equal(f.requests.filter(Boolean).length, 0, "copy and paste never ask the person");
    assert.deepEqual(policy.map((input) => input.kind), ["computer_clipboard", "computer_clipboard"]);
  }
});

test("other keys and shortcuts are not checked as copy and paste", async (t) => {
  const policy = [];
  const f = fixture({ movePolicy: async (input) => { policy.push(input); return { effect: "deny", message: "blocked" }; } }); t.after(() => f.control.reset(true));
  await f.control.setFeatureEnabled(true);
  await f.control.execute({ sessionId: "chat", name: "computer_open", args: { app_id: "editor", mode: "control", purpose: "Edit" } });
  for (const action of [{ type: "key", key: "c" }, { type: "key", key: "a", modifiers: ["command"] }, { type: "type", text: "copy" }]) {
    assert.equal(payload(await f.control.execute({ sessionId: "chat", name: "computer_act", args: { observation_id: "observation", action } })).ok, true);
  }
  assert.deepEqual(policy, []);
});
