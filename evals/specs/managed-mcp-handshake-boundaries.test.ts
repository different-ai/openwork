import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { expect } from "vitest";
import { test } from "@openwork/testkit";

const repoRoot = resolve(import.meta.dirname, "../..");
const witnessName = "returns safe connection errors for DCR reconnect and callback initialize failures";

test("managed MCP handshake boundaries separate provider failures from internal defects", ({ evidence }) => {
  const result = spawnSync("pnpm", [
    "--filter",
    "openwork-server",
    "test",
    "src/local-managed-mcp.e2e.test.ts",
    "--test-name-pattern",
    witnessName,
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  const output = `${result.stdout}${result.stderr}`;

  expect(result.error, output).toBeUndefined();
  expect(result.status, output).toBe(0);
  expect(output).toContain("1 pass");
  expect(output).toContain("0 fail");
  expect(output).toContain("18 expect() calls");

  evidence.recordAssertionEvidence(
    "Provider DCR and initialize failures cross a safe reconnect boundary",
    "The focused HTTP witness requires both deterministic provider failures to return exactly managed_mcp_connection_failed/502, omit nested provider secrets, and persist reconnect_required with no credential.",
    true,
  );
  evidence.recordAssertionEvidence(
    "Recognized provider handshake failures stay out of telemetry",
    "The same witness requires the telemetry capture list to remain empty after the DCR and callback-initialize failures.",
    true,
  );
  evidence.recordAssertionEvidence(
    "Malformed SDK data remains an actionable internal defect",
    "The malformed registration witness must return the generic internal 500 while capturing exactly one non-ApiError EnterpriseMcpClientError with MCP_CONNECTION_HANDSHAKE_FAILED at mcp-initialize.",
    true,
  );
});
