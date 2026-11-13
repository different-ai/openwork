import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { WINDOWS_HELPER_PROTOCOL, startWindowsApp } from "@openwork/computer-use/computer-windows-driver";
import { createWindowsComputerAdapter } from "./computer-windows.mjs";

const payload = (result) => JSON.parse(result.content.find((item) => item.type === "text").text);
const resourcesPath = join("C:", "OpenWork", "resources");
const helper = join(resourcesPath, "helpers", "openwork-computer-use.exe");
const notepad = { hwnd: "65800", pid: 4120, started: "133400000000000000", app: "notepad", name: "Notepad", title: "Draft - Notepad", region: { x: 100, y: 80, width: 800, height: 600 }, focused: true, minimized: false };
const admin = { hwnd: "65900", pid: 5200, started: "133400000000000001", app: "regsvc", name: "Registry tool", title: "Admin tool", region: { x: 0, y: 0, width: 640, height: 480 }, focused: false, minimized: false,
  restricted: "elevated", message: "This window belongs to an app running with higher privileges (as administrator). OpenWork does not elevate itself to control it." };

/**
 * A stand-in for openwork-computer-use.exe speaking its line protocol.
 * @param {{ check?: Record<string, unknown>, windows?: Array<Record<string, unknown>>, apps?: Array<Record<string, unknown>>, handle?: (request: any, reply: (value: unknown) => void) => unknown }} [options]
 */
function fakeHelper({ check = { protocol: WINDOWS_HELPER_PROTOCOL, ok: true, reason: null, supported: true }, windows = [notepad, admin], apps, handle } = {}) {
  const state = { windows, apps, requests: [], spawned: [] };
  state.spawnChild = (binary, args) => {
    assert.equal(binary, helper);
    /** @type {any} */
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.closed = false;
    const reply = (value) => { if (!child.closed) child.stdout.write(`${JSON.stringify(value)}\n`); };
    const finish = () => { if (child.closed) return; child.closed = true; child.stdout.end(); setImmediate(() => child.emit("close", 0)); };
    child.kill = () => { finish(); return true; };
    state.spawned.push({ args, child });
    if (args[0] === "--check") { setImmediate(() => { reply(check); finish(); }); return child; }
    assert.deepEqual(args, ["serve", "--host-pid", String(process.pid)]);
    let buffer = "";
    child.stdin = new Writable({
      write(chunk, _encoding, done) {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const request = JSON.parse(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          state.requests.push(request);
          const custom = handle?.(request, reply);
          if (custom !== undefined) continue;
          if (request.op === "windows") reply({ id: request.id, ok: true, windows: state.windows });
          else if (request.op === "apps" && state.apps) reply({ id: request.id, ok: true, apps: state.apps });
          else if (request.op === "focus") reply({ id: request.id, ok: true, region: notepad.region });
          else if (request.op === "capture") reply({ id: request.id, ok: true, mode: "screen", width: 800, height: 600, png: Buffer.from("pixels").toString("base64") });
          else if (request.op === "input") reply({ id: request.id, ok: true, completed: request.steps.length, attempted: true });
          else reply({ id: request.id, ok: true });
        }
        done();
      },
      final(done) { finish(); done(); },
    });
    setImmediate(() => reply({ type: "ready", protocol: WINDOWS_HELPER_PROTOCOL, pid: 1 }));
    return child;
  };
  state.ops = (op) => state.requests.filter((request) => request.op === op);
  return state;
}

async function thisPc(t, { startApp = () => assert.fail("no app should be started"), launchWaitMs, launchPollMs = 5, ...options } = {}) {
  const fake = fakeHelper(options);
  const adapter = createWindowsComputerAdapter({ resourcesPath, appRoot: join("C:", "missing"), fileExists: (candidate) => candidate === helper, spawnChild: fake.spawnChild,
    startApp, launchPollMs, ...(launchWaitMs ? { launchWaitMs } : {}) });
  const events = [];
  const transport = await adapter.connect({ signal: new AbortController().signal, onUi: (value) => events.push(value), onClose: () => {} });
  t.after(() => transport.close());
  const call = async (name, args = {}) => payload(await transport.callTool(name, args));
  return { fake, adapter, transport, events, call };
}

async function openNotepad(pc) {
  const session = await pc.call("computer_open_session", { app_id: "notepad", mode: "control", purpose: "Write the draft" });
  assert.equal(session.ok, true);
  const observe = async () => (await pc.call("computer_observe", { session_id: session.session_id })).observation_id;
  const act = (observationId, actions, requestId = "request") => pc.call("computer_act", { session_id: session.session_id, observation_id: observationId, request_id: requestId, actions });
  return { session, observe, act };
}

test("This PC is a local computer whose readiness comes from the helper's own check", async () => {
  /** @type {Array<[Record<string, unknown>, string, RegExp]>} */
  const cases = [
    [{ protocol: WINDOWS_HELPER_PROTOCOL, ok: true, reason: null }, "ready", /ready/],
    [{ protocol: WINDOWS_HELPER_PROTOCOL, ok: false, reason: "desktop_unavailable" }, "unavailable", /locked/],
    [{ protocol: WINDOWS_HELPER_PROTOCOL, ok: false, reason: "noninteractive" }, "unsupported", /signed-in Windows desktop/],
    [{ protocol: "openwork.computer-use/0", ok: true }, "unavailable", /incompatible/],
  ];
  for (const [check, readiness, detail] of cases) {
    const fake = fakeHelper({ check });
    const adapter = createWindowsComputerAdapter({ resourcesPath, fileExists: (candidate) => candidate === helper, spawnChild: fake.spawnChild });
    assert.equal(adapter.id, "this-pc");
    assert.equal(adapter.label, "This PC");
    assert.equal(adapter.placement, "local");
    const status = await adapter.readiness();
    assert.equal(status.readiness, readiness);
    assert.match(status.detail, detail);
  }
  const missing = createWindowsComputerAdapter({ resourcesPath, appRoot: join("C:", "missing"), fileExists: () => false, spawnChild: () => assert.fail("nothing to start") });
  assert.deepEqual(await missing.readiness(), { readiness: "unavailable", detail: "The Windows computer use helper is missing from this OpenWork build. Rebuild or reinstall OpenWork." });
});

test("discovery lists app windows only and names why an admin window can't be used", async (t) => {
  const pc = await thisPc(t);
  const found = await pc.call("computer_discover");
  assert.equal(found.platform, "windows");
  assert.ok(!found.apps.some((app) => app.app_id === "desktop"));
  assert.match(found.keyboard.note, /^Windows: use control for shortcuts/);
  const [editor, tool] = ["notepad", "regsvc"].map((id) => found.apps.find((app) => app.app_id === id));
  assert.equal(editor.name, "Notepad");
  assert.equal(editor.targets[0].unavailable, undefined);
  assert.match(tool.targets[0].unavailable, /as administrator/);
  // Its caption stays private: only the reason reaches the agent.
  assert.equal(tool.targets[0].title, "Unavailable window");
  assert.ok(!JSON.stringify(found).includes(admin.title));

  assert.equal((await pc.call("computer_open_session", { app_id: "regsvc", mode: "control", purpose: "Change a setting" })).code, "target_unsupported");
  assert.equal((await pc.call("computer_open_session", { app_id: "desktop", mode: "control", purpose: "Anything" })).code, "app_not_found");
  assert.deepEqual(pc.fake.ops("focus"), []);
  assert.deepEqual(pc.fake.ops("input"), []);
});

test("input goes to the exact window it observed, with Mac-style shortcuts translated", async (t) => {
  const pc = await thisPc(t);
  const { observe, act } = await openNotepad(pc);
  const receipt = await act(await observe(), [{ type: "key", key: "Return" }, { type: "key", key: "s", modifiers: ["command"] }, { type: "type", text: "Grüße 👋" }, { type: "click", x: 400, y: 300 }]);
  assert.equal(receipt.status, "dispatched");
  const [input] = pc.fake.ops("input");
  assert.deepEqual(input.window, { hwnd: notepad.hwnd, pid: notepad.pid, started: notepad.started });
  assert.deepEqual(input.expect, notepad.region);
  assert.deepEqual(input.steps.slice(0, 3), [{ type: "key", key: "enter" }, { type: "key", key: "s", modifiers: ["control"] }, { type: "type", text: "Grüße 👋" }]);
  // Image pixels of the observation map to window pixels, never screen pixels.
  assert.deepEqual(input.steps[3], { type: "click", x: 400, y: 300 });
});

test("clipboard and window escape chords never reach the helper", async (t) => {
  const pc = await thisPc(t);
  const { observe, act } = await openNotepad(pc);
  for (const [index, action] of [{ type: "key", key: "v", modifiers: ["command"] }, { type: "key", key: "f4", modifiers: ["option"] }, { type: "key", key: "tab", modifiers: ["option"] }].entries()) {
    const receipt = await act(await observe(), [{ type: "type", text: "kept" }, action], `request-${index}`);
    assert.equal(receipt.status, "partial");
    assert.equal(receipt.completed, 0);
    assert.equal(receipt.may_have_acted, false);
    assert.match(receipt.message, /Clipboard, close and app-switch shortcuts are unavailable/);
  }
  assert.deepEqual(pc.fake.ops("input"), []);
});

test("a restarted app never receives input meant for its previous window", async (t) => {
  const pc = await thisPc(t);
  const { observe, act } = await openNotepad(pc);
  const observation = await observe();
  // Same handle, new process run: Windows reused the handle.
  pc.fake.windows = [{ ...notepad, started: "133400000000009999" }];
  const receipt = await act(observation, [{ type: "type", text: "must not arrive" }]);
  assert.equal(receipt.status, "partial");
  assert.match(receipt.message, /selected window closed/);
  assert.deepEqual(pc.fake.ops("input"), []);
});

test("Stop cancels input in flight and closing the session ends the helper", async (t) => {
  let release = () => {};
  const pc = await thisPc(t, {
    handle: (request, reply) => {
      if (request.op === "input") { release = () => reply({ id: request.id, ok: true, completed: 0, attempted: true, code: "cancelled", error: "Computer input stopped." }); return true; }
      if (request.op === "cancel") { reply({ id: request.id, ok: true }); release(); return true; }
      return undefined;
    },
  });
  const { observe, act } = await openNotepad(pc);
  const pending = act(await observe(), [{ type: "type", text: "a long paragraph" }]);
  while (!pc.fake.ops("input").length) await new Promise((resolve) => setImmediate(resolve));
  const view = pc.events.find((event) => event.kind === "state" && event.phase === "working");
  await pc.transport.notifyUi({ id: view.id, action: "stop" });
  const receipt = await pending;
  assert.equal(receipt.status, "partial");
  assert.equal(receipt.may_have_acted, true);
  assert.equal(pc.fake.ops("cancel")[0].target, pc.fake.ops("input")[0].id);
  const serve = pc.fake.spawned.find((entry) => entry.args[0] === "serve");
  assert.equal(serve.child.closed, false);
  await pc.transport.close();
  assert.equal(serve.child.closed, true);
});

const notepadApp = { app: "notepad", name: "Notepad", path: "C:\\Windows\\System32\\notepad.exe" };
const paintApp = { app: "mspaint", name: "Paint", path: "C:\\Windows\\System32\\mspaint.exe" };
const open = (pc, app_id, extra = {}) => pc.call("computer_open_session", { app_id, mode: "control", purpose: "Write the draft", ...extra });

test("discovery also lists installed apps that are not open, without their paths", async (t) => {
  const pc = await thisPc(t, { windows: [notepad], apps: [notepadApp, paintApp] });
  const found = await pc.call("computer_discover");
  // An open app is listed once, with its windows.
  assert.equal(found.apps.filter((app) => app.app_id === "notepad").length, 1);
  assert.equal(found.apps.find((app) => app.app_id === "notepad").windows, 1);
  assert.deepEqual(found.apps.find((app) => app.app_id === "mspaint"), { app_id: "mspaint", name: "Paint", windows: 0, targets: [] });
  assert.match(found.note, /installed but not open: computer_open starts it/);
  assert.ok(!JSON.stringify(found).includes("System32"));
});

test("opening an installed app that is not running starts it, waits for its window and attaches", async (t) => {
  const started = [];
  const pc = await thisPc(t, {
    windows: [], apps: [notepadApp, paintApp],
    startApp: async (file) => { started.push(file); setTimeout(() => { pc.fake.windows = [{ ...notepad, title: "Untitled - Notepad" }]; }, 20); },
  });
  const session = await open(pc, "notepad");
  assert.equal(session.ok, true);
  assert.equal(session.state, "active");
  assert.equal(session.window_title, "Untitled - Notepad");
  // Started once, by the path the helper listed.
  assert.deepEqual(started, [notepadApp.path]);
  assert.equal(pc.fake.ops("focus").length, 1);
  assert.ok((await pc.call("computer_observe", { session_id: session.session_id })).observation_id);
});

test("an app that is already running is attached to, never started again", async (t) => {
  const pc = await thisPc(t, { windows: [notepad], apps: [notepadApp] });
  assert.equal((await open(pc, "notepad")).ok, true);
  assert.deepEqual(pc.fake.ops("apps"), []);
});

test("an app that is not installed is not found, and nothing is started", async (t) => {
  const pc = await thisPc(t, { windows: [], apps: [notepadApp] });
  const result = await open(pc, "winword");
  assert.equal(result.code, "app_not_found");
  assert.match(result.message, /not installed on this computer/);
  // A window id names an open window: it never starts an app.
  assert.equal((await open(pc, "notepad", { window_id: 7 })).code, "app_not_found");
});

test("an app whose window never appears ends in a bounded, honest error", async (t) => {
  const started = [];
  const pc = await thisPc(t, { windows: [], apps: [notepadApp], launchWaitMs: 40, startApp: async (file) => { started.push(file); } });
  const result = await open(pc, "notepad");
  assert.equal(result.ok, false);
  assert.equal(result.code, "app_window_timeout");
  assert.match(result.message, /Notepad was started but showed no window within 1 seconds/);
  assert.match(result.message, /Do not start it again/);
  assert.deepEqual(started, [notepadApp.path]);
  assert.deepEqual(pc.fake.ops("focus"), []);
  // No session was left behind.
  assert.equal((await pc.call("computer_observe", { session_id: "none" })).code, "session_unavailable");
});

test("only apps the helper lists are started: never a path, a command or a mismatched entry", async (t) => {
  const pc = await thisPc(t, { windows: [], apps: [
    notepadApp,
    // Entries whose id is not the program's own file name, or whose path is not absolute, are dropped.
    { app: "calc", name: "Calculator", path: "C:\\Windows\\System32\\cmd.exe" },
    { app: "tool", name: "Tool", path: "tool.exe" },
    { app: "share", name: "Share", path: "\\\\server\\share\\share.exe" },
    { app: "script", name: "Script", path: "C:\\Tools\\script.cmd" },
  ] });
  const listed = (await pc.call("computer_discover")).apps.map((app) => app.app_id);
  assert.deepEqual(listed, ["notepad"]);
  for (const id of ["C:\\Windows\\System32\\cmd.exe", "C:\\Windows\\System32\\notepad.exe", "notepad.exe", "notepad /p secret.txt", "..\\notepad", "cmd /c calc", "calc", "tool", "share", "script", "NOTEPAD"]) {
    const result = await open(pc, id);
    assert.equal(result.code, "app_not_found", id);
    assert.match(result.message, /cannot be started from a path or a command/);
  }
});

test("an app Windows refuses to start reports that, with no session", async (t) => {
  const pc = await thisPc(t, { windows: [], apps: [notepadApp], startApp: async () => { throw new Error("spawn C:\\secret\\path EACCES"); } });
  const result = await open(pc, "notepad");
  assert.equal(result.code, "app_launch_failed");
  assert.equal(result.message, "Windows could not start Notepad. Nothing was opened.");
});

test("an installed app is started directly: no shell and no arguments", async () => {
  const calls = [];
  const spawnChild = (file, args, options) => {
    calls.push({ file, args, options });
    const child = new EventEmitter();
    child.unref = () => { calls.push("unref"); };
    setImmediate(() => child.emit("spawn"));
    return child;
  };
  await startWindowsApp(notepadApp.path, /** @type {any} */ (spawnChild));
  assert.deepEqual(calls, [{ file: notepadApp.path, args: [], options: { cwd: "C:\\Windows\\System32", detached: true, stdio: "ignore", shell: false } }, "unref"]);
  const failing = () => { const child = new EventEmitter(); setImmediate(() => child.emit("error", new Error("ENOENT"))); return child; };
  await assert.rejects(startWindowsApp(notepadApp.path, /** @type {any} */ (failing)), /ENOENT/);
});
