import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { Surface } from "@openwork/cdp";
import { createTestEvidence, registerScreenshotCheckpoint, screenshot, withTestEvidence } from "@openwork/test-evidence";
import { assembleReview } from "@openwork/test-artifacts/review";

function surface(): Surface {
  return { handle: { kind: "chrome", hostKind: "synthetic", name: "unit", cdpUrl: "http://127.0.0.1:1" }, client: {
    close() {}, async send(method) {
      if (method === "Page.captureScreenshot") return { data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64") };
      if (method === "Runtime.evaluate") return { result: { value: { route: "/", visibleText: "synthetic unit fixture" } } };
      return {};
    },
  } };
}
const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();

test("ordinary and explicitly opted-out screenshots never allocate checkpoints", async () => {
  const app = surface();
  expect((await screenshot(app)).checkpoint).toBeUndefined();
  let called = 0;
  const unregister = registerScreenshotCheckpoint(app, async () => { called++; throw new Error("must not run"); });
  try { expect((await screenshot(app, { checkpoint: false })).checkpoint).toBeUndefined(); expect(called).toBe(0); }
  finally { unregister(); }
});

test("checkpoint metadata survives recording and review assembly with the PNG hash", async () => {
  const directory = await mkdtemp(join(tmpdir(), "checkpoint-record-test-"));
  const app = surface();
  const unregister = registerScreenshotCheckpoint(app, async ({ imageHash }) => ({ version: 1, provider: "freestyle", id: `ow-evidence-v1-${"b".repeat(32)}`,
    sourceSha, imageHash, capturedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString() }));
  try {
    const record = createTestEvidence({ name: "Synthetic checkpoint plumbing", outDir: directory });
    const shot = await withTestEvidence(record, () => screenshot(app, { caption: "Saved state" }));
    record.setOutcome("passed"); await record.close();
    const { report } = await assembleReview({ testRunDirs: [directory] });
    expect(report.evidence[0]).toMatchObject({ kind: "image", asset: `${shot.hash}.png`, checkpoint: shot.checkpoint });
  } finally { unregister(); await rm(directory, { recursive: true, force: true }); }
});

test("capture failure preserves the image but fails the proof without recording provider secrets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "checkpoint-failure-test-"));
  const app = surface();
  const unregister = registerScreenshotCheckpoint(app, async () => { throw new Error("synthetic-private-provider-error"); });
  try {
    const record = createTestEvidence({ name: "Synthetic checkpoint failure", outDir: directory });
    await expect(withTestEvidence(record, () => screenshot(app, { caption: "Capture failed" }))).rejects.toThrow("screenshot retained");
    record.setOutcome("failed"); await record.close();
    const saved = await readFile(join(directory, "test-run.json"), "utf8");
    expect(saved).not.toContain("synthetic-private-provider-error");
    expect(saved).toContain("checkpointError");
    const { report } = await assembleReview({ testRunDirs: [directory] });
    expect(report.evidence.some((entry) => entry.kind === "image" && entry.checkpointError)).toBe(true);
    expect(report.evidence.some((entry) => entry.judgments.some((judgment) => judgment.state === "failed"))).toBe(true);
  } finally { unregister(); await rm(directory, { recursive: true, force: true }); }
});
