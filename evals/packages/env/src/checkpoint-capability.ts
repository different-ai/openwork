import type { Surface } from "@openwork/cdp";
import type { EvidenceCheckpoint } from "@openwork/freestyle/checkpoint-schema";

/**
 * Starts a snapshot of the world behind a surface. Resolves once the provider has
 * begun it; `saved` settles when the snapshot is fully stored.
 */
export type CheckpointCapture = (input: { imageHash: string; capturedAt: string }) => Promise<{ checkpoint: EvidenceCheckpoint; saved: Promise<void> }>;

export interface CheckpointCapability {
  /** The surface whose world is snapshotted. Other surfaces cannot be checkpointed. */
  surface: Surface;
  capture: CheckpointCapture;
  /** False once the world is gone, e.g. after a spec deletes its VM. */
  available(): boolean;
}

/**
 * Worlds that can snapshot themselves advertise it under this key. Only
 * Freestyle-backed worlds do; checkpoints requested on other worlds are skipped
 * with a warning and the test runs normally. Specs never branch on placement.
 */
export const checkpointCapability = Symbol.for("openwork.checkpointCapability");
