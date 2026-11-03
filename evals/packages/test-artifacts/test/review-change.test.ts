import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assembleReview } from "../src/review.ts";

const SHA = "2222222222222222222222222222222222222222";
// A 1×1 PNG: enough for the assembler to read its size.
const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jr1sAAAAASUVORK5CYII=", "base64");

function image(fileName: string, caption: string, extra: Record<string, unknown>) {
  return { caption, fileName, hash: fileName, route: "#/", at: "2026-10-02T10:00:00.000Z", description: "", model: "", ok: null, results: [], judgments: [], ...extra };
}

test("the report keeps each image's step, what changed, what was checked, and its size", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openwork-review-change-"));
  try {
    const change = {
      since: "01-before.png",
      actions: ["click(text=Advanced options)"],
      ratio: 0.004,
      boxes: [{ x: 0.3, y: 0.73, width: 0.28, height: 0.1 }],
      added: ["Auto manages its model settings."],
      addedCount: 1,
      removed: [],
      removedCount: 0,
    };
    await writeFile(join(dir, "test-run.json"), JSON.stringify({
      name: "a member finds effort under Advanced options",
      dir,
      createdAt: "2026-10-02T10:00:00.000Z",
      closedAt: "2026-10-02T10:01:00.000Z",
      gitSha: SHA,
      engine: "v1",
      summary: { ok: false, totalArtifacts: 3, passedArtifacts: 1, failedArtifacts: 0, unvalidatedArtifacts: 2, pendingArtifacts: 0, passedExpectations: 1, failedExpectations: 0, pendingJudgments: 0 },
      artifacts: [
        image("01-before.png", "before: Advanced options is collapsed", { step: "before: Advanced options is collapsed", change: { ...change, since: null, ratio: 1, boxes: [{ x: 0, y: 0, width: 1, height: 1 }], actions: [], added: [], addedCount: 0 } }),
        image("02-before.png", "before: Advanced options is collapsed", {
          step: "before: Advanced options is collapsed",
          change,
          focus: [{ label: "Advanced options", box: { x: 0.3, y: 0.73, width: 0.28, height: 0.05 } }],
          settle: { ms: 210, settled: true },
        }),
        image("03-failed.png", "failed: effort survives reload", { step: "effort survives reload", failure: true, change: { ratio: "lots" }, settle: { ms: 1500, settled: false } }),
        { caption: "Effort stays hidden for Auto", fileName: "", hash: "", route: "", at: "2026-10-02T10:00:01.000Z", description: "0 effort controls", model: "", ok: true, results: [{ expectation: "Effort stays hidden for Auto", passed: true, evidence: "0 effort controls" }], judgments: [{ expectation: "Effort stays hidden for Auto", state: "passed", reasoning: "0 effort controls" }], step: "before: Advanced options is collapsed" },
      ],
      trace: [],
      steps: [],
      outcome: "failed",
      failure: "Timed out",
    }));
    for (const name of ["01-before.png", "02-before.png", "03-failed.png"]) await writeFile(join(dir, name), PIXEL);
    const { report } = await assembleReview({ testRunDirs: [dir] });
    const [first, second, failed, check] = report.evidence;
    assert.ok(first?.kind === "image" && second?.kind === "image" && failed?.kind === "image" && check?.kind === "assertion");
    assert.deepEqual(second.size, { width: 1, height: 1 });
    assert.equal(second.step, "before: Advanced options is collapsed");
    assert.deepEqual(second.change, change);
    assert.deepEqual(second.focus, [{ label: "Advanced options", box: { x: 0.3, y: 0.73, width: 0.28, height: 0.05 } }]);
    assert.equal(second.settled, true);
    assert.equal(first.change?.since, null);
    // A malformed measurement drops out; the image and the failure stay.
    assert.equal(failed.change, undefined);
    assert.equal(failed.failure, true);
    assert.equal(failed.settled, false);
    assert.equal(check.step, "before: Advanced options is collapsed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
