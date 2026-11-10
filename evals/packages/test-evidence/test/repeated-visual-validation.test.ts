import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTestEvidence, type TestArtifact, type TestEvidenceRecorder, type TestRunRecord } from "../src/test-evidence.ts";
import type { ScreenshotArtifact } from "../src/screenshot.ts";
import type { VisualEvidenceResult } from "../src/validate.ts";

// A synthetic one-pixel PNG: no browser, product runtime, or vision provider.
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1cAAAAASUVORK5CYII=", "base64");
const hash = createHash("sha256").update(png).digest("hex");
const expectation = "The synthetic pixel is visible";

function frame(index: number): ScreenshotArtifact {
  return { png, hash, route: `#/capture-${index}`, visibleText: "Synthetic pixel", at: `2026-11-09T10:00:0${index}.000Z` };
}

function verdict(passed = true): VisualEvidenceResult {
  return {
    ok: passed,
    description: "Synthetic pixel fixture",
    results: [{ expectation, passed, evidence: passed ? "The fixture pixel is present" : "The expected pixel is absent" }],
    why: passed ? "" : "The expected pixel is absent",
    model: "synthetic-unit-test",
    cached: false,
  };
}

async function withRecorder(run: (recorder: TestEvidenceRecorder, finish: () => Promise<TestRunRecord>) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "openwork-repeated-visual-validation-"));
  const recorder = createTestEvidence({ name: "repeated pixels", outDir: dir });
  try {
    await run(recorder, async () => {
      await recorder.close();
      return JSON.parse(await readFile(join(dir, "test-run.json"), "utf8"));
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function screenshots(record: TestRunRecord): TestArtifact[] {
  return record.artifacts.filter((artifact): artifact is TestArtifact => artifact.kind !== "json");
}

test("each repeated capture receives its compatible validation and retains its capture context", async () => {
  await withRecorder(async (recorder, finish) => {
    const evidence = verdict();
    for (const index of [1, 2]) {
      recorder.setActiveStep(`step ${index}`);
      recorder.recordScreenshot(frame(index), { caption: `capture ${index}`, focus: [{ label: `focus ${index}`, box: { x: 0, y: 0, width: 1, height: 1 } }] });
      assert.equal(recorder.recordVisualValidation(hash, evidence), join(recorder.dir, `0${index}-the-synthetic-pixel-is-visible.png`));
    }
    const record = await finish();
    const artifacts = screenshots(record);
    assert.equal(artifacts.length, 2);
    for (const [index, artifact] of artifacts.entries()) {
      assert.equal(artifact.caption, expectation);
      assert.equal(artifact.step, `step ${index + 1}`);
      assert.equal(artifact.route, frame(index + 1).route);
      assert.equal(artifact.at, frame(index + 1).at);
      assert.equal(artifact.focus?.[0].label, `focus ${index + 1}`);
      assert.equal(artifact.ok, true);
      assert.equal(artifact.description, evidence.description);
      assert.equal(artifact.model, evidence.model);
      assert.deepEqual(artifact.results, evidence.results);
      assert.deepEqual(artifact.judgments, [{ expectation, state: "passed", reasoning: evidence.results[0].evidence }]);
      assert.deepEqual(await readFile(join(recorder.dir, artifact.fileName)), png);
    }
    assert.equal(record.summary.unvalidatedArtifacts, 0);
    assert.equal(record.summary.passedArtifacts, 2);
    assert.equal(record.summary.passedExpectations, 2);
  });
});

test("validation selects the latest unvalidated matching capture, without validating earlier captures implicitly", async () => {
  await withRecorder(async (recorder, finish) => {
    recorder.recordScreenshot(frame(1), { caption: "earlier capture" });
    recorder.recordScreenshot(frame(2), { caption: "latest capture" });
    assert.equal(recorder.recordVisualValidation(hash, verdict()), join(recorder.dir, "02-the-synthetic-pixel-is-visible.png"));
    const record = await finish();
    const [earlier, latest] = screenshots(record);
    assert.equal(earlier.caption, "earlier capture");
    assert.equal(earlier.ok, null);
    assert.deepEqual(earlier.judgments, []);
    assert.equal(latest.ok, true);
    assert.equal(record.summary.unvalidatedArtifacts, 1);
  });
});

test("conflicting expectations still throw even when a fresh matching capture exists", async () => {
  await withRecorder(async (recorder, finish) => {
    recorder.recordScreenshot(frame(1));
    recorder.recordVisualValidation(hash, verdict());
    recorder.recordScreenshot(frame(2), { caption: "unvalidated capture" });
    const incompatible = verdict();
    incompatible.results = [{ expectation: "A different claim", passed: true, evidence: "Different synthetic evidence" }];
    assert.throws(() => recorder.recordVisualValidation(hash, incompatible), /already back the different visual validation/);
    const record = await finish();
    const [validated, unvalidated] = screenshots(record);
    assert.deepEqual(validated.results, verdict().results);
    assert.equal(unvalidated.caption, "unvalidated capture");
    assert.equal(unvalidated.ok, null);
    assert.deepEqual(unvalidated.judgments, []);
  });
});

for (const state of ["failed", "pending"]) {
  test(`repeated captures preserve ${state} evidence instead of upgrading it to a pass`, async () => {
    await withRecorder(async (recorder, finish) => {
      const evidence = state === "failed" ? verdict(false) : {
        ...verdict(), ok: false, results: [], deferred: true, pendingExpectations: [expectation], why: "Deferred for an actual vision judgment",
      };
      for (const index of [1, 2]) {
        recorder.recordScreenshot(frame(index));
        recorder.recordVisualValidation(hash, evidence);
      }
      const record = await finish();
      for (const artifact of screenshots(record)) {
        assert.equal(artifact.ok, state === "failed" ? false : null);
        assert.deepEqual(artifact.results, evidence.results);
        assert.deepEqual(artifact.judgments, [{ expectation, state, reasoning: state === "failed" ? evidence.results[0].evidence : evidence.why }]);
      }
      assert.equal(record.summary.passedArtifacts, 0);
      // The existing summary includes pending artifacts in its null-ok count.
      assert.equal(record.summary.unvalidatedArtifacts, state === "pending" ? 2 : 0);
      assert.equal(record.summary.failedArtifacts, state === "failed" ? 2 : 0);
      assert.equal(record.summary.pendingArtifacts, state === "pending" ? 2 : 0);
      assert.equal(record.summary.ok, false);
    });
  });
}

for (const state of ["failed", "pending"]) {
  test(`a new passing capture does not overwrite an earlier ${state} judgment`, async () => {
    await withRecorder(async (recorder, finish) => {
      const earlierEvidence = state === "failed" ? verdict(false) : {
        ...verdict(), ok: false, results: [], deferred: true, pendingExpectations: [expectation], why: "Still awaiting a judgment",
      };
      recorder.recordScreenshot(frame(1));
      recorder.recordVisualValidation(hash, earlierEvidence);
      recorder.recordScreenshot(frame(2));
      recorder.recordVisualValidation(hash, verdict());
      const record = await finish();
      const [earlier, latest] = screenshots(record);
      assert.equal(earlier.ok, state === "failed" ? false : null);
      assert.equal(earlier.judgments[0].state, state);
      assert.deepEqual(earlier.results, earlierEvidence.results);
      assert.equal(latest.ok, true);
      assert.equal(latest.judgments[0].state, "passed");
      assert.equal(record.summary.passedArtifacts, 1);
      assert.equal(record.summary.ok, false);
    });
  });
}

test("compatible revalidation falls back to an existing capture when there is no new capture", async () => {
  await withRecorder(async (recorder, finish) => {
    recorder.recordScreenshot(frame(1));
    const path = recorder.recordVisualValidation(hash, verdict(false));
    const evidence = verdict();
    assert.equal(recorder.recordVisualValidation(hash, evidence), path);
    const record = await finish();
    assert.equal(record.artifacts.length, 1);
    assert.deepEqual(screenshots(record)[0].results, evidence.results);
    assert.equal(record.summary.passedArtifacts, 1);
  });
});

test("validation requires a recorded screenshot and missing deferred expectations remain rejected", async () => {
  await withRecorder(async (recorder, finish) => {
    assert.throws(() => recorder.recordVisualValidation(hash, verdict()), /No recorded screenshot has hash/);
    recorder.recordScreenshot(frame(1), { caption: "not judged" });
    assert.throws(() => recorder.recordVisualValidation(hash, { ...verdict(), deferred: true }), /must include pending expectations/);
    const record = await finish();
    assert.equal(screenshots(record)[0].ok, null);
    assert.deepEqual(screenshots(record)[0].judgments, []);
    assert.equal(record.summary.unvalidatedArtifacts, 1);
    assert.equal(record.summary.passedArtifacts, 0);
  });
});
