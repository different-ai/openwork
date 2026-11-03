import { join } from "node:path";
import { openHistoryDatabase } from "../src/opencode-v2-history-store.js";

/** Synthetic only: 320 chats, 320 messages, and 320 large tool payloads (320 MiB).
 * No wall-clock sleeps or mocked SQL cost: the shipping revision scanner does the work.
 */
export async function largeHistoryFixture(directory: string) {
  const database = join(directory, "synthetic-v1.db");
  const db = await openHistoryDatabase(database);
  try {
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
      CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, parent_id TEXT, time_created INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, data BLOB);
      BEGIN;`);
    const session = db.prepare("INSERT INTO session VALUES (?, ?, ?, NULL, ?)");
    const message = db.prepare("INSERT INTO message VALUES (?, ?, ?)");
    const part = db.prepare("INSERT INTO part VALUES (?, ?, ?)");
    const payload = Buffer.alloc(1024 * 1024, 120);
    for (let index = 0; index < 320; index++) {
      const id = String(index).padStart(4, "0");
      session.run(`ses_${id}`, `Synthetic history ${id}`, directory, index);
      message.run(`msg_${id}`, `ses_${id}`, '{"role":"assistant","synthetic":true}');
      payload.writeUInt32LE(index, 0);
      part.run(`prt_${id}`, `msg_${id}`, payload);
    }
    db.exec("COMMIT");
  } finally { db.close(); }
  return database;
}

/** Include the final delayed tick, not just ticks that ran before the scan resolved. */
export async function heartbeatDuring<T>(operation: () => Promise<T>) {
  const intervalMs = 10;
  let previous = performance.now();
  const delays: number[] = [];
  const tick = () => {
    const now = performance.now();
    delays.push(Math.max(0, now - previous - intervalMs));
    previous = now;
  };
  const timer = setInterval(tick, intervalMs);
  const started = performance.now();
  try {
    const value = await operation();
    await new Promise<void>(resolve => setTimeout(resolve, intervalMs * 2));
    return { value, maxLagMs: Math.max(0, ...delays), stalls: delays.filter(ms => ms >= 250).length,
      ticks: delays.length, elapsedMs: performance.now() - started };
  } finally { clearInterval(timer); }
}
