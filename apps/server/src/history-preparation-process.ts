import { parentPort, workerData } from "node:worker_threads";
import { readHistoryInventory, readHistoryRevision } from "./history-preparation-reader.js";

// This worker owns only a read transaction. It never acquires copy ownership,
// opens a target, writes a checkpoint, or decides which engine serves chats.
try {
  const request: unknown = workerData;
  if (typeof request !== "object" || request === null || !("database" in request)
    || typeof request.database !== "string" || !("operation" in request)) {
    throw new Error("Invalid history preparation request.");
  }
  if (request.operation !== "revision" && request.operation !== "inventory") {
    throw new Error("Invalid history preparation operation.");
  }
  const value = request.operation === "revision"
    ? await readHistoryRevision(request.database)
    : await readHistoryInventory(request.database);
  parentPort?.postMessage({ ok: true, value });
} catch {
  // SQLite errors can contain paths or content. Fail closed with an allowlisted
  // error rather than copying arbitrary worker exception text into host logs.
  parentPort?.postMessage({ ok: false });
} finally { parentPort?.close(); }
