import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { expect } from "vitest";
import { test } from "@openwork/testkit";

const repoRoot = resolve(import.meta.dirname, "../..");

// A spawned engine carries no provider keys in its environment; credentials
// reach it only through PUT /auth from the managed-provider sync. Until now the
// pool never seeded a standby, so the first sync after every flip found a new
// generation scope, re-delivered the same key, counted that as a credential
// change and forced yet another standby: one 1+ GB engine per sync pass.

function runServerTests(files: string[], pattern: string) {
  const result = spawnSync("pnpm", [
    "--filter",
    "openwork-server",
    "test",
    ...files,
    "--test-name-pattern",
    pattern,
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return { status: result.status, error: result.error, output: `${result.stdout}${result.stderr}` };
}

test("an engine rollover seeds the standby and re-seeding never forces another rollover", ({ evidence }) => {
  const seeding = runServerTests(
    ["src/engine-pool.test.ts"],
    "seeds the healthy standby before flipping and flips anyway when seeding fails",
  );
  expect(seeding.error, seeding.output).toBeUndefined();
  expect(seeding.status, seeding.output).toBe(0);
  expect(seeding.output).toContain("1 pass");
  expect(seeding.output).toContain("0 fail");

  const auth = runServerTests(
    ["src/managed-provider-auth.test.ts"],
    "seeding a standby generation leaves the promoted primary unchanged on the next sync|re-seeding a replaced engine with the same key is delivered but not rotated",
  );
  expect(auth.error, auth.output).toBeUndefined();
  expect(auth.status, auth.output).toBe(0);
  expect(auth.output).toContain("2 pass");
  expect(auth.output).toContain("0 fail");

  const sync = runServerTests(
    ["src/cloud-provider-sync.e2e.test.ts"],
    "re-seeding an unchanged credential to a replaced engine generation does not reload again",
  );
  expect(sync.error, sync.output).toBeUndefined();
  expect(sync.status, sync.output).toBe(0);
  expect(sync.output).toContain("1 pass");
  expect(sync.output).toContain("0 fail");

  evidence.recordAssertionEvidence(
    "The pool seeds a healthy standby before it becomes primary",
    "prepareStandby runs once per rollover with the standby's own URL and basic-auth while the old engine is still primary; a throwing seed still flips.",
    true,
  );
  evidence.recordAssertionEvidence(
    "Seeding uses the same generation scope the promoted primary will use",
    "After the flip the primary-scoped sync reports the provider unchanged with no further PUT /auth; the total stays at two deliveries.",
    true,
  );
  evidence.recordAssertionEvidence(
    "Re-delivering an unchanged key to a replaced engine does not reload",
    "With a fake pool whose generation changes on every reload, the second and third sync passes deliver but keep reloads at 1; a rotated key reloads exactly once more. The same test fails on the previous authChanged definition (Expected 1, Received 2).",
    true,
  );
});
