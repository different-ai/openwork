import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import electron from "electron";

// Explicit native regression suite; Linux needs xvfb-run.
test("secret handles withstand hostile pages through the shipping task host", { timeout: 140_000 }, async (t) => {
  const profile = await mkdtemp(path.join(tmpdir(), "openwork-secret-pages-"));
  t.after(() => rm(profile, { recursive: true, force: true }));
  const env = { ...process.env, OPENWORK_SECRET_PAGES_PROFILE: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [fileURLToPath(new URL("./fixtures/browser-secret-pages.mjs", import.meta.url))],
    { env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  let stdout = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  // Chromium diagnostics can quote page data; never relay its stderr to the test reporter.
  child.stderr.resume();
  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const line = stdout.split("\n").find((entry) => entry.startsWith('{"ok":'));
  assert.ok(line, "the native fixture produced its summary");
  const summary = JSON.parse(line);
  for (const result of summary.results) t.diagnostic(`${result.ok ? "PASS" : "FAIL"} ${result.name}${result.facts ? ` ${JSON.stringify(result.facts)}` : ""}${result.error ? `: ${result.error}` : ""}`);
  assert.match(summary.electron, /^\d+\.\d+\.\d+/);
  assert.equal(summary.results.length, 40, "all hostile-page and real product-panel scenarios ran");
  assert.ok(summary.results.some(result => result.name === "16 real createBrowserPanel product path" && result.ok), "the real product panel passed its native regression proof");
  assert.deepEqual(exit, { code: 0, signal: null });
  assert.deepEqual(summary.results.filter((result) => !result.ok).map(({ name, error }) => ({ name, error })), []);
  assert.equal(summary.ok, true);
});
