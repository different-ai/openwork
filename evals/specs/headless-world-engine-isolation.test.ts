import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { expect } from "vitest";
import { test } from "@openwork/testkit";

const repoRoot = resolve(import.meta.dirname, "../..");

// An `isolated` headless world used to inherit the person's HOME and open the
// installed desktop app's ~/.local/share/opencode/opencode.db, so two
// long-lived engines contended for one SQLite writer and world sessions leaked
// into the person's history.

test("an isolated headless world gives its engine a private sessions database", ({ evidence }) => {
  const result = spawnSync("pnpm", [
    "--filter",
    "@openwork/world",
    "exec",
    "node",
    "--test",
    "test/headless-isolation.test.ts",
    "test/headless-production.test.ts",
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  const output = `${result.stdout}${result.stderr}`;

  expect(result.error, output).toBeUndefined();
  expect(result.status, output).toBe(0);
  expect(output).toMatch(/ℹ pass 9\b/);
  expect(output).toMatch(/ℹ fail 0\b/);
  expect(output).toContain("dev-headless keeps its engine sessions database under tmp/");
  expect(output).toContain("isolated engine env points OPENCODE_DB at the world database and nothing else");
  expect(output).toContain("an explicit OPENCODE_DB wins over the world default");

  evidence.recordAssertionEvidence(
    "The isolated world's engine opens tmp/dev-headless-opencode.db",
    "resolveHeadlessWorldRuntimePaths yields a world-owned database path and isolatedHeadlessEngineEnv sets exactly OPENCODE_DB to it, leaving HOME and XDG_DATA_HOME untouched so provider credentials still resolve.",
    true,
  );
  evidence.recordAssertionEvidence(
    "Explicit overrides and the installed-production world are unchanged",
    "An explicit OPENCODE_DB still wins, and the installed-production env test keeps pointing at the installed database.",
    true,
  );
});
