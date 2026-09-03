import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { expect } from "vitest";
import { test } from "@openwork/testkit";

const repoRoot = resolve(import.meta.dirname, "../..");

test("the app SDK smoke suite isolates each OpenCode process and completes", ({ evidence }) => {
  const result = spawnSync("pnpm", [
    "--filter",
    "@openwork/app",
    "test:e2e",
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  const output = `${result.stdout}${result.stderr}`;

  expect(result.error, output).toBeUndefined();
  expect(result.status, output).toBe(0);
  expect(output).not.toContain('"ok": false');
  expect(output).not.toContain('"status": "error"');
  expect(output).toContain('"name": "path.get"');
  expect(output).toContain('"name": "session.messages switch"');
  expect(output).toContain('"root":".openwork/test-engine"');
  expect(output).toContain('"name": "assert.built-in-browser-quickstart"');

  evidence.recordAssertionEvidence(
    "Every core SDK smoke script receives isolated OpenCode state",
    "The exact app test:e2e command completes core health/path/session/prompt/todo/SSE, session switching, filesystem operations, and the browser-entry project command with no error report.",
    true,
  );
});
