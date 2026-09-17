import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { needs, test } from "@openwork/testkit";

const root = fileURLToPath(new URL("../../", import.meta.url));
test("finite archive and permission IPC preserve scoped requests, cancellation, no retries and external trust boundaries", { timeout: 90_000 }, async ({ evidence }) => {
  needs({ commands: ["bun", "node"], placement: "local" });
  for (const run of [
    { command: "node", args: ["--test", "--test-concurrency=1", "apps/desktop/electron/finite-http-fetch.test.mjs", "apps/desktop/electron/no-bare-external-fetch.test.mjs"], cwd: root },
    { command: "bun", args: ["test", "--isolate", "tests/opencode-archive-transport.test.ts", "tests/opencode-stream-timeout.test.ts"], cwd: `${root}apps/app` },
  ]) {
    const result = spawnSync(run.command, run.args, { cwd: run.cwd, encoding: "utf8", timeout: 30_000, env: { ...process.env, NO_COLOR: "1" } });
    const output = result.stdout + result.stderr;
    const passed = !result.error && result.status === 0 && !/\b[1-9]\d* (skip|todo|filtered out)/.test(output);
    evidence.recordAssertionEvidence("Archive and permission transport retain safety and external networking policy", `${run.command} ${run.args.join(" ")}\nExit ${result.status}\n${output}`, passed);
    expect(result.error).toBeUndefined();
    expect(result.status, output).toBe(0);
    expect(passed, output).toBe(true);
  }
});
