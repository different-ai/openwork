import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createNativeDictation, createSpeechDictation, helperEvent, SPEECH_DICTATION_EVENT, windowsDictationScript } from "../electron/native-dictation.mjs";

function surface() {
  const sender = { mainFrame: {}, isFocused: () => true };
  return { event: { sender, senderFrame: sender.mainFrame }, window: { webContents: sender, isFocused: () => true } };
}

function action(options) {
  const adapter = createNativeDictation(options);
  return (event, window) => adapter.start(event, window, "request-1");
}

test("macOS sends only the native dictation action to the trusted focused main frame", async () => {
  const actions = [];
  const start = action({ platform: "darwin", menu: { sendActionToFirstResponder: action => actions.push(action) } });
  const { event, window } = surface();
  assert.deepEqual(await start(event, window), { ok: true });
  assert.deepEqual(actions, ["startDictation:"]);
  assert.deepEqual(await start({ ...event, senderFrame: {} }, window), { ok: false, reason: "not_focused" });
  assert.deepEqual(await start(event, { ...window, isFocused: () => false }), { ok: false, reason: "not_focused" });
  assert.deepEqual(await start(event, { ...window, webContents: {} }), { ok: false, reason: "not_focused" });
  event.sender.isFocused = () => false;
  assert.deepEqual(await start(event, window), { ok: false, reason: "not_focused" });
  assert.equal(actions.length, 1);
});

test("Windows uses the system executable and fixed chord, and bounds a blocked helper", async () => {
  const calls = [];
  const start = action({ platform: "win32", processId: 1234, systemRoot: "C:\\Windows", execute: async (...args) => { calls.push(args); } });
  const { event, window } = surface();
  assert.deepEqual(await start(event, window), { ok: true });
  assert.equal(calls[0][0], "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.deepEqual(calls[0][1].slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
  assert.equal(calls[0][2].timeout, 8000);
  assert.equal(calls[0][2].windowsHide, true);
  assert.match(calls[0][1][3], /pid != 1234/);
  assert.match(calls[0][1][3], /GetAsyncKeyState/);
  assert.throws(() => windowsDictationScript("1234; injected"));
});

test("helper failure is recoverable and repeated clicks cannot toggle dictation twice", async () => {
  let reject;
  let calls = 0;
  const start = action({ platform: "win32", processId: 1234, systemRoot: "C:\\Windows", execute: () => {
    calls++;
    return new Promise((_resolve, fail) => { reject = fail; });
  } });
  const { event, window } = surface();
  const first = start(event, window);
  assert.deepEqual(await start(event, window), { ok: false, reason: "failed" });
  assert.equal(calls, 1);
  reject(new Error("System policy blocked PowerShell"));
  assert.deepEqual(await first, { ok: false, reason: "failed" });
  const retry = start(event, window);
  assert.equal(calls, 2);
  reject(new Error("No voice typing"));
  assert.deepEqual(await retry, { ok: false, reason: "failed" });
});

test("unsupported systems never launch a helper", async () => {
  const { event, window } = surface();
  const start = action({ platform: "linux", execute: () => assert.fail("must not execute") });
  assert.deepEqual(await start(event, window), { ok: false, reason: "unavailable" });
});

test("only the owning main frame can cancel its pending launch", async () => {
  let signal;
  const adapter = createNativeDictation({ platform: "win32", processId: 1234, systemRoot: "C:\\Windows", execute: (_file, _args, options) => {
    signal = options.signal;
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true }));
  } });
  const { event, window } = surface();
  const launch = adapter.start(event, window, "request-1");
  assert.equal(adapter.cancel(event, "other-request"), false);
  assert.equal(adapter.cancel({ ...event, senderFrame: {} }, "request-1"), false);
  assert.equal(adapter.cancel(surface().event, "request-1"), false);
  assert.equal(signal.aborted, false);
  assert.equal(adapter.cancel(event, "request-1"), true);
  assert.equal(signal.aborted, true);
  assert.deepEqual(await launch, { ok: false, reason: "failed" });
});

function helperProcess() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stdin = new PassThrough();
  child.written = [];
  child.stdin.on("data", chunk => child.written.push(String(chunk)));
  child.kill = () => child.emit("exit", null, "SIGTERM");
  return child;
}

function speechHelper(options = {}) {
  const spawned = [];
  const adapter = createSpeechDictation({
    platform: "darwin", helperPath: "/App/helpers/openwork-dictation", infoPlist: "/App/Info.plist",
    exists: () => true, readText: () => "<key>NSSpeechRecognitionUsageDescription</key>",
    spawnHelper: (file, args, options) => { const child = helperProcess(); spawned.push({ file, args, options, child }); return child; },
    ...options,
  });
  return { adapter, spawned };
}

test("speech dictation needs the helper, and on macOS the speech usage string", () => {
  assert.equal(speechHelper().adapter.mode(), "local");
  assert.equal(speechHelper({ readText: () => "<key>NSMicrophoneUsageDescription</key>" }).adapter.mode(), null);
  assert.equal(speechHelper({ exists: () => false }).adapter.mode(), null);
  assert.equal(speechHelper({ platform: "win32", readText: () => "" }).adapter.mode(), "online");
  assert.equal(speechHelper({ platform: "win32", exists: () => false }).adapter.mode(), null);
  assert.equal(speechHelper({ platform: "linux" }).adapter.mode(), null);
});

test("the Windows helper gets only the system folders it needs", () => {
  const { adapter, spawned } = speechHelper({ platform: "win32", helperPath: "C:\\OpenWork\\helpers\\openwork-dictation.exe",
    env: { SystemRoot: "C:\\Windows", TEMP: "C:\\Temp", OPENAI_API_KEY: "secret", NODE_OPTIONS: "--require x" } });
  const { event, window } = surface();
  event.sender.send = () => {};
  assert.deepEqual(adapter.start(event, window, "request-1", "en-GB"), { ok: true });
  assert.deepEqual(spawned[0].args, ["--locale", "en-GB"]);
  assert.deepEqual(spawned[0].options.env, { SystemRoot: "C:\\Windows", TEMP: "C:\\Temp" });
  assert.equal(spawned[0].options.windowsHide, true);
});

test("on-device dictation streams known helper events to the owning frame and stops on request", async () => {
  const { adapter, spawned } = speechHelper();
  const { event, window } = surface();
  const sent = [];
  event.sender.send = (channel, payload) => sent.push({ channel, payload });
  assert.deepEqual(adapter.start(event, window, "request-1", "en-US; rm -rf"), { ok: true });
  assert.deepEqual(spawned[0].args, ["--locale", "en-US"]);
  assert.deepEqual(adapter.start(event, window, "request-2", "en-US"), { ok: false, reason: "failed" });
  const { child } = spawned[0];
  child.stdout.write('{"type":"ready"}\nnot json\n{"type":"result","segments":["Hello there.","how are"]}\n{"type":"result","segments":[1]}\n{"type":"error","code":"anything"}\n');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sent.map(item => item.payload), [
    { id: "request-1", type: "ready" },
    { id: "request-1", type: "result", segments: ["Hello there.", "how are"] },
    { id: "request-1", type: "error", code: "network" },
  ]);
  assert.ok(sent.every(item => item.channel === SPEECH_DICTATION_EVENT));
  assert.equal(adapter.stop(surface().event, "request-1"), false);
  assert.equal(adapter.stop(event, "request-1"), true);
  assert.deepEqual(child.written, ["stop\n"]);
  child.emit("exit", 0, null);
  assert.deepEqual(sent.at(-1).payload, { id: "request-1", type: "end" });
  assert.deepEqual(adapter.start(event, window, "request-3", "fr-FR"), { ok: true });
});

test("helper events outside the known shapes are dropped", () => {
  assert.equal(helperEvent('{"type":"debug","audio":"..."}'), null);
  assert.deepEqual(helperEvent('{"type":"end","extra":true}'), { type: "end" });
  assert.deepEqual(helperEvent('{"type":"error","code":"not-allowed"}'), { type: "error", code: "not-allowed" });
});
