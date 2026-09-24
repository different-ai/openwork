import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { needs, test } from "@openwork/testkit";

test("scoped send preflight and Stop retain ownership, interruption and environment contracts", { timeout: 120_000 }, async ({ evidence }) => {
  needs({ commands: ["pnpm", "bun"], placement: "local" });
  const files = ["tests/session-stop-refresh.test.ts", "tests/session-send-isolation.test.ts", "tests/env-context.test.ts", "tests/session-ownership.test.ts", "tests/opencode-session-native.test.ts", "tests/safe-edit-resend.test.ts", "tests/session-history.test.tsx", "tests/session-scroll.test.tsx"];
  const result = spawnSync("pnpm", ["exec", "bun", "test", "--isolate", ...files], {
    cwd: fileURLToPath(new URL("../../apps/app/", import.meta.url)), encoding: "utf8", timeout: 90_000,
    env: { ...process.env, NO_COLOR: "1" },
  });
  const output = result.stdout + result.stderr;
  const passed = result.error === undefined && result.status === 0 && /\b0 fail/.test(output) && !/\b[1-9]\d* (skip|todo|filtered out)/.test(output);
  evidence.recordAssertionEvidence("Only opted-in preflight and complete Stop reads use main transport; ordinary reads, ownership and no-replay behavior remain intact",
    `pnpm --dir apps/app exec bun test --isolate ${files.join(" ")}\nExit: ${result.status}\n${output}`, passed);
  expect(result.error).toBeUndefined();
  expect(result.status, output).toBe(0);
  expect(passed, output).toBe(true);
});
