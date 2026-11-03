import { parentPort, workerData } from "node:worker_threads";
import { estimateHistoryCopyBytes } from "./opencode-v2-migration.js";
import { HISTORY_PREFLIGHT_ERRORS, HISTORY_PREFLIGHT_FAILED } from "./history-copy-preflight.js";

const request: unknown = workerData;
try {
  if (typeof request !== "object" || request === null || !("source" in request) || typeof request.source !== "string"
    || !("storageDir" in request) || typeof request.storageDir !== "string"
    || !("targetDatabase" in request) || typeof request.targetDatabase !== "string") {
    throw new Error(HISTORY_PREFLIGHT_FAILED);
  }
  const bytes = await estimateHistoryCopyBytes({ source: request.source, storageDir: request.storageDir, targetDatabase: request.targetDatabase });
  parentPort?.postMessage({ ok: true, bytes });
} catch (error) {
  parentPort?.postMessage({ ok: false, error: error instanceof Error && HISTORY_PREFLIGHT_ERRORS.has(error.message)
    ? error.message : HISTORY_PREFLIGHT_FAILED });
}
