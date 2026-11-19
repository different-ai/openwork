// Opt-in synchronous snapshots for fictional workshop data. Node 22.23+;
// node:sqlite may emit an ExperimentalWarning (not a storage failure).
import { DatabaseSync } from "node:sqlite";
import { serialize, deserialize } from "node:v8";
import { chmodSync, closeSync, existsSync, lstatSync, openSync } from "node:fs";
import { isAbsolute } from "node:path";

const FORMAT = "open-workplace-snapshots";
const VERSION = "1";

/** The caller owns the private (0700) parent directory and one file per participant/service. */
export function createSnapshotStore({ file }) {
  if (typeof file !== "string" || !isAbsolute(file)) throw new Error("Snapshot file must be an absolute path.");
  let fresh = false;
  try { closeSync(openSync(file, "wx", 0o600)); fresh = true; }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Snapshot file must be a regular file.");
  if ((info.mode & 0o600) !== 0o600) throw new Error("Snapshot file must be readable and writable by its owner.");
  chmodSync(file, 0o600);
  const db = new DatabaseSync(file);
  const privateFiles = () => {
    for (const path of [file, `${file}-wal`, `${file}-shm`]) if (existsSync(path)) chmodSync(path, 0o600);
  };
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    if (fresh) {
      db.exec("BEGIN IMMEDIATE; CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE snapshots (key TEXT PRIMARY KEY, value BLOB NOT NULL);");
      db.prepare("INSERT INTO metadata VALUES (?, ?)").run("format", FORMAT);
      db.prepare("INSERT INTO metadata VALUES (?, ?)").run("version", VERSION);
      db.exec("COMMIT");
    }
    const metadata = Object.fromEntries(db.prepare("SELECT key, value FROM metadata").all().map(({ key, value }) => [key, value]));
    if (metadata.format !== FORMAT || metadata.version !== VERSION || Object.keys(metadata).length !== 2) throw new Error("Unsupported snapshot database format/version.");
    const integrity = db.prepare("PRAGMA quick_check").all();
    if (integrity.length !== 1 || integrity[0].quick_check !== "ok") throw new Error("Snapshot database integrity check failed.");
    // Validate the snapshot table even when there are no keys yet. Never reseed an invalid database.
    db.prepare("SELECT key, value FROM snapshots LIMIT 0").all();
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    privateFiles();
    const read = db.prepare("SELECT value FROM snapshots WHERE key = ?");
    const write = db.prepare("INSERT INTO snapshots (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    const remove = db.prepare("DELETE FROM snapshots WHERE key = ?");
    return {
      read(key) { const row = read.get(key); return row === undefined ? undefined : deserialize(row.value); },
      write(key, value) { write.run(key, serialize(value)); privateFiles(); },
      delete(key) { remove.run(key); privateFiles(); },
      close() { db.close(); },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
