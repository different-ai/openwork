import assert from "node:assert/strict";
import { test } from "node:test";
import { runCommand, runConcurrent } from "./packaged-smoke-runner.mjs";

test("smoke workers overlap, respect the limit, and drain after a failure", async () => {
  let active = 0;
  let peak = 0;
  const completed = [];
  const release = Promise.withResolvers();
  const running = runConcurrent(Array.from({ length: 7 }, (_, index) => async () => {
    active++;
    peak = Math.max(peak, active);
    await release.promise;
    active--;
    completed.push(index);
    if (index === 0 || index === 4) throw new Error(`failure ${index}`);
  }));
  assert.equal(active, 3);
  release.resolve();
  await assert.rejects(running, (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 2);
    return true;
  });
  assert.equal(peak, 3);
  assert.equal(active, 0);
  assert.deepEqual(completed.sort(), [0, 1, 2, 3, 4, 5, 6]);
});

test("smoke command reports nonzero exit without masking it", async () => {
  const result = await runCommand(process.execPath, ["-e", "process.exit(7)"], { timeout: 5_000, stdio: "ignore" });
  assert.equal(result.status, 7);
  assert.equal(result.timedOut, false);
});

test("timeout kills descendants holding the command output open", { timeout: 10_000 }, async () => {
  const result = await runCommand(process.execPath, ["-e", `
    const { spawn } = require('node:child_process');
    spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
    setInterval(() => {}, 1000);
  `], { timeout: 500, stdio: "pipe" });
  assert.equal(result.timedOut, true);
  assert.equal(result.signal, "SIGKILL");
});

test("spawn failures reject instead of hanging a smoke worker", async () => {
  await assert.rejects(runCommand("/missing/openwork-smoke-command", [], { timeout: 5_000, stdio: "ignore" }), { code: "ENOENT" });
});
