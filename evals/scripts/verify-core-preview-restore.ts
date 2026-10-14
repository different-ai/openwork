import { randomBytes, randomUUID } from "node:crypto";
import { evaluate } from "../packages/cdp/src/index.ts";
import { openedDaytonaCopy } from "../packages/env/src/daytona-evidence.ts";
import { DaytonaApi } from "../../packages/daytona-evidence/src/api.ts";
import { listDaytonaCopies, openDaytonaCheckpoint } from "../../packages/daytona-evidence/src/checkpoints.ts";
import type { EvidenceCheckpoint } from "../../packages/evidence-provider/src/checkpoint.ts";

/** Small live regression: reopen only the final Core checkpoint, after the
 * finalizer has confirmed source teardown. Uses the normal private restore and
 * access handshake, and releases only its own review copy.
 */
export async function verifyCorePreviewRestore(checkpoint: EvidenceCheckpoint): Promise<void> {
  const reportId = randomBytes(16).toString("hex");
  const api = new DaytonaApi();
  try {
    await openDaytonaCheckpoint(checkpoint, reportId, randomUUID(), api);
    await using copy = await openedDaytonaCopy(reportId);
    const text = await evaluate(copy.app.client, () => document.body.innerText);
    // The same deterministic model response Core asserts before its final fork.
    if (typeof text !== "string" || !text.includes("Acme AI Gateway is working.")) throw new Error("Final Core chat was not restored after source teardown");
  } finally {
    // Covers an attach/list failure before openedDaytonaCopy can own its handle.
    for (const copy of await listDaytonaCopies(reportId, api)) {
      if (copy.labels.sourceSha !== checkpoint.sourceSha || copy.labels.checkpoint !== checkpoint.id) throw new Error("Restore copy ownership mismatch");
      if (!["destroying", "destroyed"].includes(copy.state)) await api.deleteSandbox(copy.id);
      await api.waitForSandboxDeleted(copy.id);
    }
  }
}
