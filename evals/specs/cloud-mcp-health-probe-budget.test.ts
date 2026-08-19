import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { expect } from "vitest";
import { test } from "@openwork/testkit";

const repoRoot = resolve(import.meta.dirname, "../..");

test("direct Cloud MCP health checks stay within a scoped handshake budget", ({ evidence }) => {
  const budgetResult = spawnSync("pnpm", [
    "--filter",
    "openwork-server",
    "test",
    "src/cloud-mcp-health.test.ts",
    "--test-name-pattern",
    "direct Cloud probe budget",
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  const budgetOutput = `${budgetResult.stdout}${budgetResult.stderr}`;
  const reconcileResult = spawnSync("pnpm", [
    "--filter",
    "openwork-server",
    "test",
    "src/cloud-mcp-reconcile.e2e.test.ts",
    "--test-name-pattern",
    "clean ready persists desired config",
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  const reconcileOutput = `${reconcileResult.stdout}${reconcileResult.stderr}`;

  expect(budgetResult.error, budgetOutput).toBeUndefined();
  expect(budgetResult.status, budgetOutput).toBe(0);
  expect(budgetOutput).toContain("4 pass");
  expect(budgetOutput).toContain("0 fail");
  expect(budgetOutput).toContain("cloud-mcp-probe-operation-benchmark concurrent=6 pre=18 post=3 sequential_explicit=3");
  expect(reconcileResult.error, reconcileOutput).toBeUndefined();
  expect(reconcileResult.status, reconcileOutput).toBe(0);
  expect(reconcileOutput).toContain("1 pass");
  expect(reconcileOutput).toContain("0 fail");
  expect(reconcileOutput).toContain("cloud-mcp-reconcile-operation-benchmark pre=6 post=3");

  evidence.recordAssertionEvidence(
    "Only concurrent health checks share a direct handshake",
    "Six checks are released together through deterministic barriers and reduce the 18-operation protocol baseline to 3; the next settled explicit check performs 3 fresh operations.",
    true,
  );
  evidence.recordAssertionEvidence(
    "Successful reconcile does not repeat tools/list",
    "The focused reconcile witness completes ready and reduces its two direct handshakes from 6 operations to exactly 3 by reusing only its operation-local success.",
    true,
  );
  evidence.recordAssertionEvidence(
    "Upstream failures remain retryable",
    "A tools/list 502 is asserted retryable and the next settled check must perform a complete new initialize, initialized notification, and tools/list handshake.",
    true,
  );
  evidence.recordAssertionEvidence(
    "In-flight reuse is correctness-scoped",
    "Blocked checks require distinct flights across workspaces and Authorization or organization revisions, while provider/model differences share the same direct tools/list flight.",
    true,
  );
  evidence.recordAssertionEvidence(
    "Healthy same-revision delivery state heals",
    "A registering delivery entry with the already-applied revision is required to return to ready after a healthy inspection.",
    true,
  );
});
