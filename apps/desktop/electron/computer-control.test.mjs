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
    connect: async ({ onClose, onUi }) => {
      calls.push("connect");
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
  const control = createComputerControl({ adapters: options.remote ? [adapter, remote] : [adapter], readRemoteFeatureEnabled: options.authority, runProgram: options.runProgram, runScript: options.runScript, onTiming: options.onTiming, browserTask: options.browserTask, onRequest: (_sessionId, value) => { requests.push(value); }, idleMs: options.idleMs ?? 90_000, platform: options.platform });
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
  const result = await f.control.execute({ sessionId: "chat", name: "computer_act", args: { observation_id: "old", action: { type: "click", x: 1, y: 1 } } });
  assert.equal(payload(result).code, "observation_required");
  assert.equal(f.calls.filter(name => name === "computer_open_session").length, 3);
  assert.ok(!f.calls.includes("computer_act"));
  assert.deepEqual(f.selected, []);
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

test("scripts run under the computer use flag, the chat's access, the person's approval and this Mac only", async (t) => {
  const ran = [];
  const f = fixture({ remote: true, authority: async () => true, runScript: async (request) => { ran.push(request); return { ok: true, stdout: "done" }; } });
  t.after(() => f.control.reset(true));
  assert.equal((await f.control.script({ sessionId: "chat", app: "applescript", code: "return 1" })).error.code, "computer_unavailable");
  await f.control.setFeatureEnabled(true);
  assert.equal((await f.control.script({ sessionId: "chat", app: "terminal", code: "ls" })).error.code, "invalid_arguments");
  const pending = f.control.script({ sessionId: "chat", app: "applescript", code: "return 1" });
  const request = await scriptRequest(f, "return 1");
  assert.deepEqual(request.script, { app: "applescript", code: "return 1" }, "the person sees the exact full script");
  assert.deepEqual(ran, [], "nothing runs before the answer");
  await assert.rejects(f.control.answerRequest({ sessionId: "chat", answer: "allow", id: "another-request" }), /changed/);
  await f.control.answerRequest({ sessionId: "chat", answer: "allow", id: request.id });
  assert.deepEqual(await pending, { ok: true, stdout: "done" });
  assert.deepEqual(ran, [{ app: "applescript", code: "return 1", timeoutMs: 30_000 }]);
  assert.equal(f.requests.at(-1), null);
  await f.control.setRemoteEnabled(true);
  await f.control.choose({ sessionId: "chat", targetId: "vm" });
  assert.equal((await f.control.script({ sessionId: "chat", app: "jxa", code: "1" })).error.code, "script_unavailable");
  assert.equal(ran.length, 1);
});

test("declined scripts never run, always-run skips the question for that app, and turning computer use off stops scripts", async (t) => {
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
  const declined = f.control.script({ sessionId: "chat", app: "jxa", code: "first" });
  await f.control.answerRequest({ sessionId: "chat", answer: "dismiss", id: (await scriptRequest(f, "first")).id });
  assert.equal((await declined).error.code, "script_declined");
  assert.deepEqual(ran, []);
  const always = f.control.script({ sessionId: "chat", app: "jxa", code: "second" });
  await f.control.answerRequest({ sessionId: "chat", answer: "always", id: (await scriptRequest(f, "second")).id });
  assert.equal((await always).ok, true);
  const shown = f.requests.length;
  assert.equal((await f.control.script({ sessionId: "chat", app: "jxa", code: "third" })).ok, true);
  assert.equal(f.requests.length, shown, "no new question for an always-run app");
  const waiting = f.control.script({ sessionId: "chat", app: "blender", code: "result = 1" });
  await scriptRequest(f, "result = 1");
  const running = f.control.script({ sessionId: "other", app: "jxa", code: "slow" });
  const other = await scriptRequest(f, "slow");
  await f.control.answerRequest({ sessionId: "other", answer: "allow", id: other.id });
  for (let waited = 0; !ran.includes("slow") && waited < 2_000; waited += 5) await new Promise((resolve) => setTimeout(resolve, 5));
  await f.control.setFeatureEnabled(false);
  assert.equal((await waiting).error.code, "script_declined", "a pending approval ends when computer use is turned off");
  assert.equal((await running).error.code, "script_failed", "a running script is stopped");
  release();
  assert.deepEqual(ran, ["second", "third", "slow"]);
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
