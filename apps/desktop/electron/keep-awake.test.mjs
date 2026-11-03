import assert from "node:assert/strict";
import test from "node:test";

import { createKeepAwake } from "./keep-awake.mjs";

function fakeBlocker() {
  let nextId = 1;
  /** @type {Set<number>} */
  const started = new Set();
  /** @type {string[]} */
  const types = [];
  return {
    started,
    types,
    /** @param {"prevent-app-suspension" | "prevent-display-sleep"} type */
    start(type) {
      types.push(type);
      const id = nextId++;
      started.add(id);
      return id;
    },
    /** @param {number} id */
    stop(id) {
      started.delete(id);
    },
    /** @param {number} id */
    isStarted(id) {
      return started.has(id);
    },
  };
}

test("holds one blocker while any window wants to stay awake", () => {
  const blocker = fakeBlocker();
  const keepAwake = createKeepAwake({ powerSaveBlocker: blocker });

  assert.deepEqual(keepAwake.set(1, true), { active: true });
  keepAwake.set(1, true);
  keepAwake.set(2, true);
  assert.equal(blocker.started.size, 1);
  assert.deepEqual(blocker.types, ["prevent-app-suspension"]);

  keepAwake.set(1, false);
  assert.equal(keepAwake.isActive(), true);
  assert.deepEqual(keepAwake.set(2, false), { active: false });
  assert.equal(blocker.started.size, 0);
});

test("releases when the last window goes away or the app quits", () => {
  const blocker = fakeBlocker();
  const keepAwake = createKeepAwake({ powerSaveBlocker: blocker });

  keepAwake.set(1, true);
  keepAwake.forget(1);
  assert.equal(blocker.started.size, 0);

  keepAwake.set(1, true);
  keepAwake.set(2, true);
  keepAwake.releaseAll();
  assert.equal(blocker.started.size, 0);
  assert.equal(keepAwake.isActive(), false);
});

test("starts a new blocker if the old one was stopped elsewhere", () => {
  const blocker = fakeBlocker();
  const keepAwake = createKeepAwake({ powerSaveBlocker: blocker });

  keepAwake.set(1, true);
  blocker.started.clear();
  keepAwake.set(1, true);
  assert.equal(blocker.started.size, 1);
});
