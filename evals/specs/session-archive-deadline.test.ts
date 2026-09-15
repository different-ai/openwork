import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { needs, test } from "@openwork/testkit";

const appDirectory = fileURLToPath(new URL("../../apps/app/", import.meta.url));

test("archive deadlines settle stalled reads and uncertain writes, preserve caller cancellation, and retain pin and working-session contracts", async ({ evidence }) => {
  needs({ commands: ["bun"], placement: "local" });
  const files = [
    "tests/session-archive-agent-contract.test.tsx",
    "tests/opencode-stream-timeout.test.ts",
    "tests/opencode-session-native.test.ts",
    "tests/session-management-store.test.ts",
  ];
  const result = spawnSync("bun", ["test", "--isolate", ...files], {
    cwd: appDirectory,
    encoding: "utf8",
    timeout: 90_000,
    env: { ...process.env, NO_COLOR: "1" },
  });
  const output = result.stdout + result.stderr;
  const passed = result.error === undefined && result.status === 0 && /\b110 pass/.test(output)
    && /\b0 fail/.test(output) && !/\b[1-9]\d* (skip|todo|filtered out)/.test(output);
  evidence.recordAssertionEvidence(
    "Bounded preflight never sends a late PATCH; uncertain PATCH is not reported as cancellation; holds and busy state recover; caller signals and pin state survive",
    `bun test --isolate ${files.join(" ")}\nExit: ${result.status}\n${output}`,
    passed,
  );
  expect(result.error).toBeUndefined();
  expect(result.status, output).toBe(0);
  expect(passed, output).toBe(true);
}, 120_000);
