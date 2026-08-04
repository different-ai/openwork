import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { currentTape, withTape } from "../src/ambient.ts";
import type { Shot } from "../src/screenshot.ts";
import { openTape } from "../src/tape.ts";

function shot(contents: string): Shot {
  const png = Buffer.from(contents);
  return {
    png,
    hash: createHash("sha256").update(png).digest("hex"),
    route: `#/${contents}`,
    visibleText: contents,
    at: "2026-08-02T12:00:00.000Z",
  };
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function hashes(dir: string): Promise<unknown[]> {
  const value: unknown = JSON.parse(await readFile(join(dir, "roll.json"), "utf8"));
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  const frames = Reflect.get(value, "frames");
  assert.ok(Array.isArray(frames));
  return frames.map((frame) => typeof frame === "object" && frame !== null ? Reflect.get(frame, "hash") : null);
}

test("concurrent withTape scopes do not cross-record", async () => {
  const root = await mkdtemp(join(tmpdir(), "openwork-ambient-"));
  const firstDir = join(root, "first");
  const secondDir = join(root, "second");
  try {
    const first = openTape({ name: "first", outDir: firstDir });
    const second = openTape({ name: "second", outDir: secondDir });
    const firstShot = shot("first shot");
    const secondShot = shot("second shot");
    assert.equal(currentTape(), null);

    await Promise.all([
      withTape(first, async () => {
        await pause(15);
        const active = currentTape();
        assert.equal(active, first);
        active.recordTake(firstShot);
      }),
      withTape(second, async () => {
        const active = currentTape();
        assert.equal(active, second);
        active.recordTake(secondShot);
        await pause(25);
        assert.equal(currentTape(), second);
      }),
    ]);

    assert.equal(currentTape(), null);
    await Promise.all([first.close(), second.close()]);
    assert.deepEqual(await hashes(firstDir), [firstShot.hash]);
    assert.deepEqual(await hashes(secondDir), [secondShot.hash]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
