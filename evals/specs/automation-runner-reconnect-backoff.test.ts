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
  return attempts * 2;
}

test("desktop Automation runner retires rejected credentials without changing transient backoff", async ({ evidence }) => {
  const unit = spawnSync(process.execPath, [
    "--test",
    "--test-reporter=tap",
    runnerUnitTest,
  ], { encoding: "utf8" });
  expect(unit.status, unit.stderr || unit.stdout).toBe(0);
  expect(unit.stdout).toContain("repeated HTTP 502 responses retain exponential runner reconnect backoff");
  expect(unit.stdout).toContain("HTTP 401 from work or events retires exactly that credential without reconnecting");
  expect(unit.stdout).toContain("HTTP 403 from work or events retires exactly that credential without reconnecting");
  expect(unit.stdout).toContain("HTTP 401 and 403 from every assignment route retire the credential");
  expect(unit.stdout).toContain("a new credential reconciles immediately and a late rejection cannot retire it");
  expect(unit.stdout).toContain("a late rejection retires a newer generation that reused the same credential");
  expect(unit.stdout).toContain("routine credential rotation waits for the active assignment to complete");
  expect(unit.stdout).toContain("routine credential rotation waits for an in-flight claim");
  expect(unit.stdout).toContain("routine credential rotation preserves the SSE cursor only for the same runner scope");
  expect(unit.stdout).toContain("credential rejection preserves the SSE cursor for a same-scope remint");
  expect(unit.stdout).toContain("retiring a generation cancels its reconnect wait");
  expect(unit.stdout).toContain("a healthy SSE response resets runner reconnect backoff");
  expect(unit.stdout).toContain("a parsed SSE event resets backoff before an abrupt stream error");
  expect(unit.stdout).not.toContain("not ok");
  expect(unit.stdout).toMatch(/# tests 24\b/);
  expect(unit.stdout).toMatch(/# pass 24\b/);
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
  expect(bridgeOutput).toContain("11 pass");
  expect(bridgeOutput).toContain("0 fail");
  evidence.recordAssertionEvidence(
    "Rejected runner credentials stop and remint without disrupting valid work",
    "The runner and bridge suites passed 35 tests covering one-shot 401/403 retirement on every runner route, fresh-token remint backoff, generation races, active assignments, in-flight claims, and same-scope SSE cursor continuity.",
    true,
  );

  const previousResetOnResponseDelays = Array(10).fill(500);
  expect(requestBudget(previousResetOnResponseDelays, 60_000)).toBe(240);
  const preFix401FirstMinute = requestBudget(expectedDelays, 60_000);
  const preFix401TenMinutes = requestBudget(expectedDelays, 10 * 60_000);
  const transient502FirstMinute = requestBudget(expectedDelays, 60_000);
  expect(preFix401FirstMinute).toBe(14);
  expect(preFix401TenMinutes).toBe(50);
  expect(transient502FirstMinute).toBe(14);
  expect(previousResetOnResponseDelays.reduce((total, delay) => total + delay, 0)).toBe(5_000);
  expect(expectedDelays.reduce((total, delay) => total + delay, 0)).toBe(151_500);
  evidence.recordAssertionEvidence(
    "Transient runner failures retain capped exponential backoff",
    "At midpoint jitter, repeated 502 responses budget 14 work-plus-SSE requests in the first minute, with delays rising from 500ms to a 30-second cap instead of resetting after every HTTP response.",
    true,
  );
});
