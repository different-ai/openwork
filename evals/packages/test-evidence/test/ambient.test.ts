import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { currentTestEvidence, withTestEvidence } from "../src/ambient.ts";
import type { ScreenshotArtifact } from "../src/screenshot.ts";
import { createTestEvidence } from "../src/test-evidence.ts";

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

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function hashes(dir: string): Promise<unknown[]> {
  const value: unknown = JSON.parse(await readFile(join(dir, "test-run.json"), "utf8"));
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  const artifacts = Reflect.get(value, "artifacts");
  assert.ok(Array.isArray(artifacts));
  return artifacts.map((artifact) => typeof artifact === "object" && artifact !== null ? Reflect.get(artifact, "hash") : null);
}

test("concurrent withTestEvidence scopes do not cross-record", async () => {
  const root = await mkdtemp(join(tmpdir(), "openwork-ambient-"));
  const firstDir = join(root, "first");
  const secondDir = join(root, "second");
  try {
    const first = createTestEvidence({ name: "first", outDir: firstDir });
    const second = createTestEvidence({ name: "second", outDir: secondDir });
    const firstScreenshot = screenshotArtifact("first screenshot");
    const secondScreenshot = screenshotArtifact("second screenshot");
    assert.equal(currentTestEvidence(), null);

    await Promise.all([
      withTestEvidence(first, async () => {
        await pause(15);
        const active = currentTestEvidence();
        assert.equal(active, first);
        active.recordScreenshot(firstScreenshot);
      }),
      withTestEvidence(second, async () => {
        const active = currentTestEvidence();
        assert.equal(active, second);
        active.recordScreenshot(secondScreenshot);
        await pause(25);
        assert.equal(currentTestEvidence(), second);
      }),
    ]);

    assert.equal(currentTestEvidence(), null);
    await Promise.all([first.close(), second.close()]);
    assert.deepEqual(await hashes(firstDir), [firstScreenshot.hash]);
    assert.deepEqual(await hashes(secondDir), [secondScreenshot.hash]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
