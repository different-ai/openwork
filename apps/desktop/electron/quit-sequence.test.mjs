import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createQuitSequencer } from "./quit-sequence.mjs";

/** Manual timer queue so the tests control every macrotask the sequencer schedules. */
function fakeTimers() {
  const timers = new Map();
  let nextId = 1;
  let now = 0;
  return {
    schedule(fn, delayMs) {
      const id = nextId++;
      timers.set(id, { fn, at: now + delayMs });
      return id;
    },
    cancel(id) {
      timers.delete(id);
    },
    /** Run every timer due within `ms`, in due order. */
    async advance(ms) {
      const until = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at);
        if (due.length === 0) break;
        const [id, timer] = due[0];
        timers.delete(id);
        now = timer.at;
        timer.fn();
        await Promise.resolve();
      }
      now = until;
    },
    pending: () => timers.size,
  };
}

function harness(stop, options = {}) {
  const timers = fakeTimers();
  const calls = [];
  const reports = [];
  /** Mirrors Browser::Quit(): before-quit is emitted synchronously; preventDefault is read after the emit. */
  const emitBeforeQuit = () => {
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    sequencer.handleBeforeQuit(event);
    calls.push(event.prevented ? "before-quit:prevented" : "before-quit:proceed");
    return event.prevented;
  };
  const sequencer = createQuitSequencer({
    stop,
    quit: () => {
      calls.push("quit");
      // Electron re-emits before-quit for this app.quit() call.
      if (!emitBeforeQuit()) {
        calls.push("will-quit");
        sequencer.handleWillQuit();
      }
    },
    exit: () => calls.push("exit"),
    schedule: timers.schedule,
    cancel: timers.cancel,
    report: (message) => reports.push(message),
    ...options,
  });
  return { sequencer, timers, calls, reports, emitBeforeQuit };
}

/** Flush the microtask queue without running any macrotask. */
const microtasks = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

describe("quit sequencer", () => {
  it("never calls app.quit() from inside the before-quit emit when stop settles in microtasks", async () => {
    const h = harness(async () => undefined);
    const prevented = h.emitBeforeQuit();
    assert.equal(prevented, true);
    await microtasks();
    // Still inside the "emit" as far as Electron is concerned: nothing may have quit.
    assert.deepEqual(h.calls, ["before-quit:prevented"]);
    assert.equal(h.sequencer.phase(), "quitting");
    await h.timers.advance(0);
    assert.deepEqual(h.calls, ["before-quit:prevented", "quit", "before-quit:proceed", "will-quit"]);
    assert.equal(h.sequencer.phase(), "gone");
    assert.equal(h.timers.pending(), 0, "the exit failsafe stands down once will-quit fires");
  });

  it("does not prevent the re-emitted before-quit and quits once per stop", async () => {
    let stops = 0;
    const h = harness(async () => { stops += 1; });
    h.emitBeforeQuit();
    h.emitBeforeQuit();
    await microtasks();
    await h.timers.advance(0);
    assert.equal(stops, 1);
    assert.equal(h.calls.filter((c) => c === "quit").length, 1);
    assert.deepEqual(h.calls, ["before-quit:prevented", "before-quit:prevented", "quit", "before-quit:proceed", "will-quit"]);
  });

  it("quits when stop rejects", async () => {
    const h = harness(async () => { throw new Error("server refused to stop"); });
    h.emitBeforeQuit();
    await microtasks();
    await h.timers.advance(0);
    assert.ok(h.calls.includes("quit"));
    assert.ok(h.reports.some((m) => m.includes("stop services before quit failed")));
  });

  it("quits when stop throws synchronously", async () => {
    const h = harness(() => { throw new Error("boom"); });
    h.emitBeforeQuit();
    await microtasks();
    await h.timers.advance(0);
    assert.ok(h.calls.includes("quit"));
  });

  it("quits at the deadline when stop never settles", async () => {
    const h = harness(() => new Promise(() => undefined), { stopDeadlineMs: 10_000 });
    h.emitBeforeQuit();
    await h.timers.advance(9_999);
    assert.deepEqual(h.calls, ["before-quit:prevented"]);
    await h.timers.advance(1);
    assert.ok(h.calls.includes("quit"));
    assert.ok(h.reports.some((m) => m.includes("longer than 10000ms")));
  });

  it("falls back to app.exit() when app.quit() never reaches will-quit", async () => {
    const h = harness(async () => undefined, {
      exitFailsafeMs: 5_000,
      quit: () => { h.calls.push("quit"); /* a window refused to close; will-quit never fires */ },
    });
    h.emitBeforeQuit();
    await microtasks();
    await h.timers.advance(0);
    assert.deepEqual(h.calls, ["before-quit:prevented", "quit"]);
    await h.timers.advance(4_999);
    assert.equal(h.calls.includes("exit"), false);
    await h.timers.advance(1);
    assert.ok(h.calls.includes("exit"));
  });

  it("does not exit after a quit that completed", async () => {
    const h = harness(async () => undefined);
    h.emitBeforeQuit();
    await microtasks();
    await h.timers.advance(60_000);
    assert.equal(h.calls.includes("exit"), false);
  });
});
