import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { test } from "@openwork/testkit";
import { reviewWorld } from "../worlds/evidence-review.ts";

const exec = promisify(execFile);

test("Native evidence links open a readable report and preserve commit-bound publication rules", async ({ evidence }) => {
  const contract = fileURLToPath(new URL("../../.github/scripts/evidence-presentation.test.mjs", import.meta.url));
  const cardContract = fileURLToPath(new URL("../../.github/scripts/evidence-preview-card.test.mjs", import.meta.url));
  const result = await exec(process.execPath, ["--test", contract, cardContract], { timeout: 30_000 });
  expect(result.stdout).toMatch(/(?:fail 0|# fail 0)/);
  evidence.recordAssertionEvidence(
    "Native presentation rejects stale evidence and preserves recorded failures",
    "The controller and preview card contract tests passed against a simulated GitHub API: commit binding, failed reports, missing reports, stale heads and attempts, delayed progress, publication races, URL validation, retirement of older deployments, readable preview links, outdated reports, and bot comment ownership. Actual GitHub check/deployment creation runs separately after this proof completes.",
    true,
  );

  await using world = await reviewWorld();
  const response = await fetch(`${world.baseUrl}/r/${world.passed}`);
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain(world.report.gitSha.slice(0, 7));
  expect(html).toContain("A shared skill can be opened");
  expect(html).toContain("Launch in Freestyle");
  evidence.recordAssertionEvidence(
    "The native deployment destination exposes evidence and sandbox launch",
    "An isolated production reviewer served the immutable report with its commit identifier, recorded behavior, and Launch in Freestyle action. This verifies the report destination; it does not claim a live sandbox was allocated.",
    true,
  );
});
