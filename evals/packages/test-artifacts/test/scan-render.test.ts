import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { renderArtifactIndexHtml, renderPrMarkdown } from "../src/render.ts";
import { scanTestRuns } from "../src/scan.ts";
import type { TestRunRecord } from "../src/schema.ts";

function record(name: string, dir: string, createdAt: string, passed: boolean): TestRunRecord {
  return {
    name,
    dir,
    createdAt,
    closedAt: createdAt,
    summary: {
      ok: passed,
      totalArtifacts: 1,
      passedArtifacts: passed ? 1 : 0,
      failedArtifacts: passed ? 0 : 1,
      unvalidatedArtifacts: 0,
      pendingArtifacts: 0,
      passedExpectations: passed ? 1 : 0,
      failedExpectations: passed ? 0 : 1,
      pendingJudgments: 0,
    },
    artifacts: [{
      caption: `${name} first validation`,
      fileName: "01-first.png",
      hash: `${name}-hash`,
      route: "#/workspace/test",
      at: createdAt,
      description: `${name} description`,
      model: "test-model",
      ok: passed,
      results: [{ expectation: `${name} expectation`, passed, evidence: `${name} evidence` }],
      judgments: [{ expectation: `${name} expectation`, state: passed ? "passed" : "failed", reasoning: `${name} evidence` }],
    }],
  };
}

function legacyRecord(testRun: TestRunRecord): Record<string, unknown> {
  const frames = testRun.artifacts.map((artifact) => {
    const { judgments, ...legacyArtifact } = artifact;
    void judgments;
    return legacyArtifact;
  });
  return {
    ...testRun,
    summary: {
      ok: testRun.summary.ok,
      totalFrames: testRun.summary.totalArtifacts,
      passedFrames: testRun.summary.passedArtifacts,
      failedFrames: testRun.summary.failedArtifacts,
      unvalidatedFrames: testRun.summary.unvalidatedArtifacts,
      passedExpectations: testRun.summary.passedExpectations,
      failedExpectations: testRun.summary.failedExpectations,
    },
    frames,
    artifacts: undefined,
  };
}

test("scanTestRuns reads current and persisted legacy results while tolerating corrupt data", async () => {
  const resultsDir = await mkdtemp(join(tmpdir(), "openwork-test-artifacts-scan-"));
  try {
    const currentDir = join(resultsDir, "test-runs", "2026-07-02T10-00-00-000Z-current");
    const oldDir = join(resultsDir, "rolls", "2026-07-01T10-00-00-000Z-old");
    const corruptDir = join(resultsDir, "test-runs", "2026-07-03T10-00-00-000Z-corrupt");
    const looseDir = join(resultsDir, "2026-06-01T10-00-00-000Z-legacy");
    await Promise.all([currentDir, oldDir, corruptDir, looseDir].map((directory) => mkdir(directory, { recursive: true })));
    await Promise.all([
      writeFile(join(currentDir, "test-run.json"), JSON.stringify(record("Current", currentDir, "2026-07-02T10:00:00.000Z", false))),
      writeFile(join(oldDir, "roll.json"), JSON.stringify(legacyRecord(record("Persisted", oldDir, "2026-07-01T10:00:00.000Z", true)))),
      writeFile(join(corruptDir, "test-run.json"), "{not-json"),
      writeFile(join(looseDir, "fraimz.html"), "legacy"),
      writeFile(join(looseDir, "frame.png"), Buffer.from("legacy-png")),
    ]);

    const entries = await scanTestRuns(resultsDir);
    assert.deepEqual(entries.map((entry) => entry.name), ["Current", "Persisted", "2026-06-01T10-00-00-000Z-legacy"]);
    const storedEntries = entries.filter((entry) => entry.kind === "test-run");
    assert.deepEqual(storedEntries.map((entry) => entry.format), ["current", "legacy"]);
    assert.deepEqual(storedEntries[1]?.testRun.artifacts[0]?.judgments, [{
      expectation: "Persisted expectation",
      state: "passed",
      reasoning: "Persisted evidence",
    }]);

    const rendered = renderArtifactIndexHtml(entries);
    for (const expected of ["Current first validation", "FAILED", "PASSED", "current/index.html", "../rolls/", "fraimz.html"]) {
      assert.match(rendered, new RegExp(expected));
    }
  } finally {
    await rm(resultsDir, { recursive: true, force: true });
  }
});

test("renderPrMarkdown writes only the new test-evidence marker", () => {
  const testRun = record("PR proof", "/tmp/2026-pr-proof", "2026-07-02T10:00:00.000Z", false);
  const markdown = renderPrMarkdown(testRun, { "01-first.png": "https://example.test/01-first.png" });
  assert.match(markdown, /<!-- test-evidence -->/);
  assert.doesNotMatch(markdown, /<!-- photo-roll -->|<!-- fraimz -->/);
  assert.match(markdown, /PR proof first validation/);
});

test("scanTestRuns skips a symlinked test-run.json", async () => {
  const resultsDir = await mkdtemp(join(tmpdir(), "openwork-test-artifacts-symlink-"));
  try {
    const testRunDir = join(resultsDir, "test-runs", "2026-07-02T10-00-00-000Z-symlinked");
    await mkdir(testRunDir, { recursive: true });
    const outside = join(resultsDir, "outside-test-run.json");
    await writeFile(outside, JSON.stringify(record("Outside", testRunDir, "2026-07-02T10:00:00.000Z", true)));
    await symlink(outside, join(testRunDir, "test-run.json"));
    assert.deepEqual(await scanTestRuns(resultsDir), []);
  } finally {
    await rm(resultsDir, { recursive: true, force: true });
  }
});
