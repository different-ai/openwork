import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import electron from "electron";

// Run explicitly with `pnpm --filter @openwork/desktop test:browser-secret-swap`.
// Uses hidden native windows; on Linux run under xvfb-run.
test("a secret placeholder is swapped only in requests to the site it is allowed for", { timeout: 150_000 }, async (t) => {
  const profile = await mkdtemp(path.join(tmpdir(), "openwork-secret-swap-test-"));
  t.after(() => rm(profile, { recursive: true, force: true }));
  const env = { ...process.env, OPENWORK_SECRET_SWAP_TEST_PROFILE: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [fileURLToPath(new URL("./fixtures/browser-secret-swap.mjs", import.meta.url))],
    { env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const receipt = stdout.split("\n").find((line) => line.startsWith('{"ok":'));
  assert.ok(receipt, `the fixture printed no receipt (exit ${JSON.stringify(result)})\n${stderr.slice(-2000)}`);
  const { ok, electron: version, chrome, results } = JSON.parse(receipt);
  assert.match(version, /^\d+\.\d+\.\d+/);
  assert.deepEqual(results.filter((entry) => !entry.ok).map((entry) => `${entry.name}: ${entry.error}`), []);
  assert.equal(ok, true);
  assert.ok(results.length >= 25, "every case ran");
  assert.deepEqual(result, { code: 0, signal: null });
  const latency = results.find((entry) => entry.name === "latency of pausing every request")?.facts;
  assert.ok(latency && Object.values(latency).every((value) => typeof value === "number" && value >= 0));
  const ms = (value) => value.toFixed(2);
  t.diagnostic(`Electron ${version} (Chromium ${chrome}): ${results.length} cases passed`);
  // Measured, not asserted: the page's clock is coarse, so the mean over the whole run is the finer number.
  t.diagnostic(`200 small same-origin fetches, per request: mean ${ms(latency.offMeanMs)} ms without interception, ${ms(latency.onMeanMs)} ms with it, ${ms(latency.afterMeanMs)} ms after release;`
    + ` median ${ms(latency.offMedianMs)} / ${ms(latency.onMedianMs)} / ${ms(latency.afterMedianMs)} ms; p95 ${ms(latency.offP95Ms)} ms without, ${ms(latency.onP95Ms)} ms with`);
});
