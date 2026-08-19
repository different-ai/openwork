import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ScreenshotArtifact } from "../../test-evidence/src/screenshot.ts";
import { createTestEvidence } from "../../test-evidence/src/test-evidence.ts";
import { renderArtifactIndexHtml, renderPrMarkdown } from "../src/render.ts";
import { scanTestRuns } from "../src/scan.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

test("scanTestRuns reads screenshots and assertions produced by the real test-evidence writer", async () => {
  const resultsDir = await mkdtemp(join(tmpdir(), "openwork-test-artifacts-compat-"));
  const testRunDir = join(resultsDir, "test-runs", "2026-07-02T10-00-00-000Z-writer-compat");
  try {
    const png = Buffer.from("synthetic screenshot pixels");
    const screenshotArtifact: ScreenshotArtifact = {
      png,
      hash: createHash("sha256").update(png).digest("hex"),
      route: "#/writer-compat",
      visibleText: "Writer compatibility",
      at: "2026-07-02T10:00:00.000Z",
    };
    const testEvidence = createTestEvidence({ name: "Writer compatibility", outDir: testRunDir });
    testEvidence.recordScreenshot(screenshotArtifact);
    testEvidence.recordVisualValidation(screenshotArtifact.hash, {
      ok: true,
      description: "Writer compatibility is visible.",
      results: [{ expectation: "Writer compatibility screenshot", passed: true, evidence: "Writer compatibility" }],
      why: "",
      model: "compat-model",
      cached: false,
    });
    testEvidence.recordAssertionEvidence("Witness compatibility", "The API returned HTTP 200.", true);
    await testEvidence.close();

    const raw = await readFile(join(testRunDir, "test-run.json"), "utf8");
    assert.match(raw, /"gitSha":/);
    assert.match(raw, /"artifacts":/);
    const entries = await scanTestRuns(resultsDir);
    assert.equal(entries.length, 1);
    const entry = entries[0];
    assert.equal(entry?.kind, "test-run");
    if (!entry || entry.kind !== "test-run") throw new Error("Writer test run was not scanned.");
    assert.equal(entry.testRun.artifacts[0]?.caption, "Writer compatibility screenshot");
    assert.equal(entry.testRun.artifacts[1]?.fileName, "");
    assert.equal(entry.format, "current");
  } finally {
    await rm(resultsDir, { recursive: true, force: true });
  }
});

test("scan and render retain pending judgments from a deferred test-evidence record", async () => {
  const resultsDir = await mkdtemp(join(tmpdir(), "openwork-test-artifacts-pending-"));
  const testRunDir = join(resultsDir, "test-runs", "2026-07-02T10-00-00-000Z-pending");
  try {
    const png = Buffer.from("pending screenshot pixels");
    const screenshotArtifact: ScreenshotArtifact = {
      png,
      hash: createHash("sha256").update(png).digest("hex"),
      route: "#/pending",
      visibleText: "Pending visual evidence",
      at: "2026-07-02T10:00:00.000Z",
    };
    const testEvidence = createTestEvidence({ name: "Pending writer compatibility", outDir: testRunDir });
    testEvidence.recordScreenshot(screenshotArtifact);
    testEvidence.recordVisualValidation(screenshotArtifact.hash, {
      ok: true,
      description: "",
      results: [],
      why: "vision judgment deferred",
      model: "compat-model",
      cached: false,
      deferred: true,
      pendingExpectations: ["Pending writer expectation"],
    });
    await testEvidence.close();

    const testRunPath = join(testRunDir, "test-run.json");
    const value: unknown = JSON.parse(await readFile(testRunPath, "utf8"));
    if (!isRecord(value) || !isRecord(value.summary)) throw new Error("Writer did not produce a test-run summary.");
    delete value.summary.pendingArtifacts;
    delete value.summary.pendingJudgments;
    await writeFile(testRunPath, JSON.stringify(value));

    const entries = await scanTestRuns(resultsDir);
    const entry = entries[0];
    if (!entry || entry.kind !== "test-run") throw new Error("Pending writer test run was not scanned.");
    assert.equal(entry.testRun.summary.pendingArtifacts, 1);
    assert.equal(entry.testRun.summary.pendingJudgments, 1);
    assert.deepEqual(entry.testRun.artifacts[0]?.judgments, [{
      expectation: "Pending writer expectation",
      state: "pending",
      reasoning: "vision judgment deferred",
    }]);

    const index = renderArtifactIndexHtml(entries);
    const markdown = renderPrMarkdown(entry.testRun, {});
    assert.match(index, /PENDING/);
    assert.match(markdown, /⏳ PENDING/);
    assert.match(markdown, /⏳ \*\*PENDING\*\* Pending writer expectation — vision judgment deferred/);
    assert.doesNotMatch(markdown, /no visual expectations recorded/);
  } finally {
    await rm(resultsDir, { recursive: true, force: true });
  }
});
