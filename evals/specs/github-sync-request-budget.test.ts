import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect } from "vitest";
import { test } from "@openwork/testkit";

const repoRoot = resolve(import.meta.dirname, "../..");
const retryClassificationTest = "GitHub sync treats 502 and TimeoutError as transient";

test("GitHub installation-token request budgets and recovery hold in focused runtime tests", ({ evidence }) => {
  const reportDir = mkdtempSync(join(tmpdir(), "openwork-github-budget-"));
  const reportPath = join(reportDir, "bun-junit.xml");
  const retryReportPath = join(reportDir, "bun-retry-junit.xml");
  try {
    const result = spawnSync("pnpm", [
      "--filter",
      "@openwork-ee/den-api",
      "exec",
      "bun",
      "test",
      "test/github-sync-request-budget.test.ts",
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
    expect(summary).toContain('tests="5"');
    expect(summary).toContain('failures="0"');
    expect(summary).toContain('skipped="0"');
    expect(junit).not.toContain("<failure");
    expect(junit).not.toContain("<skipped");

    const retryResult = spawnSync("pnpm", [
      "--filter",
      "@openwork-ee/den-api",
      "exec",
      "bun",
      "test",
      "test/github-sync-worker-retry-classification.test.ts",
      "--reporter=junit",
      "--reporter-outfile",
      retryReportPath,
    ], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 60_000,
    });
    const retryOutput = `${retryResult.stdout}${retryResult.stderr}`;
    expect(retryResult.error, retryOutput).toBeUndefined();
    expect(retryResult.status, retryOutput).toBe(0);

    const retryJunit = readFileSync(retryReportPath, "utf8");
    const retrySummary = retryJunit.match(/<testsuite\b[^>]*>/)?.[0] ?? "";
    expect(retrySummary).toContain('tests="1"');
    expect(retrySummary).toContain('failures="0"');
    expect(retrySummary).toContain('skipped="0"');
    expect(retryJunit).toContain(retryClassificationTest);
    expect(retryJunit).not.toContain("<failure");
    expect(retryJunit).not.toContain("<skipped");

    evidence.recordAssertionEvidence(
      "Concurrent installation-token minting is single-flight",
      "The runtime witness measured a 12-caller cold-cache control at 12 installation-token calls and concurrency 12, then the production token helper at exactly 1 mint and peak concurrency 1.",
      true,
    );
    evidence.recordAssertionEvidence(
      "Failed and timed-out token mints recover",
      "The runtime witness requires a shared 502 and an abort-signaled hung request to be evicted, then requires the immediately following provider call to succeed.",
      true,
    );
    evidence.recordAssertionEvidence(
      "GitHub sync retries 502 and timeout failures",
      "A separately-accounted focused worker witness passes exactly one test with zero failures and zero skips while requiring GithubConnectorRequestError(502) and TimeoutError to classify as transient.",
      true,
    );
    evidence.recordAssertionEvidence(
      "App and installation token keys stay isolated",
      "The runtime witness starts duplicate and distinct app/installation requests together, requires exactly three independent mints for three keys, and then requires each key to reuse only its own cached token.",
      true,
    );
    evidence.recordAssertionEvidence(
      "Cache clearing is generation-safe",
      "The runtime witness clears during an in-flight mint, lets the old request settle, and requires a new provider request to return a fresh token rather than accepting repopulated stale cache state.",
      true,
    );
  } finally {
    rmSync(reportDir, { force: true, recursive: true });
  }
});
