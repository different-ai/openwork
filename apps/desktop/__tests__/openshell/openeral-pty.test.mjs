// Unit tests for apps/desktop/electron/openshell/openeral-pty.mjs.
//
// node-pty needs an actual TTY and is rebuilt for Electron's Node ABI
// (not the system Node that runs `node --test`), so we stub the spawn
// implementation via __testing.installSpawnImpl and verify the session
// map, lifecycle, and handler dispatch with a plain EventEmitter
// pretending to be an IPty.

import test from "node:test";
import assert from "node:assert/strict";

const pty = await import("../../electron/openshell/openeral-pty.mjs");

/**
 * Build a fake IPty. Captures every write/resize/kill, lets the test
 * fire data/exit events on demand.
 */
function makeFakePty() {
  let dataHandler = null;
  let exitHandler = null;
  const events = { writes: [], resizes: [], kills: [] };
  const fake = {
    pid: 12_345,
    write(data) {
      events.writes.push(data);
    },
    resize(cols, rows) {
      events.resizes.push({ cols, rows });
    },
    kill(signal) {
      events.kills.push(signal ?? null);
    },
    onData(handler) {
      dataHandler = handler;
      return { dispose() {} };
    },
    onExit(handler) {
      exitHandler = handler;
      return { dispose() {} };
    },
  };
  return {
    fake,
    events,
    emit(data) {
      dataHandler?.(data);
    },
    exit(exitCode, signal) {
      exitHandler?.({ exitCode, signal });
    },
  };
}

let lastSpawnArgs = null;
let activeFake = null;

test.beforeEach(() => {
  lastSpawnArgs = null;
  activeFake = null;
  pty.__testing.installSpawnImpl(async (opts) => {
    lastSpawnArgs = opts;
    activeFake = makeFakePty();
    return activeFake.fake;
  });
});

test.afterEach(() => {
  pty.__testing.resetAll();
});

// ── openSession ────────────────────────────────────────────────────────

test("openSession: spawns with the given sandbox name + size + returns id", async () => {
  const result = await pty.openSession({
    sandboxName: "openeral-demo",
    cols: 100,
    rows: 30,
  });
  assert.ok(result.id);
  assert.equal(result.sandboxName, "openeral-demo");
  assert.equal(lastSpawnArgs.sandboxName, "openeral-demo");
  assert.equal(lastSpawnArgs.cols, 100);
  assert.equal(lastSpawnArgs.rows, 30);
});

test("openSession: defaults to 120x32 when cols/rows omitted", async () => {
  await pty.openSession({ sandboxName: "x" });
  assert.equal(lastSpawnArgs.cols, 120);
  assert.equal(lastSpawnArgs.rows, 32);
});

test("openSession: rejects empty sandbox name", async () => {
  await assert.rejects(() => pty.openSession({ sandboxName: "" }), /sandboxName is required/);
});

test("openSession: forwards PTY data to onData callback", async () => {
  const received = [];
  await pty.openSession({
    sandboxName: "x",
    onData: (data) => received.push(data),
  });
  activeFake.emit("hello world\n");
  activeFake.emit("more\n");
  assert.deepEqual(received, ["hello world\n", "more\n"]);
});

test("openSession: tracks the session in listSessions", async () => {
  const before = pty.listSessions();
  assert.equal(before.length, 0);
  const result = await pty.openSession({ sandboxName: "openeral-demo" });
  const after = pty.listSessions();
  assert.equal(after.length, 1);
  assert.equal(after[0].id, result.id);
  assert.equal(after[0].sandboxName, "openeral-demo");
  assert.equal(after[0].cols, 120);
  assert.equal(after[0].rows, 32);
  assert.equal(after[0].pid, 12_345);
  assert.ok(after[0].openedAt > 0);
});

// ── writeSession ───────────────────────────────────────────────────────

test("writeSession: forwards string data to the PTY", async () => {
  const { id } = await pty.openSession({ sandboxName: "x" });
  const ok = pty.writeSession(id, "ls\n");
  assert.equal(ok, true);
  assert.deepEqual(activeFake.events.writes, ["ls\n"]);
});

test("writeSession: returns false for unknown session", () => {
  const ok = pty.writeSession("not-a-real-id", "hello");
  assert.equal(ok, false);
});

test("writeSession: coerces non-string input to string", async () => {
  const { id } = await pty.openSession({ sandboxName: "x" });
  pty.writeSession(id, 42);
  assert.deepEqual(activeFake.events.writes, ["42"]);
});

// ── resizeSession ──────────────────────────────────────────────────────

test("resizeSession: forwards new size to the PTY", async () => {
  const { id } = await pty.openSession({ sandboxName: "x", cols: 80, rows: 24 });
  const ok = pty.resizeSession(id, 100, 40);
  assert.equal(ok, true);
  assert.deepEqual(activeFake.events.resizes, [{ cols: 100, rows: 40 }]);
});

test("resizeSession: no-op when size hasn't changed (skips SIGWINCH)", async () => {
  const { id } = await pty.openSession({ sandboxName: "x", cols: 80, rows: 24 });
  pty.resizeSession(id, 80, 24);
  assert.equal(activeFake.events.resizes.length, 0);
});

test("resizeSession: floors fractional sizes", async () => {
  const { id } = await pty.openSession({ sandboxName: "x", cols: 80, rows: 24 });
  pty.resizeSession(id, 100.7, 40.3);
  assert.deepEqual(activeFake.events.resizes, [{ cols: 100, rows: 40 }]);
});

test("resizeSession: returns false for unknown session", () => {
  assert.equal(pty.resizeSession("not-a-real-id", 100, 40), false);
});

test("resizeSession: keeps previous size when called with NaN", async () => {
  const { id } = await pty.openSession({ sandboxName: "x", cols: 80, rows: 24 });
  pty.resizeSession(id, NaN, NaN);
  assert.equal(activeFake.events.resizes.length, 0);
  const sessions = pty.listSessions();
  assert.equal(sessions[0].cols, 80);
  assert.equal(sessions[0].rows, 24);
});

// ── closeSession ───────────────────────────────────────────────────────

test("closeSession: kills the PTY with SIGTERM by default", async () => {
  const { id } = await pty.openSession({ sandboxName: "x" });
  pty.closeSession(id);
  assert.deepEqual(activeFake.events.kills, ["SIGTERM"]);
});

test("closeSession: accepts a custom signal", async () => {
  const { id } = await pty.openSession({ sandboxName: "x" });
  pty.closeSession(id, "SIGKILL");
  assert.deepEqual(activeFake.events.kills, ["SIGKILL"]);
});

test("closeSession: removes the session from the map when onExit fires", async () => {
  const { id } = await pty.openSession({ sandboxName: "x" });
  assert.equal(pty.listSessions().length, 1);
  pty.closeSession(id);
  // Simulate node-pty's onExit firing after kill.
  activeFake.exit(0);
  assert.equal(pty.listSessions().length, 0);
});

test("closeSession: returns false for unknown session", () => {
  assert.equal(pty.closeSession("not-a-real-id"), false);
});

// ── onExit handler dispatch ────────────────────────────────────────────

test("onExit handler fires with exit code + signal", async () => {
  const exits = [];
  await pty.openSession({
    sandboxName: "x",
    onExit: (code, signal) => exits.push({ code, signal }),
  });
  activeFake.exit(7, "SIGTERM");
  assert.deepEqual(exits, [{ code: 7, signal: "SIGTERM" }]);
});

test("onExit removes the session from listSessions even without explicit close", async () => {
  await pty.openSession({ sandboxName: "x" });
  assert.equal(pty.listSessions().length, 1);
  activeFake.exit(0);
  assert.equal(pty.listSessions().length, 0);
});

// ── attachHandlers ─────────────────────────────────────────────────────

test("attachHandlers: replaces the onData handler for a live session", async () => {
  const initial = [];
  const replacement = [];
  const { id } = await pty.openSession({
    sandboxName: "x",
    onData: (d) => initial.push(d),
  });
  activeFake.emit("first");
  pty.attachHandlers(id, { onData: (d) => replacement.push(d) });
  activeFake.emit("second");
  assert.deepEqual(initial, ["first"]);
  assert.deepEqual(replacement, ["second"]);
});

test("attachHandlers: leaves the existing handler in place when not specified", async () => {
  const received = [];
  const { id } = await pty.openSession({
    sandboxName: "x",
    onData: (d) => received.push(d),
  });
  pty.attachHandlers(id, {}); // no replacement
  activeFake.emit("still-routed");
  assert.deepEqual(received, ["still-routed"]);
});

test("attachHandlers: returns false for unknown session", () => {
  assert.equal(pty.attachHandlers("not-a-real-id", { onData: () => {} }), false);
});

// ── closeAllSessions ───────────────────────────────────────────────────

test("closeAllSessions: kills every live PTY", async () => {
  await pty.openSession({ sandboxName: "a" });
  const fakeA = activeFake;
  await pty.openSession({ sandboxName: "b" });
  const fakeB = activeFake;
  assert.equal(pty.listSessions().length, 2);
  pty.closeAllSessions();
  assert.deepEqual(fakeA.events.kills, ["SIGTERM"]);
  assert.deepEqual(fakeB.events.kills, ["SIGTERM"]);
});

// ── multiple sessions don't cross-talk ────────────────────────────────

test("multiple sessions track distinct IPty instances", async () => {
  const aData = [];
  const bData = [];
  const { id: idA } = await pty.openSession({
    sandboxName: "alpha",
    onData: (d) => aData.push(d),
  });
  const fakeA = activeFake;
  const { id: idB } = await pty.openSession({
    sandboxName: "bravo",
    onData: (d) => bData.push(d),
  });
  const fakeB = activeFake;
  assert.notEqual(idA, idB);
  fakeA.emit("only-a");
  fakeB.emit("only-b");
  assert.deepEqual(aData, ["only-a"]);
  assert.deepEqual(bData, ["only-b"]);
});
