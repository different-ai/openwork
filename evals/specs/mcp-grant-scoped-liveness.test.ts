import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect } from "vitest";
import { test } from "@openwork/testkit";

const repoRoot = resolve(import.meta.dirname, "../..");

test("MCP OAuth grants outlive login sessions and revoke with consent", ({ evidence }) => {
  const reportDir = mkdtempSync(join(tmpdir(), "openwork-mcp-grant-liveness-"));
  try {
    const witnesses = [
      { file: "test/mcp-grant-request-liveness.test.ts", tests: 4 },
      { file: "test/mcp-oauth-grant-policy.test.ts", tests: 6 },
      { file: "test/mcp-grant-revocation.test.ts", tests: 1 },
      { file: "test/mcp-grant-deletion-tombstones.test.ts", tests: 1 },
      { file: "test/mcp-grant-cache.test.ts", tests: 3 },
    ];
    for (const [index, witness] of witnesses.entries()) {
      const reportPath = join(reportDir, `bun-junit-${index}.xml`);
      const result = spawnSync("pnpm", [
        "--filter",
        "@openwork-ee/den-api",
        "exec",
        "bun",
        // Resolve @openwork-ee/utils and @openwork-ee/den-db from their source
        // export condition: shared dist output is rebuilt (and briefly
        // removed) by concurrently running specs, so the witnesses must not
        // depend on it.
        "--conditions=development",
        "test",
        witness.file,
        "--reporter=junit",
        "--reporter-outfile",
        reportPath,
      ], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
        timeout: 60_000,
      });
      const output = `${result.stdout}${result.stderr}`;
      expect(result.error, output).toBeUndefined();
      expect(result.status, output).toBe(0);

      const junit = readFileSync(reportPath, "utf8");
      const summary = junit.match(/<testsuite\b[^>]*>/)?.[0] ?? "";
      expect(summary).toContain(`tests="${witness.tests}"`);
      expect(summary).toContain('failures="0"');
      expect(summary).toContain('skipped="0"');
      expect(junit).not.toContain("<failure");
      expect(junit).not.toContain("<skipped");
    }

    evidence.recordAssertionEvidence(
      "Sign-out leaves grant-claim tokens valid while sid-only tokens still die",
      "The runtime witness accepts a live-consent token without consulting its dead session and rejects a legacy token without a grant claim as mcp_session_revoked.",
      true,
    );
    evidence.recordAssertionEvidence(
      "Consent revocation rejects access and refresh without penalizing live grants",
      "The runtime witness accepts live grant and refresh consent, returns mcp_grant_revoked for a missing grant, and rejects plus cleans a dead-session refresh family only after consent deletion.",
      true,
    );
    evidence.recordAssertionEvidence(
      "Membership removal revokes only that organization's grants",
      "The runtime witness requires the consent query to include both user and target organization, tombstones exactly the selected consent id, and rejects tombstoning the other-organization id.",
      true,
    );
    evidence.recordAssertionEvidence(
      "User deletion tombstones the transactional consent snapshot",
      "The runtime witness requires the consent snapshot to be a locking read inside the deletion transaction and requires a consent authorized concurrently with deletion to be tombstoned alongside the snapshot, closing the pre-transaction race.",
      true,
    );
    evidence.recordAssertionEvidence(
      "Grant claims and cache entries remain durable and revocation-safe",
      "The runtime witness stamps only the consent id, omits absent consent, reuses cached liveness without another loader call, and prevents tombstoned grants from repopulating.",
      true,
    );
  } finally {
    rmSync(reportDir, { force: true, recursive: true });
  }
});
