import assert from "node:assert/strict";
import test from "node:test";
import { eventually, sleep } from "../src/eventually.ts";

test("eventually polls until the default truthy condition passes", async () => {
  let attempts = 0;
  const value = await eventually(() => {
    attempts += 1;
    return attempts >= 3 ? "ready" : "";
  }, { within: 100, intervalMs: 1 });

  assert.equal(value, "ready");
  assert.equal(attempts, 3);
});

test("eventually supports custom conditions and asynchronous probes", async () => {
  let value = 0;
  const result = await eventually(async () => {
    await sleep(1);
    value += 1;
    return value;
  }, { within: 100, intervalMs: 1, until: (candidate) => candidate === 2 });

  assert.equal(result, 2);
});

test("eventually reports its label and last value on timeout", async () => {
  await assert.rejects(
    eventually(() => ({ ready: false }), {
      within: 5,
      intervalMs: 1,
      label: "fake readiness",
      until: (value) => value.ready,
    }),
    /Timed out waiting for fake readiness.*last value: \{"ready":false\}/,
  );
});

test("eventually reports the last probe error on timeout", async () => {
  await assert.rejects(
    eventually(() => {
      throw new Error("fake failure");
    }, { within: 5, intervalMs: 1, label: "erroring probe" }),
    /Timed out waiting for erroring probe.*last error: "fake failure"/,
  );
});
