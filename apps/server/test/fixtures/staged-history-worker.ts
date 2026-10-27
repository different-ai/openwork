import { migrateOpencodeV1History } from "../../src/opencode-v2-migration.js";

process.once("disconnect", () => process.exit(1));
process.once("message", async (request: unknown) => {
  if (typeof request !== "object" || request === null || !("source" in request) || typeof request.source !== "string"
    || !("storageDir" in request) || typeof request.storageDir !== "string" || !("bin" in request) || typeof request.bin !== "string"
    || !("targetDatabase" in request) || typeof request.targetDatabase !== "string") throw new Error("Invalid test request");
  await migrateOpencodeV1History({ source: request.source, storageDir: request.storageDir, bin: request.bin, targetDatabase: request.targetDatabase,
    progress: () => {}, batch: async () => {
      process.send?.({ batchCommitted: true });
      await new Promise<void>(() => { setInterval(() => {}, 1000); });
    } });
  process.exit(1);
});
