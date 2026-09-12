import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { needs, test } from "@openwork/testkit";

const appDirectory = fileURLToPath(new URL("../../apps/app/", import.meta.url));

// Run the mounted hook in its native Bun/Happy DOM runtime, retaining its
// assertions and output in the PR evidence lane without exposing private refs.
test("workspace inventories recover after disconnect and retain count-free fixture compatibility", async ({ evidence }) => {
  needs({ commands: ["bun"], placement: "local" });
  const files = ["tests/archived-session-sort.test.ts", "tests/use-workspace-route-state.test.tsx"];
  const result = spawnSync("bun", ["test", ...files], {
    cwd: appDirectory,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, NO_COLOR: "1" },
  });
  const output = result.stdout + result.stderr;
  expect(result.error).toBeUndefined();
  expect(result.status, output).toBe(0);
  expect(output).toMatch(/\b13 pass/);
  expect(output).toMatch(/\b0 fail/);
  expect(output).not.toMatch(/\b[1-9]\d* (skip|todo|filtered out)/);
  evidence.recordAssertionEvidence(
    "C05/C07: unchanged remote scope reloads after offline clearing; healthy refresh stays cached; archive and routing consumers use the retained contract",
    `bun test ${files.join(" ")}\nExit: ${result.status}\n${output}`,
    true,
  );
});
