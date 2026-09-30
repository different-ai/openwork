import { setTimeout as delay } from "node:timers/promises";
import type { Surface } from "@openwork/cdp";
import { parseEvidenceCheckpoint } from "@openwork/freestyle/checkpoint-schema";
import { checkpointCapability, type CheckpointCapability } from "@openwork/env";
import { currentTestEvidence } from "./ambient.ts";
import { captureFrame, type ScreenshotArtifact } from "./screenshot.ts";

// Defined in @openwork/env so worlds can advertise it without depending on the test kit.
export { checkpointCapability } from "@openwork/env";
export type { CheckpointCapability, CheckpointCapture } from "@openwork/env";

function isCapability(value: unknown): value is CheckpointCapability {
  return typeof value === "object" && value !== null
    && typeof Reflect.get(value, "capture") === "function"
    && typeof Reflect.get(value, "available") === "function"
    && typeof Reflect.get(value, "surface") === "object";
}

export function findCheckpointCapability(world: unknown): CheckpointCapability | undefined {
  if (typeof world !== "object" || world === null) return undefined;
  const value: unknown = Reflect.get(world, checkpointCapability);
  return isCapability(value) ? value : undefined;
}

/**
 * Measured on the ACME template: the snapshot captures the VM 0.19–4.1 s after
 * the call starts (12 samples), and the VM keeps running. Holding input this
 * long covers every sample; the before/after comparison labels the rest.
 */
export const CHECKPOINT_HOLD_MS = 5_000;

/**
 * Saves a reopenable checkpoint and records its image. Never throws: a checkpoint
 * adds to the evidence but is not the proof, so failures are recorded on the
 * image and the test continues.
 *
 * 1. Take image A. 2. Start the snapshot without waiting for it to be saved.
 * 3. Send no input for the hold. 4. Take image B: the same route and visible text
 * mean the screen was still while the moment was captured ("exact"), otherwise
 * "approximate". Pixel-only changes such as a blinking caret are ignored.
 */
export async function takeCheckpoint(surface: Surface, capability: CheckpointCapability, options: { caption?: string; holdMs?: number; pause?: (ms: number) => Promise<unknown> } = {}): Promise<ScreenshotArtifact> {
  const pause = options.pause ?? delay;
  const before = await captureFrame(surface);
  let artifact: ScreenshotArtifact;
  try {
    const started = await capability.capture({ imageHash: before.hash, capturedAt: before.at });
    const checkpoint = parseEvidenceCheckpoint(started.checkpoint);
    if (checkpoint.imageHash !== before.hash) throw new Error("the checkpoint does not match its image");
    started.saved.catch((error: unknown) => {
      console.warn(`[openwork/test-evidence] Checkpoint ${checkpoint.id} failed to save (${error instanceof Error ? error.message : "unknown error"}); its image is kept.`);
    });
    await pause(options.holdMs ?? CHECKPOINT_HOLD_MS);
    const after = await captureFrame(surface);
    const still = after.route === before.route && after.visibleText === before.visibleText;
    artifact = { ...before, checkpoint, checkpointMatch: still ? "exact" : "approximate" };
  } catch (error) {
    console.warn(`[openwork/test-evidence] Checkpoint skipped: ${error instanceof Error ? error.message : "unknown error"}. The screenshot is kept and the test continues.`);
    artifact = { ...before, checkpointError: "Checkpoint unavailable; screenshot retained." };
  }
  currentTestEvidence()?.recordScreenshot(artifact, { caption: options.caption });
  return artifact;
}
