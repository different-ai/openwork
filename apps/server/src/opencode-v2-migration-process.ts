// Runs one chat history migration in its own process; see runOpencodeV1HistoryMigration.
import { migrateOpencodeV1History, type MigrationProcessMessage, type MigrationProcessRequest } from "./opencode-v2-migration.js";

function isRequest(value: unknown): value is MigrationProcessRequest {
  return typeof value === "object" && value !== null && "source" in value && "targetDatabase" in value;
}

function send(message: MigrationProcessMessage): Promise<void> {
  return new Promise((resolve) => {
    if (!process.send) return resolve();
    // The supervisor may already be gone; the migration still cleans up after itself.
    process.send(message, undefined, undefined, () => resolve());
  });
}

let converterPid: number | undefined;
// OpenWork quit or crashed: stop rather than keep copying unseen. The next
// migration resumes the durable workspace this leaves behind.
process.once("disconnect", () => {
  if (converterPid) {
    try { process.kill(converterPid); } catch { /* already gone */ }
  }
  process.exit(1);
});

process.once("message", async (message: unknown) => {
  if (!isRequest(message)) throw new Error("Invalid migration request");
  let reported = Promise.resolve();
  await migrateOpencodeV1History({
    ...message,
    progress: (status) => { reported = send({ type: "progress", status }); },
    scratch: (scratch) => {
      converterPid = scratch.converterPid;
      void send({ type: "scratch", scratch });
    },
  });
  // The migration has cleaned up; exit once its final status is delivered.
  await reported;
  process.exit(0);
});
