import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CdpClient, Surface } from "@openwork/cdp";
import { withTape } from "../src/ambient.ts";
import { screenshot } from "../src/screenshot.ts";
import type { Shot } from "../src/screenshot.ts";
import { openTape } from "../src/tape.ts";
import type { SeenFacts } from "../src/validate.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

function seen(expectation: string, passed: boolean, evidence = `${expectation} evidence`): SeenFacts {
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
  const value: unknown = JSON.parse(await readFile(join(dir, "roll.json"), "utf8"));
  assert.ok(isRecord(value));
  return value;
}

test("tape writes claimed frames, fact frames, failed frames, and unclaimed takes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openwork-tape-"));
  try {
    const tape = openTape({ name: "body cam", outDir: dir });
    const passing = shot("passing");
    const failing = shot("failing");
    tape.recordTake(passing);
    tape.recordTake(failing);
    tape.recordTake(shot("unclaimed"));
    tape.claim(passing.hash, seen("Passing frame", true));
    tape.claim(failing.hash, seen("Failing frame", false));
    tape.fact("API returned success", "HTTP 200", true);
    await tape.close();

    const roll = await payload(dir);
    assert.deepEqual(roll.summary, {
      ok: false,
      totalFrames: 4,
      passedFrames: 2,
      failedFrames: 1,
      unvalidatedFrames: 1,
      passedExpectations: 2,
      failedExpectations: 1,
    });
    assert.ok(Array.isArray(roll.frames));
    assert.deepEqual(
      roll.frames.map((frame) => isRecord(frame) ? frame.caption : null),
      ["Passing frame", "Failing frame", "API returned success", "body cam frame 3"],
    );
    const failedFrame = roll.frames[1];
    const factFrame = roll.frames[2];
    assert.ok(isRecord(failedFrame));
    assert.equal(failedFrame.ok, false);
    assert.ok(isRecord(factFrame));
    assert.equal(factFrame.fileName, "");
    await stat(join(dir, "01-passing-frame.png"));
    await stat(join(dir, "02-failing-frame.png"));
    await stat(join(dir, "03-body-cam-frame-3.png"));

    const index = await readFile(join(dir, "index.html"), "utf8");
    assert.match(index, /API returned success/);
    assert.match(index, /unclaimed takes \(1\)/);
    assert.doesNotMatch(index, /<img src=""/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("tape accepts unchanged retakes and only lets one claim use their pixel hash", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openwork-tape-retake-"));
  try {
    const tape = openTape({ name: "retakes", outDir: dir });
    const duplicate = shot("same pixels");
    tape.recordTake(duplicate);
    tape.recordTake(duplicate);
    tape.claim(duplicate.hash, seen("Same claim", false, "first judgment"));
    tape.claim(duplicate.hash, seen("Same claim", true, "replacement judgment"));
    assert.throws(
      () => tape.claim(duplicate.hash, seen("Different claim", true)),
      /Different claim.*different claim.*Same claim/i,
    );
    await tape.close();

    const roll = await payload(dir);
    assert.deepEqual(roll.summary, {
      ok: false,
      totalFrames: 2,
      passedFrames: 1,
      failedFrames: 0,
      unvalidatedFrames: 1,
      passedExpectations: 1,
      failedExpectations: 0,
    });
    assert.ok(Array.isArray(roll.frames));
    const claimed = roll.frames[0];
    assert.ok(isRecord(claimed));
    assert.equal(claimed.ok, true);
    assert.ok(Array.isArray(claimed.results));
    assert.deepEqual(claimed.results[0], {
      expectation: "Same claim",
      passed: true,
      evidence: "replacement judgment",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("screenshot automatically records a take in the ambient tape", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openwork-tape-screenshot-"));
  try {
    const png = Buffer.from("ambient screenshot pixels");
    const client: CdpClient = {
      close() {},
      async send(method) {
        if (method === "Page.captureScreenshot") return { data: png.toString("base64") };
        if (method === "Runtime.evaluate") {
          return { result: { value: { route: "#/ambient", visibleText: "Ambient frame" } } };
        }
        throw new Error(`Unexpected CDP method: ${method}`);
      },
    };
    const app: Surface = {
      handle: { name: "fake", kind: "chrome", hostKind: "test", cdpUrl: "http://127.0.0.1" },
      client,
    };
    const tape = openTape({ name: "ambient screenshot", outDir: dir });
    const captured = await withTape(tape, () => screenshot(app));
    assert.equal(captured.route, "#/ambient");
    await tape.close();

    const roll = await payload(dir);
    assert.deepEqual(roll.summary, {
      ok: false,
      totalFrames: 1,
      passedFrames: 0,
      failedFrames: 0,
      unvalidatedFrames: 1,
      passedExpectations: 0,
      failedExpectations: 0,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
