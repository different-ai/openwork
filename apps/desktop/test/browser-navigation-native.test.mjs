import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import electron from "electron";

// Run explicitly with `pnpm --filter @openwork/desktop test:native-navigation`.
// Uses a hidden native window; on Linux run under xvfb-run.
test("a person can take over a navigating tab without crashing the desktop", { timeout: 25000 }, async (t) => {
  const profile = await mkdtemp(path.join(tmpdir(), "openwork-navigation-test-"));
  t.after(() => rm(profile, { recursive: true, force: true }));
  const env = { ...process.env, OPENWORK_NAVIGATION_TEST_PROFILE: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [fileURLToPath(new URL("./fixtures/browser-navigation-native.mjs", import.meta.url))],
    { env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  assert.deepEqual(result, { code: 0, signal: null }, `${stdout}\n${stderr}`);
  const receipt = stdout.split("\n").find((line) => line.startsWith('{"ok":true'));
  assert.ok(receipt, stdout);
  const { electron: version, ...facts } = JSON.parse(receipt);
  assert.match(version, /^\d+\.\d+\.\d+/);
  assert.deepEqual(facts, { ok: true, navigationWitness: true, stops: 1, page: "Browser still usable" });
  t.diagnostic(`Electron ${version}: native navigation cancelled; tab remains usable`);
});
