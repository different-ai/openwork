import assert from "node:assert/strict";
import test from "node:test";
import { createReauthQueue } from "./reauth-recovery";

test("cancel pauses the original action; resume reopens the check and only verification retries it", async () => {
  const queue = createReauthQueue<() => Promise<void>>();
  let saves = 0;
  const save = async () => { saves += 1; };
  queue.enqueue([save]);
  assert.equal(queue.pause(), true);
  assert.deepEqual(queue.takeVerified(), []);
  assert.equal(saves, 0);
  assert.equal(queue.resume(), true);
  assert.equal(queue.resume(), false);
  assert.equal(saves, 0);
  for (const action of queue.takeVerified()) await action();
  assert.equal(saves, 1);
  assert.deepEqual(queue.takeVerified(), []);
});

test("discarding a paused change prevents it from being reopened or retried", () => {
  const queue = createReauthQueue<string>();
  queue.enqueue(["original change"]);
  queue.pause();
  assert.deepEqual(queue.clear(), ["original change"]);
  assert.equal(queue.resume(), false);
  assert.deepEqual(queue.takeVerified(), []);
});
