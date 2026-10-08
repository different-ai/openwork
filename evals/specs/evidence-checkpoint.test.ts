import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { Surface } from "@openwork/cdp";
import { CHECKPOINT_HOLD_MS, createTestEvidence, screenshot, takeCheckpoint, withTestEvidence, type CheckpointCapability } from "@openwork/test-evidence";
import { assembleReview } from "@openwork/test-artifacts/review";

function surface(screen: { text: string }): Surface {
  return { handle: { kind: "chrome", hostKind: "synthetic", name: "unit", cdpUrl: "http://127.0.0.1:1" }, client: {
    close() {}, async send(method) {
      if (method === "Page.captureScreenshot") return { data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64") };
      if (method === "Runtime.evaluate") return { result: { value: { route: "/", visibleText: screen.text } } };
      return {};
    },
  } };
}
const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();

function capability(app: Surface, saved: Promise<void> = Promise.resolve()): CheckpointCapability & { calls: number } {
  const value = {
    calls: 0, surface: app, available: () => true,
    async capture({ imageHash }: { imageHash: string }) {
      value.calls++;
      return { saved, checkpoint: { version: 1 as const, provider: "freestyle" as const, id: `ow-evidence-v1-${"b".repeat(32)}`,
        sourceSha, imageHash, capturedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString() } };
    },
  };
  return value;
}

test("plain screenshots never save a checkpoint", async () => {
  expect((await screenshot(surface({ text: "synthetic unit fixture" }))).checkpoint).toBeUndefined();
});

test("a still screen is an exact checkpoint that survives recording and review assembly", async () => {
  const directory = await mkdtemp(join(tmpdir(), "checkpoint-record-test-"));
  const app = surface({ text: "Ten sessions" });
  const paused: number[] = [];
  try {
    const record = createTestEvidence({ name: "Synthetic checkpoint plumbing", outDir: directory });
    const shot = await withTestEvidence(record, () => takeCheckpoint(app, capability(app), { caption: "Saved state", pause: async (ms) => { paused.push(ms); } }));
    expect(paused).toEqual([CHECKPOINT_HOLD_MS]);
    expect(shot.checkpointMatch).toBe("exact");
    record.setOutcome("passed"); await record.close();
    const { report } = await assembleReview({ testRunDirs: [directory] });
    expect(report.evidence[0]).toMatchObject({ kind: "image", caption: "Saved state", asset: `${shot.hash}.png`, checkpoint: shot.checkpoint, checkpointMatch: "exact" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a screen that changes while the moment is captured is labelled approximate", async () => {
  const screen = { text: "Partial reply" };
  const app = surface(screen);
  const shot = await takeCheckpoint(app, capability(app), { pause: async () => { screen.text = "Partial reply and more"; } });
  expect(shot.checkpoint).toBeDefined();
  expect(shot.checkpointMatch).toBe("approximate");
});

test("the test does not wait for the snapshot to be saved", async () => {
  const app = surface({ text: "Saving" });
  let finishSave = () => {};
  const saved = new Promise<void>((resolve) => { finishSave = resolve; });
  const shot = await takeCheckpoint(app, capability(app, saved), { pause: async () => undefined });
  expect(shot.checkpoint).toBeDefined();
  finishSave();
});

test("a capture failure keeps the image, never fails the proof, and records no provider details", async () => {
  const directory = await mkdtemp(join(tmpdir(), "checkpoint-failure-test-"));
  const app = surface({ text: "Capture failed" });
  const failing: CheckpointCapability = { surface: app, available: () => true, capture: async () => { throw new Error("synthetic-private-provider-error"); } };
  try {
    const record = createTestEvidence({ name: "Synthetic checkpoint failure", outDir: directory });
    const shot = await withTestEvidence(record, () => takeCheckpoint(app, failing, { caption: "Capture failed", pause: async () => undefined }));
    expect(shot.checkpoint).toBeUndefined();
    record.setOutcome("passed"); await record.close();
    const saved = await readFile(join(directory, "test-run.json"), "utf8");
    expect(saved).not.toContain("synthetic-private-provider-error");
    expect(saved).toContain("checkpointError");
    const { report } = await assembleReview({ testRunDirs: [directory] });
    expect(report.evidence.some((entry) => entry.kind === "image" && entry.checkpointError)).toBe(true);
    expect(report.evidence.some((entry) => entry.judgments.some((judgment) => judgment.state === "failed"))).toBe(false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
