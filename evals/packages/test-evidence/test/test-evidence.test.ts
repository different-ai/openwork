import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CdpClient, Surface } from "@openwork/cdp";
import { withTestEvidence } from "../src/ambient.ts";
import { screenshot } from "../src/screenshot.ts";
import type { ScreenshotArtifact } from "../src/screenshot.ts";
import { createTestEvidence } from "../src/test-evidence.ts";
import type { VisualEvidenceResult } from "../src/validate.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function screenshotArtifact(contents: string): ScreenshotArtifact {
  const png = Buffer.from(contents);
  return {
    png,
    hash: createHash("sha256").update(png).digest("hex"),
    route: `#/${contents}`,
    visibleText: contents,
    at: "2026-08-02T12:00:00.000Z",
  };
}

function seen(expectation: string, passed: boolean, evidence = `${expectation} evidence`): VisualEvidenceResult {
  return {
    ok: passed,
    description: `Description for ${expectation}`,
    results: [{ expectation, passed, evidence }],
    why: passed ? "" : `${expectation} failed`,
    model: "injected-vision-model",
    cached: false,
  };
}

async function payload(dir: string): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await readFile(join(dir, "test-run.json"), "utf8"));
  assert.ok(isRecord(value));
  return value;
}

test("test evidence writes visual validations, assertions, failures, and unvalidated screenshots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openwork-test-evidence-"));
  try {
    const testEvidence = createTestEvidence({ name: "body cam", outDir: dir });
    const passing = screenshotArtifact("passing");
    const failing = screenshotArtifact("failing");
    testEvidence.recordScreenshot(passing);
    testEvidence.recordScreenshot(failing);
    testEvidence.recordScreenshot(screenshotArtifact("unvalidated"));
    testEvidence.recordVisualValidation(passing.hash, seen("Passing screenshot", true));
    testEvidence.recordVisualValidation(failing.hash, seen("Failing screenshot", false));
    testEvidence.recordAssertionEvidence("API returned success", "HTTP 200", true);
    await testEvidence.close();

    const testRun = await payload(dir);
    assert.deepEqual(testRun.summary, {
      ok: false,
      totalArtifacts: 4,
      passedArtifacts: 2,
      failedArtifacts: 1,
      unvalidatedArtifacts: 1,
      pendingArtifacts: 0,
      passedExpectations: 2,
      failedExpectations: 1,
      pendingJudgments: 0,
    });
    assert.ok(Array.isArray(testRun.artifacts));
    assert.deepEqual(
      testRun.artifacts.map((artifact) => isRecord(artifact) ? artifact.caption : null),
      ["Passing screenshot", "Failing screenshot", "API returned success", "body cam artifact 3"],
    );
    const failedArtifact = testRun.artifacts[1];
    const assertionArtifact = testRun.artifacts[2];
    assert.ok(isRecord(failedArtifact));
    assert.equal(failedArtifact.ok, false);
    assert.ok(isRecord(assertionArtifact));
    assert.equal(assertionArtifact.fileName, "");
    await stat(join(dir, "01-passing-screenshot.png"));
    await stat(join(dir, "02-failing-screenshot.png"));
    await stat(join(dir, "03-body-cam-artifact-3.png"));

    const index = await readFile(join(dir, "index.html"), "utf8");
    assert.match(index, /API returned success/);
    assert.match(index, /unvalidated artifacts \(1\)/);
    assert.doesNotMatch(index, /<img src=""/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("test evidence accepts unchanged screenshots and only lets one validation use their pixel hash", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openwork-test-evidence-retake-"));
  try {
    const testEvidence = createTestEvidence({ name: "retakes", outDir: dir });
    const duplicate = screenshotArtifact("same pixels");
    testEvidence.recordScreenshot(duplicate);
    testEvidence.recordScreenshot(duplicate);
    testEvidence.recordVisualValidation(duplicate.hash, seen("Same validation", false, "first judgment"));
    testEvidence.recordVisualValidation(duplicate.hash, seen("Same validation", true, "replacement judgment"));
    assert.throws(
      () => testEvidence.recordVisualValidation(duplicate.hash, seen("Different validation", true)),
      /Different validation.*different visual validation.*Same validation/i,
    );
    await testEvidence.close();

    const testRun = await payload(dir);
    assert.deepEqual(testRun.summary, {
      ok: false,
      totalArtifacts: 2,
      passedArtifacts: 1,
      failedArtifacts: 0,
      unvalidatedArtifacts: 1,
      pendingArtifacts: 0,
      passedExpectations: 1,
      failedExpectations: 0,
      pendingJudgments: 0,
    });
    assert.ok(Array.isArray(testRun.artifacts));
    const validated = testRun.artifacts[0];
    assert.ok(isRecord(validated));
    assert.equal(validated.ok, true);
    assert.ok(Array.isArray(validated.results));
    assert.deepEqual(validated.results[0], {
      expectation: "Same validation",
      passed: true,
      evidence: "replacement judgment",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("screenshot automatically records an artifact in ambient test evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openwork-test-evidence-screenshot-"));
  try {
    const png = Buffer.from("ambient screenshot pixels");
    const client: CdpClient = {
      close() {},
      async send(method) {
        if (method === "Page.captureScreenshot") return { data: png.toString("base64") };
        if (method === "Runtime.evaluate") {
          return { result: { value: { route: "#/ambient", visibleText: "Ambient screenshot" } } };
        }
        throw new Error(`Unexpected CDP method: ${method}`);
      },
    };
    const app: Surface = {
      handle: { name: "fake", kind: "chrome", hostKind: "test", cdpUrl: "http://127.0.0.1" },
      client,
    };
    const testEvidence = createTestEvidence({ name: "ambient screenshot", outDir: dir });
    const captured = await withTestEvidence(testEvidence, () => screenshot(app));
    assert.equal(captured.route, "#/ambient");
    await testEvidence.close();

    const testRun = await payload(dir);
    assert.deepEqual(testRun.summary, {
      ok: false,
      totalArtifacts: 1,
      passedArtifacts: 0,
      failedArtifacts: 0,
      unvalidatedArtifacts: 1,
      pendingArtifacts: 0,
      passedExpectations: 0,
      failedExpectations: 0,
      pendingJudgments: 0,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
