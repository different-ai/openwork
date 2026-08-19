import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createVisualEvidence } from "../src/visual-evidence.ts";
import type { ScreenshotArtifact } from "../src/screenshot.ts";
import type { VisualEvidenceResult } from "../src/validate.ts";

function screenshotArtifact(contents: string): ScreenshotArtifact {
  const png = Buffer.from(contents);
  return {
    png,
    hash: createHash("sha256").update(png).digest("hex"),
    route: `#/workspace/${contents}/session`,
    visibleText: contents,
    at: "2026-07-29T12:00:00.000Z",
  };
}

function seen(caption: string, passed: boolean): VisualEvidenceResult {
  return {
    ok: passed,
    description: `Description for ${caption}`,
    results: [{ expectation: caption, passed, evidence: `${caption} evidence` }],
    why: passed ? "" : `${caption} failed`,
    model: "injected-vision-model",
    cached: false,
  };
}

test("visual evidence writes distinct screenshots, verdicts, and idempotent indexes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openwork-visual-evidence-"));
  try {
    const visualEvidence = createVisualEvidence("unit test run", { outDir: dir });
    const firstPath = await visualEvidence.recordScreenshot(screenshotArtifact("first"), seen("First caption", true));
    const secondPath = await visualEvidence.recordScreenshot(screenshotArtifact("second"), seen("Second caption", false));

    const firstClose = await visualEvidence.close();
    const secondClose = await visualEvidence.close();
    await stat(firstPath);
    await stat(secondPath);
    assert.equal(firstClose, join(dir, "index.html"));
    assert.equal(secondClose, firstClose);

    const index = await readFile(join(dir, "index.html"), "utf8");
    const json = await readFile(join(dir, "test-run.json"), "utf8");
    for (const expected of ["First caption", "Second caption", "PASS", "FAIL"]) {
      assert.match(index, new RegExp(expected));
    }
    for (const expected of ["First caption", "Second caption", '"passed": true', '"passed": false']) {
      assert.match(json, new RegExp(expected));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("visual evidence rejects duplicate pixels assigned to different validations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openwork-visual-evidence-duplicate-"));
  try {
    const visualEvidence = createVisualEvidence("duplicate test run", { outDir: dir });
    const duplicate = screenshotArtifact("same pixels");
    await visualEvidence.recordScreenshot(duplicate, seen("Original screenshot", true));
    await assert.rejects(
      () => visualEvidence.recordScreenshot(duplicate, seen("Copied screenshot", true)),
      /Copied screenshot.*Original screenshot/,
    );
    await visualEvidence.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
