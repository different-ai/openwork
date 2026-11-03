import { Worker } from "node:worker_threads";
import type { MigrationRequest } from "./opencode-v2-migration.js";

export type HistoryCopyEstimateRequest = Pick<MigrationRequest, "source" | "storageDir" | "targetDatabase">;

// Preserve actionable, fixed preflight refusals, never transport SQLite errors
// containing paths or history content through the worker channel.
export const HISTORY_PREFLIGHT_ERRORS = new Set([
  "The saved history copy could not be read. Its files were preserved.",
  "The saved history copy is invalid. Its files were preserved.",
  "The saved copy has no snapshot time. Its files were preserved.",
  "The saved history copy belongs to another profile. Its files were preserved.",
  "The saved history source is missing its fingerprint.",
]);
export const HISTORY_PREFLIGHT_FAILED = "Could not estimate the saved history copy. Its files were preserved.";

/** Bun is a separate server host. Node/Electron must isolate the entire read,
 * including connection setup/close, not merely the arithmetic after SQL. */
export async function estimateHistoryCopyOffMain(request: HistoryCopyEstimateRequest, signal?: AbortSignal): Promise<number> {
  signal?.throwIfAborted();
  if (typeof process.versions.bun === "string") {
    const { estimateHistoryCopyBytes } = await import("./opencode-v2-migration.js");
    const bytes = await estimateHistoryCopyBytes(request);
    signal?.throwIfAborted();
    return bytes;
  }
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const started = performance.now();
  const worker = new Worker(new URL(`./history-copy-preflight-process.${extension}`, import.meta.url), {
    workerData: { source: request.source, storageDir: request.storageDir, targetDatabase: request.targetDatabase },
  });
  const threadId = worker.threadId;
  const log = (phase: string) => console.info(JSON.stringify({ event: "history.copy.preflight", phase, threadId,
    elapsedMs: Math.round(performance.now() - started) }));
  log("start");
  return new Promise<number>((resolve, reject) => {
    let settled = false;
    const finish = (bytes?: number, error = HISTORY_PREFLIGHT_FAILED) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      // Join termination before returning, so cancellation cannot leave an
      // attached read transaction alive behind the coordinator's stop promise.
      void worker.terminate().then(() => {
        log(signal?.aborted ? "cancelled" : bytes === undefined ? "failed" : "completed");
        if (signal?.aborted) reject(signal.reason);
        else if (bytes !== undefined) resolve(bytes);
        else reject(new Error(error));
      }, () => {
        log("failed");
        reject(new Error("Could not stop history copy estimation. Its files were preserved."));
      });
    };
    const abort = () => finish();
    worker.once("message", (message: unknown) => {
      if (typeof message !== "object" || message === null) { finish(); return; }
      if ("ok" in message && message.ok === true && "bytes" in message
        && typeof message.bytes === "number" && Number.isFinite(message.bytes) && message.bytes >= 0) {
        finish(message.bytes);
      } else {
        const error = "error" in message && typeof message.error === "string" && HISTORY_PREFLIGHT_ERRORS.has(message.error)
          ? message.error : HISTORY_PREFLIGHT_FAILED;
        finish(undefined, error);
      }
    });
    worker.once("error", () => finish());
    worker.once("exit", () => finish());
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
