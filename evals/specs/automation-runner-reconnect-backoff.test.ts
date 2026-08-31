import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "@openwork/testkit";
import { expect } from "vitest";

const expectedDelays = [500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000, 30_000];
const runnerUnitTest = fileURLToPath(new URL("../../apps/desktop/electron/automation-runner.test.mjs", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

function requestBudget(delays: number[], windowMs: number): number {
  let attempts = 0;
  let nextAttemptAt = 0;
  while (nextAttemptAt < windowMs) {
    nextAttemptAt += delays[Math.min(attempts, delays.length - 1)];
    attempts += 1;
  }
  return attempts;
}

test("desktop Automation runner retires rejected credentials without changing transient backoff", async ({ evidence }) => {
  // automation-runner.mjs resolves @openwork/headless-threads through its
  // published "default" export (dist/index.js) when run under plain node,
  // so the package must be built before the unit test can load.
  const build = spawnSync("pnpm", ["--filter", "@openwork/headless-threads", "build"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  expect(build.status, build.stderr || build.stdout).toBe(0);

  const unit = spawnSync(process.execPath, [
    "--test",
    "--test-reporter=tap",
    runnerUnitTest,
  ], { encoding: "utf8" });
  expect(unit.status, unit.stderr || unit.stdout).toBe(0);
  expect(unit.stdout).toContain("repeated HTTP 502 responses retain exponential runner reconnect backoff");
  expect(unit.stdout).toContain("HTTP 401 from work retires exactly that credential without reconnecting");
  expect(unit.stdout).toContain("HTTP 403 from work retires exactly that credential without reconnecting");
  expect(unit.stdout).toContain("HTTP 401 and 403 from every assignment route retire the credential");
  expect(unit.stdout).toContain("a new credential reconciles immediately and a late rejection cannot retire it");
  expect(unit.stdout).toContain("a late rejection retires a newer generation that reused the same credential");
  expect(unit.stdout).toContain("routine credential rotation waits for the active assignment to complete");
  expect(unit.stdout).toContain("routine credential rotation waits for an in-flight claim");
  expect(unit.stdout).toContain("retiring a generation cancels its reconnect wait");
  expect(unit.stdout).toContain("a healthy work poll resets runner reconnect backoff");
  expect(unit.stdout).toContain("waking the machine polls for work immediately without new credentials");
  expect(unit.stdout).toContain("waking during an active run keeps its lease and starts no second claim loop");
  expect(unit.stdout).toContain("a work poll left hanging by a suspended machine times out and retries");
  expect(unit.stdout).toContain("desktop Automation execution accepts a completed tool-only assistant turn");
  expect(unit.stdout).toContain("failed desktop assignments retain their created local thread in the Den completion");
  expect(unit.stdout).toContain("cancellation during execution preserves the local thread and reaches a terminal completion");
  expect(unit.stdout).toContain("an explicit assistant provider failure terminates immediately with its local thread");
  expect(unit.stdout).toContain("a remote-session work item creates a local session and completes with its real ids");
  expect(unit.stdout).toContain("remote-session creation omits nullable prompt and model fields");
  expect(unit.stdout).toContain("a local remote-session failure completes as failed without leaking the response body");
  expect(unit.stdout).toContain("a pinned workspace wins over the active workspace");
  expect(unit.stdout).toContain("an unpinned assignment keeps the legacy active-workspace fallback");
  expect(unit.stdout).toContain("a pinned workspace missing locally fails instead of silently retargeting");
  expect(unit.stdout).toContain("desktop Automation execution runs in the assignment's pinned workspace");
  expect(unit.stdout).toContain("a heartbeat slower than its interval never overlaps the next probe");
  expect(unit.stdout).toContain("a hung completion request is bounded and the runner keeps claiming new work");
  expect(unit.stdout).toContain("transient heartbeat failures below the miss threshold do not abort the run");
  expect(unit.stdout).toContain("consecutive heartbeat misses abort the run and still deliver terminal and completion");
  expect(unit.stdout).toContain("a snapshot poll left hanging by a suspended machine still honors the assignment timeout");
  expect(unit.stdout).toContain("a late heartbeat verdict for a finished run cannot cancel its successor");
  expect(unit.stdout).toContain("stopping the runner during terminal delivery aborts it without further requests");
  expect(unit.stdout).not.toContain("not ok");
  expect(unit.stdout).toMatch(/# tests 45\b/);
  expect(unit.stdout).toMatch(/# pass 45\b/);
  expect(unit.stdout).toMatch(/# fail 0\b/);
  expect(unit.stdout).toMatch(/# skipped 0\b/);
  expect(unit.stdout).toMatch(/# todo 0\b/);

  const bridge = spawnSync("pnpm", [
    "--dir",
    "apps/app",
    "exec",
    "bun",
    "test",
    "--isolate",
    "tests/automation-runner-connect-coordinator.test.ts",
    "tests/automation-availability.test.ts",
  ], { cwd: repoRoot, encoding: "utf8" });
  const bridgeOutput = `${bridge.stdout}${bridge.stderr}`;
  expect(bridge.error, bridgeOutput).toBeUndefined();
  expect(bridge.status, bridgeOutput).toBe(0);
  expect(bridgeOutput).toContain("12 pass");
  expect(bridgeOutput).toContain("0 fail");
  evidence.recordAssertionEvidence(
    "Rejected runner credentials stop and remint without disrupting valid work",
    "The runner and bridge suites passed 57 tests covering one-shot 401/403 retirement on every runner route, fresh-token remint backoff, generation races, active assignments, in-flight claims, wake-time work polling, bounded idle polls, serialized bounded heartbeats with a consecutive-miss threshold, bounded terminal and completion delivery, cancellation, provider and workspace failures, durable failed-thread linkage, tool-only completion, remote-session delivery and failure receipts, and work-only polling.",
    true,
  );

  const previousResetOnResponseDelays = Array(10).fill(500);
  expect(requestBudget(previousResetOnResponseDelays, 60_000)).toBe(120);
  const preFix401FirstMinute = requestBudget(expectedDelays, 60_000);
  const preFix401TenMinutes = requestBudget(expectedDelays, 10 * 60_000);
  const transient502FirstMinute = requestBudget(expectedDelays, 60_000);
  expect(preFix401FirstMinute).toBe(7);
  expect(preFix401TenMinutes).toBe(25);
  expect(transient502FirstMinute).toBe(7);
  expect(previousResetOnResponseDelays.reduce((total, delay) => total + delay, 0)).toBe(5_000);
  expect(expectedDelays.reduce((total, delay) => total + delay, 0)).toBe(151_500);
  evidence.recordAssertionEvidence(
    "Transient runner failures retain capped exponential backoff",
    "At midpoint jitter, repeated 502 responses budget 7 work-poll requests in the first minute, with delays rising from 500ms to a 30-second cap instead of resetting after every HTTP response.",
    true,
  );
});
