import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, expect } from "vitest";
import type { Shot } from "@openwork/fraimz";
import { validate } from "@openwork/fraimz";
import { expectFrame, test } from "@openwork/fraimz/vitest";

const expectation = "The synthetic frame is visible";
const rollDirs: string[] = [];
let recordedDir = "";

afterAll(async () => {
  await Promise.all(rollDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

test("ambient evidence fixture records and claims a synthetic shot", async ({ evidence }) => {
  recordedDir = evidence.dir;
  rollDirs.push(evidence.dir);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const shot: Shot = {
    png,
    hash: createHash("sha256").update(png).digest("hex"),
    route: "#/synthetic",
    visibleText: "Synthetic frame",
    at: "2026-08-02T12:00:00.000Z",
  };
  evidence.recordTake(shot);
  const seen = await validate(shot, [expectation], {
    ask: async (request) => request.prompt.startsWith("Objectively describe")
      ? JSON.stringify({ description: "A one-pixel synthetic image." })
      : JSON.stringify({ results: [{ expectation, passed: true, evidence: "The synthetic pixel is present." }] }),
  });
  expectFrame(seen);
});

test("ambient evidence fixture closes the preceding test tape", async ({ evidence }) => {
  rollDirs.push(evidence.dir);
  const value: unknown = JSON.parse(await readFile(join(recordedDir, "roll.json"), "utf8"));
  expect(value).toMatchObject({
    summary: {
      ok: true,
      totalFrames: 1,
      passedFrames: 1,
      failedFrames: 0,
      unvalidatedFrames: 0,
      passedExpectations: 1,
      failedExpectations: 0,
    },
    frames: [{ caption: expectation, ok: true }],
  });
});
