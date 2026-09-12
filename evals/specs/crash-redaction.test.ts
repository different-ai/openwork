import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { needs, test } from "@openwork/testkit";

// Keep the Bun/Happy DOM component tests in their native runtime while publishing
// their actual exit status and assertion output through the PR evidence lane.
const appDirectory = fileURLToPath(new URL("../../apps/app/", import.meta.url));
const cases = [
  ["JSON, headers, work cutoff and sanitize-before-output-cap", "tests/crash-diagnostics.test.ts"],
  ["caught-error display and clipboard sinks", "tests/app-error-boundary.test.tsx"],
  ["caught-error optional report sink", "tests/error-monitoring.test.ts"],
];

for (const [claim, file] of cases) {
  test(`crash redaction protects ${claim}`, async ({ evidence }) => {
    needs({ commands: ["bun"], placement: "local" });
    const result = spawnSync("bun", ["test", file], {
      cwd: appDirectory,
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, NO_COLOR: "1" },
    });
    const output = result.stdout + result.stderr;
    expect(result.error).toBeUndefined();
    expect(result.status, output).toBe(0);
    expect(output).toMatch(/[1-9]\d* pass/);
    expect(output).toMatch(/\b0 fail/);
    expect(output).not.toMatch(/\b[1-9]\d* (skip|todo)/);
    evidence.recordAssertionEvidence(
      `Crash redaction: ${claim}`,
      `bun test ${file}\nExit: ${result.status}\n${output}`,
      true,
    );
  });
}
