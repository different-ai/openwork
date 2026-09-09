import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { createBrowserBoundsSync, type BrowserBounds } from "./browser-bounds-sync";

const BOUNDS = { x: 800, y: 40, width: 400, height: 900 };

function deferred() {
  let resolve!: (value: boolean) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<boolean>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function fixture() {
  const shows: { bounds: BrowserBounds; sessionId: string }[] = [];
  const updates: BrowserBounds[] = [];
  const errors: unknown[] = [];
  const controls = { show: async () => true, setBounds: async () => true };
  let hides = 0;
  const sync = createBrowserBoundsSync({
    show(bounds, sessionId) {
      shows.push({ bounds, sessionId });
      return controls.show();
    },
    setBounds(bounds) {
      updates.push(bounds);
      return controls.setBounds();
    },
    async hide() { hides++; },
  }, "A", (error) => { errors.push(error); });
  return { sync, shows, updates, errors, controls, get hides() { return hides; } };
}

test("shared RAF/RO writer deduplicates idle frames but sends post-RAF layout changes immediately", async () => {
  const { sync, shows, updates } = fixture();
  sync.sync(BOUNDS, 2, false);
  await setImmediate();
  for (let frame = 0; frame < 100; frame++) sync.sync({ ...BOUNDS }, 2, false);
  assert.deepEqual(shows, [{ bounds: BOUNDS, sessionId: "A" }]);
  assert.deepEqual(updates, []);

  // RO can settle panel constraints after RAF. It uses this same writer,
  // which must send now, not defer the new rectangle to another frame.
  const resized = { ...BOUNDS, x: 700, width: 500 };
  sync.sync(resized, 2, false);
  assert.deepEqual(updates, [resized]);
  sync.sync({ ...resized }, 2, false);
  assert.equal(updates.length, 1);
  await setImmediate();

  sync.sync(resized, 2.5, false);
  assert.deepEqual(updates, [resized, resized]);
  await setImmediate();
  sync.invalidate();
  sync.sync(resized, 2.5, false);
  assert.deepEqual(updates, [resized, resized, resized]); // DPR never scales CSS bounds.
});

test("a rejected show stays a failed intent until geometry changes or explicit invalidation", async () => {
  const { sync, shows, updates, controls, errors } = fixture();
  const pending = deferred();
  controls.show = () => pending.promise;
  sync.sync(BOUNDS, 1, false);
  for (let frame = 0; frame < 10; frame++) sync.sync(BOUNDS, 1, false);
  assert.equal(shows.length, 1);
  assert.deepEqual(updates, []);
  pending.resolve(false);
  await setImmediate();
  for (let frame = 0; frame < 10; frame++) {
    sync.sync(BOUNDS, 1, false);
    await setImmediate();
  }
  assert.equal(shows.length, 1);
  assert.deepEqual(errors, []);
  controls.show = async () => true;
  sync.invalidate();
  sync.sync(BOUNDS, 1, false);
  assert.equal(shows.length, 2);
  await setImmediate();
  sync.sync(BOUNDS, 1, false);
  assert.deepEqual(updates, []);
});

test("permanent show errors report once per intent instead of retrying and toasting every frame", async () => {
  const { sync, shows, updates, controls, errors } = fixture();
  const error = new Error("Browser unavailable");
  controls.show = async () => { throw error; };
  for (let frame = 0; frame < 10; frame++) {
    sync.sync(BOUNDS, 1, false);
    await setImmediate();
  }
  assert.equal(shows.length, 1);
  assert.deepEqual(errors, [error]);
  assert.deepEqual(updates, []);

  const resized = { ...BOUNDS, width: 450 };
  controls.show = async () => true;
  sync.sync(resized, 1, false);
  assert.equal(shows.length, 2);
  await setImmediate();
  sync.sync(resized, 1, false);
  assert.deepEqual(updates, []);
});

test("hide supersedes pending show without concurrent shows, stale toasts, or a poisoned cache", async () => {
  const f = fixture();
  const pending = deferred();
  f.controls.show = () => pending.promise;
  f.sync.sync(BOUNDS, 1, false);
  f.sync.invalidate();
  f.sync.sync(BOUNDS, 1, true);
  f.sync.sync(BOUNDS, 1, true);
  assert.equal(f.hides, 1);
  f.sync.sync(BOUNDS, 1, false);
  assert.equal(f.shows.length, 1, "the old show remains the only in-flight show");
  pending.reject(new Error("Superseded"));
  await setImmediate();
  assert.deepEqual(f.errors, []);
  f.controls.show = async () => true;
  f.sync.sync(BOUNDS, 1, false);
  assert.equal(f.shows.length, 2);
  await setImmediate();
  f.sync.sync(BOUNDS, 1, true);
  f.sync.sync(BOUNDS, 1, false);
  assert.equal(f.shows.length, 3, "hide clears same-geometry dedup");
});

test("invalidation during a pending show is not lost, and disposal ignores late show failure", async () => {
  const f = fixture();
  const pending = deferred();
  f.controls.show = () => pending.promise;
  f.sync.sync(BOUNDS, 1, false);
  f.sync.invalidate();
  f.sync.sync(BOUNDS, 1, false);
  assert.equal(f.shows.length, 1);
  pending.resolve(false);
  await setImmediate();
  const next = deferred();
  f.controls.show = () => next.promise;
  f.sync.sync(BOUNDS, 1, false);
  assert.equal(f.shows.length, 2);
  f.sync.dispose();
  next.reject(new Error("Disposed"));
  await setImmediate();
  f.sync.invalidate();
  f.sync.sync(BOUNDS, 2, false);
  assert.equal(f.shows.length, 2);
  assert.equal(f.hides, 1);
  assert.deepEqual(f.errors, []);
});

test("failed bounds sends clear local dedup but superseded failures cannot clear newer geometry", async () => {
  const { sync, updates, controls } = fixture();
  sync.sync(BOUNDS, 1, false);
  await setImmediate();
  const first = { ...BOUNDS, width: 450 };
  const latest = { ...BOUNDS, width: 500 };
  const pending = deferred();
  controls.setBounds = () => pending.promise;
  sync.sync(first, 1, false);
  controls.setBounds = async () => true;
  sync.sync(latest, 1, false);
  await setImmediate();
  pending.reject(new Error("Old bounds failed"));
  await setImmediate();
  sync.sync(latest, 1, false);
  assert.deepEqual(updates, [first, latest]);

  for (const fail of [async () => false, async () => { throw new Error("Bounds failed"); }]) {
    controls.setBounds = fail;
    sync.invalidate();
    sync.sync(latest, 1, false);
    await setImmediate();
    const count = updates.length;
    controls.setBounds = async () => true;
    sync.sync(latest, 1, false);
    assert.equal(updates.length, count + 1);
    await setImmediate();
  }
});
