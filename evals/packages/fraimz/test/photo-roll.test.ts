import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { photoRoll } from "../src/photo-roll.ts";
import type { Shot } from "../src/screenshot.ts";
import type { SeenFacts } from "../src/validate.ts";

function shot(contents: string): Shot {
  const png = Buffer.from(contents);
  return {
    png,
    hash: createHash("sha256").update(png).digest("hex"),
    route: `#/workspace/${contents}/session`,
    visibleText: contents,
    at: "2026-07-29T12:00:00.000Z",
  };
}

function seen(caption: string, passed: boolean): SeenFacts {
  return {
    ok: passed,
    description: `Description for ${caption}`,
    results: [{ expectation: caption, passed, evidence: `${caption} evidence` }],
    why: passed ? "" : `${caption} failed`,
    model: "injected-vision-model",
    cached: false,
  };
}

test("photo roll writes distinct shots, verdicts, and idempotent indexes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openwork-photo-roll-"));
  try {
    const roll = photoRoll("unit roll", { outDir: dir });
    const firstPath = await roll.add(shot("first"), seen("First caption", true));
    const secondPath = await roll.add(shot("second"), seen("Second caption", false));

    const firstClose = await roll.close();
    const secondClose = await roll.close();
    await stat(firstPath);
    await stat(secondPath);
    assert.equal(firstClose, join(dir, "index.html"));
    assert.equal(secondClose, firstClose);

    const index = await readFile(join(dir, "index.html"), "utf8");
    const json = await readFile(join(dir, "roll.json"), "utf8");
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

test("photo roll rejects duplicate pixels and names both frames", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openwork-photo-roll-duplicate-"));
  try {
    const roll = photoRoll("duplicate roll", { outDir: dir });
    const duplicate = shot("same pixels");
    await roll.add(duplicate, seen("Original frame", true));
    await assert.rejects(
      () => roll.add(duplicate, seen("Copied frame", true)),
      /Copied frame.*Original frame/,
    );
    await roll.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
