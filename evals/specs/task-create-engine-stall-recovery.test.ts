import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { expect } from "vitest";
import { test } from "@openwork/testkit";

const repoRoot = resolve(import.meta.dirname, "../..");

// New task used to give up on the first 10 s timeout with an infinite
// "OpenCode unavailable — Request timed out." toast whose only action was
// Retry, even though the engine was alive and merely stalled behind a
// rollover or an overloaded event loop. People learned to reload the app.

test("task creation retry policy is bounded and classifies an exhausted engine stall", ({ evidence }) => {
  const result = spawnSync("pnpm", [
    "--filter",
    "@openwork/app",
    "exec",
    "bun",
    "test",
    "--isolate",
    "tests/task-create-engine-retry.test.ts",
    "tests/route-session-list.test.ts",
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  const output = `${result.stdout}${result.stderr}`;

  expect(result.error, output).toBeUndefined();
  expect(result.status, output).toBe(0);
  expect(output).toContain("0 fail");
  expect(output).toMatch(/\b(8|9) pass\b/);
  expect(output).not.toContain("(fail)");

  evidence.recordAssertionEvidence(
    "Timed-out task creation retries with a visible countdown",
    "withTransientEngineRetry re-issues session.create after 1 s and 2 s, reporting attempts 1 and 2 to the toast, and returns the created session on the third try.",
    true,
  );
  evidence.recordAssertionEvidence(
    "Retries are bounded and terminal errors are never retried",
    "After 1 s, 2 s and 4 s the last timeout is thrown (4 attempts total); an authorization error is thrown on the first attempt with no wait and no retry callback.",
    true,
  );
  evidence.recordAssertionEvidence(
    "The final toast distinguishes a stalled engine from an unavailable one",
    "Timeouts and opencode_engine_unreachable/503 yield 'OpenCode is not responding' with the attempt count (and a Reload engine action in the route); terminal errors keep 'OpenCode unavailable' with the raw message.",
    true,
  );
});
