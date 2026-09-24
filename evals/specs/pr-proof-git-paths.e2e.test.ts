import { expect } from "vitest";
import { test } from "@openwork/testkit";
import { selectProof } from "../../.github/scripts/pr-proof.mjs";
import { reviewWorld } from "../worlds/evidence-review.ts";

test("proof selection accepts normal Den paths and the selected report remains private", async ({ evidence }) => {
  const selection = selectProof([
    { filename: "ee/apps/den-web/app/(den)/dashboard/a file.ts", status: "modified" },
    { filename: "evals/specs/pr-proof-git-paths.e2e.test.ts", status: "added" },
  ]);
  expect(selection.specs).toEqual(["evals/specs/pr-proof-git-paths.e2e.test.ts"]);
  evidence.recordAssertionEvidence(
    "Normal Git paths do not hide a newly added proof",
    "A Den path containing parentheses and a space was accepted, and the new E2E spec remained the only selected proof.",
    true,
  );

  await using world = await reviewWorld();
  const response = await fetch(`${world.baseUrl}/r/${world.passed}`, {
    signal: AbortSignal.timeout(10_000),
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("private");
  evidence.recordAssertionEvidence(
    "Selected proof evidence remains private in the reviewer",
    "The production-built local review route returned 200 with private cache control for its isolated synthetic report.",
    true,
  );
});
