import type { Surface } from "@openwork/cdp";
import { parseEvidenceCheckpoint, type EvidenceCheckpoint } from "@openwork/freestyle/checkpoint-schema";

export type CheckpointCapture = (input: { imageHash: string; capturedAt: string }) => Promise<EvidenceCheckpoint>;
const providers = new WeakMap<Surface, CheckpointCapture>();
const pending = new WeakMap<Surface, Promise<unknown>>();

/** The opted-in world owns the provider; ordinary screenshots allocate nothing. */
export function registerScreenshotCheckpoint(surface: Surface, capture: CheckpointCapture): () => void {
  if (providers.has(surface)) throw new Error("This surface already has a checkpoint provider");
  providers.set(surface, capture);
  return () => { providers.delete(surface); };
}

export async function captureScreenshotCheckpoint(surface: Surface, input: { imageHash: string; capturedAt: string }): Promise<EvidenceCheckpoint | undefined> {
  const capture = providers.get(surface);
  if (!capture) return undefined;
  const operation = (pending.get(surface) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const checkpoint = parseEvidenceCheckpoint(await capture(input));
    if (checkpoint.imageHash !== input.imageHash) throw new Error("Checkpoint image mismatch");
    return checkpoint;
  });
  pending.set(surface, operation);
  try { return await operation; }
  finally { if (pending.get(surface) === operation) pending.delete(surface); }
}
