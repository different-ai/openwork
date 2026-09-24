import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { needs, test } from "@openwork/testkit";

const appDirectory = fileURLToPath(new URL("../../apps/app/", import.meta.url));

test("MCP App retry respects dashboard lease ownership, sibling isolation, and approval policy while standalone retries stay local", async ({ evidence }) => {
  needs({ commands: ["bun"], placement: "local" });
  const args = ["test", "--isolate", "tests/mcp-app-frame.test.ts", "--test-name-pattern", "MCP App retry ownership"];
  const result = spawnSync("bun", args, {
    cwd: appDirectory,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, NO_COLOR: "1" },
  });
  const output = result.stdout + result.stderr;
  const passed = result.error === undefined && result.status === 0 && /\b6 pass/.test(output)
    && /\b0 fail/.test(output) && !/\b[1-9]\d* (skip|todo)/.test(output);
  evidence.recordAssertionEvidence(
    "Owner retry never navigates a released lease, replaces only the failed tile, accepts fresh readiness, and preserves approval challenge/denial behavior; standalone and read-only retries never rerun tools",
    `bun ${args.join(" ")}\nExit: ${result.status}\n${output}`,
    passed,
  );
  expect(result.error).toBeUndefined();
  expect(result.status, output).toBe(0);
  expect(passed, output).toBe(true);
}, 90_000);
