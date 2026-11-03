// Synthetic fixture only. This helper runs before the isolated Electron host.
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { openHistoryDatabase } from "../../../apps/server/src/opencode-v2-history-store.ts";

const [root, workspace] = process.argv.slice(2);
if (!root || !workspace) throw new Error("Synthetic profile and workspace are required");
await mkdir(root, { recursive: true });
const db = await openHistoryDatabase(join(root, "synthetic-v1.db"));
try {
  // Match an existing engine-owned v1 database. A rollback-journal fixture
  // holds readers against the engine's startup WAL/schema setup instead.
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(await readFile(new URL("./opencode-v1-history/schema.sql", import.meta.url), "utf8"));
  db.exec("INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('global', '/', 1, 1, '[]'); BEGIN");
  const session = db.prepare(`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
    VALUES (?, 'global', ?, ?, ?, '1.18.30', 1, 1)`);
  const message = db.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, 1, 1, ?)");
  const part = db.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, 1, 1, ?)");
  const small = JSON.stringify({ type: "text", text: "Synthetic retained history " + "x".repeat(256 * 1024) });
  const large = JSON.stringify({ type: "text", text: "Synthetic retained history " + "x".repeat(64 * 1024 * 1024) });
  for (let index = 0; index < 320; index++) {
    const id = String(index).padStart(26, "0");
    session.run(`ses_${id}`, `synthetic-${index}`, workspace, `Synthetic conversation ${index}`);
    message.run(`msg_${id}`, `ses_${id}`, JSON.stringify({ role: "user", time: { created: 1 }, agent: "build", model: { providerID: "synthetic", modelID: "offline" } }));
    part.run(`prt_${id}`, `msg_${id}`, `ses_${id}`, index < 4 ? large : small);
  }
  db.exec("COMMIT");
  console.log(JSON.stringify({ sessions: 320, messages: 320, largePayloads: 4, largePayloadBytes: 64 * 1024 * 1024 }));
} finally { db.close(); }
