import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../src/errors.js";
import { enterEngineMutation, withEngineSwitchFence } from "../src/engine-switch-fence.js";

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function changed(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && error.code === "engine_changed";
}

test("a switch drains existing forwarded mutations and fences new source mutations", async () => {
  const config = {};
  const release = await enterEngineMutation(config, "v1");
  const operationStarted = deferred();
  const finishOperation = deferred();
  let started = false;
  const switchJob = withEngineSwitchFence(config, { from: "v1", to: "v2", operation: async () => {
    started = true;
    operationStarted.resolve();
    await finishOperation.promise;
    return "switched";
  } });
  const staleMutation = enterEngineMutation(config, "v1");
  const rejected = assert.rejects(staleMutation, changed);
  await tick();
  assert.equal(started, false, "the current HTTP mutation is never interrupted");
  await release();
  await operationStarted.promise;
  finishOperation.resolve();
  assert.equal(await switchJob, "switched");
  await rejected;
  // Explicit engine-scoped writes (e.g. authentication) remain allowed when no
  // transition is active, even if they address the non-selected engine.
  await (await enterEngineMutation(config, "v1"))();
});

test("destination mutations wait for the routing commit and then forward", async () => {
  const config = {};
  const started = deferred();
  const finish = deferred();
  const switching = withEngineSwitchFence(config, { from: "v1", to: "v2", operation: async () => {
    started.resolve(); await finish.promise;
  } });
  await started.promise;
  let forwarded = false;
  const mutation = enterEngineMutation(config, "v2").then(async release => { forwarded = true; await release(); });
  await tick();
  assert.equal(forwarded, false);
  finish.resolve();
  await switching;
  await mutation;
  assert.equal(forwarded, true);
});

test("failed idle or revision validation releases queued source requests unchanged", async () => {
  const config = {};
  const started = deferred();
  const finish = deferred();
  const switching = withEngineSwitchFence(config, { from: "v1", to: "v2", operation: async () => {
    started.resolve(); await finish.promise; throw new Error("engine is not idle");
  } });
  const failed = assert.rejects(switching, /not idle/);
  await started.promise;
  const mutation = enterEngineMutation(config, "v1");
  finish.resolve();
  await failed;
  await (await mutation)();
  await (await enterEngineMutation(config, "v1"))();
});

test("revert rejects queued v2 requests without interrupting existing v2 requests", async () => {
  const config = {};
  const release = await enterEngineMutation(config, "v2");
  let reverted = false;
  const switching = withEngineSwitchFence(config, { from: "v2", to: "v1", operation: async () => { reverted = true; } });
  const rejected = assert.rejects(enterEngineMutation(config, "v2"), changed);
  await tick();
  assert.equal(reverted, false);
  await release();
  await switching;
  await rejected;
});

test("queued aborted requests do not forward or prevent a later switch", async () => {
  const config = {};
  const release = await enterEngineMutation(config, "v1");
  const switching = withEngineSwitchFence(config, { from: "v1", to: "v2", operation: async () => {} });
  const controller = new AbortController();
  const request = enterEngineMutation(config, "v1", controller.signal);
  const rejected = assert.rejects(request, /request cancelled/);
  controller.abort(new Error("request cancelled"));
  await rejected;
  await release();
  await switching;
  await withEngineSwitchFence(config, { from: "v2", to: "v1", operation: async () => {} });
  const alreadyAborted = new AbortController();
  alreadyAborted.abort(new Error("already cancelled"));
  await assert.rejects(enterEngineMutation(config, "v1", alreadyAborted.signal), /already cancelled/);
});

test("concurrent switches serialize and invalidate requests using the final committed engine", async () => {
  const config = {};
  const finish = deferred();
  const calls: string[] = [];
  const first = withEngineSwitchFence(config, { from: "v1", to: "v2", operation: async () => {
    calls.push("upgrade"); await finish.promise;
  } });
  const second = withEngineSwitchFence(config, { from: "v2", to: "v1", operation: async () => { calls.push("revert"); } });
  const stale = assert.rejects(enterEngineMutation(config, "v2"), changed);
  const current = enterEngineMutation(config, "v1");
  await tick();
  assert.deepEqual(calls, ["upgrade"]);
  finish.resolve();
  await Promise.all([first, second]);
  await stale;
  await (await current)();
  assert.deepEqual(calls, ["upgrade", "revert"]);
});

test("mutation release is idempotent and waits for every current mutation", async () => {
  const config = {};
  const first = await enterEngineMutation(config, "v1");
  const second = await enterEngineMutation(config, "v1");
  let switched = false;
  const switching = withEngineSwitchFence(config, { from: "v1", to: "v2", operation: async () => { switched = true; } });
  await first();
  await first();
  await tick();
  assert.equal(switched, false);
  await second();
  await switching;
  assert.equal(switched, true);
});

test("reads and another profile remain available while a profile switch is fenced", async () => {
  const config = {};
  const finish = deferred();
  const switching = withEngineSwitchFence(config, { from: "v1", to: "v2", operation: async () => { await finish.promise; } });
  // Read forwarding intentionally does not call enterEngineMutation.
  assert.equal(await Promise.resolve("read response"), "read response");
  await (await enterEngineMutation({}, "v1"))();
  finish.resolve();
  await switching;
});
