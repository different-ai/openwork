import type { FinalizedPreview } from "../../packages/daytona-evidence/src/handoff.ts";
import type { TestRunRecord } from "../packages/test-artifacts/src/schema.ts";

/** Preview readiness never changes the mandatory test verdict. */
export function annotateCorePreview(record: TestRunRecord, sourceSha: string, previews: readonly FinalizedPreview[]): void {
  if (record.gitSha !== sourceSha) throw new Error("Core preview record SHA mismatch");
  for (const artifact of record.artifacts) {
    if (!artifact.checkpointError?.startsWith("Preview saving pending: ")) continue;
    const preview = previews.find(({ checkpoint, ready }) => ready && checkpoint.sourceSha === sourceSha
      && checkpoint.imageHash === artifact.hash && artifact.checkpointError?.startsWith(`Preview saving pending: ${checkpoint.id};`));
    if (preview) {
      artifact.checkpoint = preview.checkpoint;
      artifact.checkpointMatch = artifact.checkpointError.endsWith("match=exact") ? "exact" : "approximate";
      delete artifact.checkpointError;
    } else artifact.checkpointError = "Optional preview unavailable; screenshot and test verdict retained.";
  }
}
