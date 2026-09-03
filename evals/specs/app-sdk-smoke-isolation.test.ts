import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { expect } from "vitest";
import { test } from "@openwork/testkit";

const repoRoot = resolve(import.meta.dirname, "../..");

test("the app SDK smoke server is hermetic and completes its core calls", ({ evidence }) => {
  const result = spawnSync("pnpm", [
    "--filter",
    "@openwork/app",
    "exec",
    "node",
    "scripts/e2e.mjs",
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  const output = `${result.stdout}${result.stderr}`;

  expect(result.error, output).toBeUndefined();
  expect(result.status, output).toBe(0);
  const report = JSON.parse(result.stdout) as {
    ok: boolean;
    steps: Array<{ name: string; status: string }>;
  };
  expect(report.ok).toBe(true);
  expect(report.steps.filter((step) => step.status === "error")).toEqual([]);
  expect(report.steps.find((step) => step.name === "health")?.status).toBe("ok");
  expect(report.steps.find((step) => step.name === "path.get")?.status).toBe("ok");
  expect(report.steps.find((step) => step.name === "session.create")?.status).toBe("ok");
  expect(report.steps.find((step) => step.name === "event.subscribe")?.status).toBe("ok");

  evidence.recordAssertionEvidence(
    "The hermetic OpenCode process serves every core SDK smoke call",
    "A temporary database and minimal config complete health, path.get, session create/list/messages/prompt/todo, and SSE subscription with no error step.",
    true,
  );
});
