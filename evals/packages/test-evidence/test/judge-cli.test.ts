import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createTestEvidence } from "../src/test-evidence.ts";

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const testRunsDir = join(repoRoot, "evals", "results", "test-runs");
const judgeCli = fileURLToPath(new URL("../bin/test-evidence-judge.mjs", import.meta.url));

test("judge CLI resolves a completed test run by record name", async () => {
  await mkdir(testRunsDir, { recursive: true });
  const testRunDir = await mkdtemp(join(testRunsDir, "judge-cli-name-"));
  const name = `Judge CLI name ${randomUUID()}`;
  try {
    const evidence = createTestEvidence({ name, outDir: testRunDir });
    evidence.recordAssertionEvidence("No visual judgment is pending", "The test run contains assertion evidence only.", true);
    await evidence.close();

    const result = spawnSync(process.execPath, [judgeCli, "--test-run", name], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Judged 0 visual validation\(s\): 0 failed, 0 pending\./);
    assert.match(result.stdout, new RegExp(`${testRunDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/test-run\\.json`));
  } finally {
    await rm(testRunDir, { recursive: true, force: true });
  }
});
