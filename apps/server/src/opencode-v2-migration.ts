import { access, chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { importNodeSqlite } from "./runtime-db.js";
import { createManagedOpencodeV2Server, type ManagedOpencodeV2Server } from "./managed-opencode-v2.js";

export interface EngineV2MigrationStatus {
  state: "idle" | "running" | "completed" | "error";
  imported: number;
  skipped: number;
  total: number;
  error?: string;
}

export function opencodeV1DatabasePath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OPENCODE_DB === ":memory:") throw new Error("In-memory OpenCode history cannot be migrated.");
  if (env.OPENCODE_DB?.trim()) return resolve(env.OPENCODE_DB);
  return join(env.XDG_DATA_HOME || join(env.HOME || homedir(), ".local", "share"), "opencode", "opencode.db");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** SQLite's snapshot includes the WAL. Never copy a live database file directly. */
export async function snapshotV1Database(source: string, destination: string): Promise<void> {
  if (typeof process.versions.bun === "string") {
    const { Database } = await import("bun:sqlite");
    const db = new Database(source, { readonly: true });
    try { db.exec(`VACUUM INTO '${destination.replaceAll("'", "''")}'`); }
    finally { db.close(); }
  } else {
    // Electron runs the server in-process. Yield between backup batches so a
    // large history does not freeze the desktop main thread.
    const { DatabaseSync, backup } = await importNodeSqlite();
    const db = new DatabaseSync(source, { readOnly: true });
    try { await backup(db, destination); } finally { db.close(); }
  }
  await chmod(destination, 0o600);
}

export async function readMigrationSessions(database: string): Promise<Array<{ id: string; directory: string; parentId: string | null }>> {
  const db = typeof process.versions.bun === "string"
    ? new (await import("bun:sqlite")).Database(database, { readonly: true })
    : new (await importNodeSqlite()).DatabaseSync(database, { readOnly: true });
  try {
    const rows: unknown[] = db.prepare("SELECT id, directory, parent_id FROM session ORDER BY time_created, id").all();
    return rows.map((row) => {
      if (!isRecord(row) || typeof row.id !== "string" || typeof row.directory !== "string"
        || !isAbsolute(row.directory) || (row.parent_id !== null && typeof row.parent_id !== "string")) {
        throw new Error("OpenCode v1 history contains an invalid session. The original database was not changed.");
      }
      return { id: row.id, directory: row.directory, parentId: row.parent_id };
    });
  } finally { db.close(); }
}

/** Let the pinned engine transform a private snapshot, then use its native import API. */
export async function migrateOpencodeV1History(options: {
  source: string;
  storageDir: string;
  bin: string;
  target: Pick<ManagedOpencodeV2Server, "fetchJson">;
  progress: (status: EngineV2MigrationStatus) => void;
}): Promise<void> {
  await mkdir(options.storageDir, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(options.storageDir, "migration-"));
  let converter: ManagedOpencodeV2Server | undefined;
  const status: EngineV2MigrationStatus = { state: "running", imported: 0, skipped: 0, total: 0 };
  try {
    const database = join(root, "opencode.db");
    try { await access(options.source); } catch { throw new Error("No v1 chat history found for this profile. Create a v1 chat before migrating."); }
    await snapshotV1Database(options.source, database);
    const sessions = await readMigrationSessions(database);
    status.total = sessions.length;
    options.progress({ ...status });
    if (sessions.length) {
      // No user config, credentials, plugins, or previous preview database in the converter.
      const home = join(root, "home");
      await mkdir(home, { recursive: true });
      converter = await createManagedOpencodeV2Server({ bin: options.bin, rootDir: root, env: {
        HOME: home, USERPROFILE: home, XDG_DATA_HOME: join(home, "data"),
        XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache"),
        XDG_STATE_HOME: join(home, "state"), OPENCODE_DISABLE_MODELS_FETCH: "1",
      } });
      const deadline = Date.now() + 10 * 60_000;
      while (true) {
        const result = await converter.fetchJson("/api/experimental/migration/v1");
        if (result.status !== 200 || !isRecord(result.json)) throw new Error("Could not verify OpenCode's history conversion.");
        if (result.json.status === "completed") break;
        if (result.json.status === "error") throw new Error("OpenCode could not convert the history snapshot. Your v1 history is unchanged.");
        if (Date.now() > deadline) throw new Error("History conversion timed out. Retry migration.");
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      const pending = new Map(sessions.map((session) => [session.id, session]));
      while (pending.size) {
        let advanced = false;
        for (const session of pending.values()) {
          if (session.parentId && pending.has(session.parentId)) continue;
          const exported = await converter.fetchJson(`/api/session/${encodeURIComponent(session.id)}/export`, { directory: session.directory });
          if (exported.status !== 200 || !isRecord(exported.json) || !isRecord(exported.json.data)) {
            throw new Error("Could not export a converted chat. Retry migration; existing v2 chats will be skipped.");
          }
          const result = await options.target.fetchJson("/api/session/import", {
            method: "POST", directory: session.directory,
            body: { ...exported.json.data, location: { directory: session.directory } }, timeoutMs: 30_000,
          });
          if (result.status === 409) status.skipped++;
          else if (result.status === 200) status.imported++;
          else throw new Error(`Could not import a chat (${result.status}). Retry migration; existing v2 chats will be skipped.`);
          pending.delete(session.id);
          advanced = true;
          options.progress({ ...status });
        }
        if (!advanced) throw new Error("History contains circular parent chats. Your v1 history is unchanged.");
      }
    }
    options.progress({ ...status, state: "completed" });
  } catch (error) {
    options.progress({ ...status, state: "error", error: error instanceof Error ? error.message : "Migration failed. Retry migration." });
  } finally {
    try { await converter?.close(); } finally { await rm(root, { recursive: true, force: true }); }
  }
}
