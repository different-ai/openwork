import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, expect } from "vitest";
import type { ScreenshotArtifact } from "@openwork/test-evidence";
import { validate } from "@openwork/test-evidence";
import { expectVisualEvidence, test } from "@openwork/test-evidence/vitest";

const expectation = "The synthetic frame is visible";
const testRunDirs: string[] = [];
let recordedDir = "";

afterAll(async () => {
  await Promise.all(testRunDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

test("ambient evidence fixture records and validates a synthetic screenshot", async ({ evidence }) => {
  recordedDir = evidence.dir;
  testRunDirs.push(evidence.dir);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const shot: ScreenshotArtifact = {
    png,
    hash: createHash("sha256").update(png).digest("hex"),
    route: "#/synthetic",
    visibleText: "Synthetic frame",
    at: "2026-08-02T12:00:00.000Z",
  };
  evidence.recordScreenshot(shot);
  const seen = await validate(shot, [expectation], {
    ask: async (request) => request.prompt.startsWith("Objectively describe")
      ? JSON.stringify({ description: "A one-pixel synthetic image." })
      : JSON.stringify({ results: [{ expectation, passed: true, evidence: "The synthetic pixel is present." }] }),
  });
  expectVisualEvidence(seen);
});

test("ambient evidence fixture closes the preceding test evidence", async ({ evidence }) => {
  testRunDirs.push(evidence.dir);
  const value: unknown = JSON.parse(await readFile(join(recordedDir, "test-run.json"), "utf8"));
  expect(value).toMatchObject({
    summary: {
      ok: true,
      totalArtifacts: 1,
      passedArtifacts: 1,
      failedArtifacts: 0,
      unvalidatedArtifacts: 0,
      passedExpectations: 1,
      failedExpectations: 0,
    },
    artifacts: [{ caption: expectation, ok: true }],
  });
});
