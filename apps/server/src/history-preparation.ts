import { Worker } from "node:worker_threads";
import { readHistoryInventory, readHistoryRevision } from "./history-preparation-reader.js";

type Operation = "revision" | "inventory";

/** Electron embeds the server on main. Async SQL is still synchronous there:
 * isolate the complete read (open, inventory, SQL, hash, close), not just SHA.
 * Bun hosts do not share Electron main and retain the same in-process reader.
 */
export async function prepareHistory(database: string, operation: Operation, signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted();
  if (typeof process.versions.bun === "string") {
    return operation === "revision" ? readHistoryRevision(database, signal) : readHistoryInventory(database, signal);
  }
  const started = performance.now();
  // The TS path is for source-run Node tests. tsc emits the JS sibling for the
  // packaged host. No eval worker, inherited argv, or user-controlled code path.
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const worker = new Worker(new URL(`./history-preparation-process.${extension}`, import.meta.url), {
    workerData: { database, operation },
  });
  const threadId = worker.threadId;
  let previousTick = started;
  let hostMaxLagMs = 0;
  let hostStalls250ms = 0;
  let hostTicks = 0;
  const sample = () => {
    const now = performance.now();
    const lag = Math.max(0, now - previousTick - 10);
    previousTick = now;
    hostMaxLagMs = Math.max(hostMaxLagMs, lag);
    if (lag >= 250) hostStalls250ms++;
    hostTicks++;
  };
  const heartbeat = setInterval(sample, 10);
  heartbeat.unref();
  const log = (phase: "start" | "completed" | "cancelled" | "failed") => {
    if (phase !== "start") { sample(); clearInterval(heartbeat); }
    console.info(JSON.stringify({ event: "history.preparation", operation, phase, threadId,
      elapsedMs: Math.round(performance.now() - started), hostMaxLagMs: Math.round(hostMaxLagMs), hostStalls250ms, hostTicks }));
  };
  log("start");
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (ok: boolean, value?: unknown) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      // Do not resolve while a cancelled reader still holds a WAL transaction.
      // terminate preempts even an individual synchronous SQLite call.
      void worker.terminate().then(() => {
        if (signal?.aborted) {
          log("cancelled");
          reject(signal.reason);
        } else if (ok) {
          log("completed");
          resolve(value);
        } else {
          log("failed");
          reject(new Error("Could not prepare OpenCode v1 history. Keeping v1; the original history was not changed."));
        }
      }, () => {
        log("failed");
        reject(new Error("Could not stop OpenCode v1 history preparation. Keeping v1."));
      });
    };
    const abort = () => finish(false);
    worker.once("message", (message: unknown) => {
      if (typeof message !== "object" || message === null || !("ok" in message)
        || message.ok !== true || !("value" in message)) { finish(false); return; }
      finish(true, message.value);
    });
    worker.once("error", () => finish(false));
    worker.once("exit", () => finish(false));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
