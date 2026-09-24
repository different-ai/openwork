import { expect } from "vitest";
import { test } from "@openwork/testkit";
import { reviewWorld } from "../worlds/evidence-review.ts";

// Change-specific proof for the PR proof pipeline: it drives the production
// review app over HTTP with isolated synthetic records. Hosted Blob upload and
// Vercel sign-in remain separate trusted-boundary checks.
test("a selected PR proof is readable without presenting unrelated smoke evidence", async ({ evidence }) => {
  await using world = await reviewWorld();
  console.log("placement: local (isolated production review app; synthetic records)");
  const response = await fetch(`${world.baseUrl}/r/${world.passed}`, {
    signal: AbortSignal.timeout(10_000),
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("private");
  const html = await response.text();
  expect(html).toContain("Sharing a skill, from link to access");
  expect(html).toContain("A shared skill can be opened");
  expect(html).toContain("The owner can revoke a link");
  expect(html).not.toContain("packaged desktop smoke");
  evidence.recordAssertionEvidence(
    "The selected proof report is readable and scoped to its supplied records",
    "The production-built local review page returned 200 with private caching, rendered both selected synthetic proof records, and contained no packaged-smoke fallback.",
    true,
  );

  const missing = await fetch(`${world.baseUrl}/r/${"0".repeat(32)}`, {
    signal: AbortSignal.timeout(10_000),
  });
  expect(missing.status).toBe(404);
  evidence.recordAssertionEvidence(
    "Unselected report identities are unavailable",
    "An unknown report identity returned 404 rather than another run's evidence.",
    true,
  );
});
