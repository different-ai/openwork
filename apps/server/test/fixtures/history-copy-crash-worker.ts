// Runs one history copy and stops dead after a chosen number of committed
// transfer batches, so the parent can kill it as a crash would.
import { migrateOpencodeV1History } from "../../src/opencode-v2-migration.js";

process.once("disconnect", () => process.exit(1));
process.once("message", async (request: unknown) => {
  if (typeof request !== "object" || request === null || !("source" in request) || typeof request.source !== "string"
    || !("storageDir" in request) || typeof request.storageDir !== "string"
    || !("targetDatabase" in request) || typeof request.targetDatabase !== "string"
    || !("hangAfterBatches" in request) || typeof request.hangAfterBatches !== "number") throw new Error("Invalid test request");
  const hangAfter = request.hangAfterBatches;
  let batches = 0;
  await migrateOpencodeV1History({ source: request.source, storageDir: request.storageDir, bin: "/unused-in-the-copying-stage",
    targetDatabase: request.targetDatabase, progress: () => {}, batch: async () => {
      if (++batches < hangAfter) return;
      process.send?.({ batchesCommitted: batches });
      await new Promise<void>(() => { setInterval(() => {}, 1000); });
    } });
  process.exit(1);
});
