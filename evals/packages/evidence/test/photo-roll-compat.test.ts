import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Shot } from "../../fraimz/src/screenshot.ts";
import { openTape } from "../../fraimz/src/tape.ts";
import { scanRolls } from "../src/scan.ts";

test("scanRolls reads screenshot and fact frames produced by the real tape writer", async () => {
  const resultsDir = await mkdtemp(join(tmpdir(), "openwork-evidence-compat-"));
  const rollDir = join(resultsDir, "rolls", "2026-07-02T10-00-00-000Z-writer-compat");
  try {
    const png = Buffer.from("synthetic screenshot pixels");
    const shot: Shot = {
      png,
      hash: createHash("sha256").update(png).digest("hex"),
      route: "#/writer-compat",
      visibleText: "Writer compatibility",
      at: "2026-07-02T10:00:00.000Z",
    };
    const tape = openTape({ name: "Writer compatibility", outDir: rollDir });
    tape.recordTake(shot);
    tape.claim(shot.hash, {
      ok: true,
      description: "Writer compatibility is visible.",
      results: [{ expectation: "Writer compatibility frame 1", passed: true, evidence: "Writer compatibility" }],
      why: "",
      model: "compat-model",
      cached: false,
    });
    tape.fact("Witness compatibility", "The API returned HTTP 200.", true);
    await tape.close();

    const raw = await readFile(join(rollDir, "roll.json"), "utf8");
    assert.match(raw, /"gitSha":/);
    assert.match(raw, /"branch":/);
    const entries = await scanRolls(resultsDir);
    assert.equal(entries.length, 1);
    const entry = entries[0];
    assert.equal(entry?.kind, "roll");
    if (!entry || entry.kind !== "roll") throw new Error("Writer roll was not scanned.");
    assert.equal(entry.roll.frames[0]?.caption, "Writer compatibility frame 1");
    assert.equal(entry.roll.frames[1]?.fileName, "");
    assert.equal(typeof entry.roll.gitSha, "string");
    assert.equal(typeof entry.roll.branch, "string");
  } finally {
    await rm(resultsDir, { recursive: true, force: true });
  }
});
