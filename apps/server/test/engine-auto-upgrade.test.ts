import assert from "node:assert/strict";
import { test } from "node:test";
import { engineAutoUpgradeRetry, waitForEngineIdle } from "../src/engine-auto-upgrade.js";

function fixture() {
  const calls: string[] = [];
  const controller = new AbortController();
  return {
    calls, controller,
    options: {
      signal: controller.signal,
      idle: async () => true,
      wait: async () => { calls.push("wait"); },
      idleChecks: 3,
    },
  };
}

test("an idle engine can upgrade immediately", async () => {
  const { calls, options } = fixture();
  await waitForEngineIdle(options);
  assert.deepEqual(calls, []);
});

test("running or unknown tasks wait for idle without being interrupted", async () => {
  const { calls, options } = fixture();
  let checks = 0;
  await waitForEngineIdle({ ...options, idle: async () => ++checks > 2 });
  assert.deepEqual(calls, ["wait", "wait"]);
  assert.equal(checks, 3);
});

test("an engine that never becomes idle is left selected until a later boot", async () => {
  const { calls, options } = fixture();
  await assert.rejects(waitForEngineIdle({ ...options, idle: async () => false }), /not idle/);
  assert.deepEqual(calls, ["wait", "wait", "wait"]);
});

test("shutdown prevents a new idle probe", async () => {
  const { calls, options, controller } = fixture();
  controller.abort(new Error("shutdown"));
  await assert.rejects(waitForEngineIdle({ ...options, idle: async () => assert.fail("must not probe after shutdown") }), /shutdown/);
  assert.deepEqual(calls, []);
});

test("shutdown interrupts the production idle wait", async () => {
  const controller = new AbortController();
  await assert.rejects(waitForEngineIdle({
    signal: controller.signal,
    idle: async () => { queueMicrotask(() => controller.abort(new Error("shutdown"))); return false; },
  }), /shutdown/);
});

test("failed boots use durable exponential backoff bounded at one day", () => {
  assert.deepEqual(engineAutoUpgradeRetry(0, 1_000), { attempts: 1, retryAt: 61_000 });
  assert.deepEqual(engineAutoUpgradeRetry(1, 1_000), { attempts: 2, retryAt: 121_000 });
  assert.deepEqual(engineAutoUpgradeRetry(31, 1_000), { attempts: 32, retryAt: 86_401_000 });
  assert.deepEqual(engineAutoUpgradeRetry(32, 1_000), { attempts: 32, retryAt: 86_401_000 });
});
