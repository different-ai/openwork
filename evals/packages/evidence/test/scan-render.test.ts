import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { renderCollectionHtml, renderPrMarkdown } from "../src/render.ts";
import { scanRolls } from "../src/scan.ts";
import type { PhotoRollRecord } from "../src/schema.ts";

function record(name: string, dir: string, createdAt: string, passed: boolean): PhotoRollRecord {
  return {
    name,
    dir,
    createdAt,
    closedAt: createdAt,
    summary: {
      ok: passed,
      totalFrames: 1,
      passedFrames: passed ? 1 : 0,
      failedFrames: passed ? 0 : 1,
      unvalidatedFrames: 0,
      passedExpectations: passed ? 1 : 0,
      failedExpectations: passed ? 0 : 1,
    },
    frames: [{
      caption: `${name} first claim`,
      fileName: "01-first.png",
      hash: `${name}-hash`,
      route: "#/workspace/test",
      at: createdAt,
      description: `${name} description`,
      model: "test-model",
      ok: passed,
      results: [{
        expectation: `${name} expectation`,
        passed,
        evidence: `${name} evidence`,
      }],
    }],
  };
}

test("scanRolls reads valid rolls and legacy evidence while tolerating corrupt roll.json", async () => {
  const resultsDir = await mkdtemp(join(tmpdir(), "openwork-evidence-scan-"));
  try {
    const rollsDir = join(resultsDir, "rolls");
    const olderDir = join(rollsDir, "2026-07-01T10-00-00-000Z-older");
    const newerDir = join(rollsDir, "2026-07-02T10-00-00-000Z-newer");
    const corruptDir = join(rollsDir, "2026-07-03T10-00-00-000Z-corrupt");
    const legacyDir = join(resultsDir, "2026-06-01T10-00-00-000Z-legacy");
    await Promise.all([
      mkdir(olderDir, { recursive: true }),
      mkdir(newerDir, { recursive: true }),
      mkdir(corruptDir, { recursive: true }),
      mkdir(legacyDir, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(olderDir, "roll.json"), JSON.stringify({
        ...record("Older", olderDir, "2026-07-01T10:00:00.000Z", true),
        futureField: { ignored: true },
      })),
      writeFile(join(newerDir, "roll.json"), JSON.stringify(record("Newer", newerDir, "2026-07-02T10:00:00.000Z", false))),
      writeFile(join(corruptDir, "roll.json"), "{not-json"),
      writeFile(join(legacyDir, "fraimz.html"), "legacy"),
      writeFile(join(legacyDir, "frame.png"), Buffer.from("legacy-png")),
    ]);

    const entries = await scanRolls(resultsDir);
    assert.equal(entries.length, 3);
    assert.deepEqual(entries.map((entry) => entry.name), ["Newer", "Older", "2026-06-01T10-00-00-000Z-legacy"]);
    assert.equal(entries.filter((entry) => entry.kind === "legacy").length, 1);
    assert.equal(entries.some((entry) => entry.directoryName.includes("corrupt")), false);

    const rendered = renderCollectionHtml(entries);
    for (const expected of ["Newer first claim", "FAILED", "PASSED", "newer/index.html", "../2026-06-01T10-00-00-000Z-legacy/fraimz.html"]) {
      assert.match(rendered, new RegExp(expected));
    }
  } finally {
    await rm(resultsDir, { recursive: true, force: true });
  }
});

test("renderPrMarkdown binds claim verdicts to uploaded image URLs", () => {
  const roll = record("PR proof", "/tmp/2026-pr-proof", "2026-07-02T10:00:00.000Z", false);
  const frame = roll.frames[0];
  if (!frame) throw new Error("Fixture frame is missing.");
  frame.results.unshift({ expectation: "Passing expectation", passed: true, evidence: "Visible" });
  const markdown = renderPrMarkdown(
    roll,
    { "01-first.png": "https://example.test/01-first.png" },
    { reproCommand: "pnpm test:proof" },
  );
  for (const expected of [
    "<!-- photo-roll -->",
    "PR proof first claim",
    "PASS",
    "FAIL",
    "https://example.test/01-first.png",
    "pnpm test:proof",
  ]) assert.match(markdown, new RegExp(expected));
});

test("scanRolls skips a symlinked roll.json without throwing", async () => {
  const resultsDir = await mkdtemp(join(tmpdir(), "openwork-evidence-symlink-roll-"));
  try {
    const rollDir = join(resultsDir, "rolls", "2026-07-02T10-00-00-000Z-symlinked");
    await mkdir(rollDir, { recursive: true });
    const outsideRoll = join(resultsDir, "outside-roll.json");
    await writeFile(outsideRoll, JSON.stringify(record("Outside", rollDir, "2026-07-02T10:00:00.000Z", true)));
    await symlink(outsideRoll, join(rollDir, "roll.json"));

    const entries = await scanRolls(resultsDir);
    assert.deepEqual(entries, []);
  } finally {
    await rm(resultsDir, { recursive: true, force: true });
  }
});
