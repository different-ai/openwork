import { realpath } from "node:fs/promises";
import { openRuntimeSqliteDatabase, runtimeDbPath, type RuntimeSqliteDatabase } from "./runtime-db.js";
import type { ServerConfig } from "./types.js";
import { isRecord } from "./workspace-kv-store.js";

const databases = new Map<string, Promise<RuntimeSqliteDatabase>>();

async function database(config: ServerConfig) {
  const path = runtimeDbPath(config);
  let pending = databases.get(path);
  if (!pending) {
    pending = openRuntimeSqliteDatabase(path).then(db => {
      db.sqlite.exec(`CREATE TABLE IF NOT EXISTS opencode_v2_session_homes (
        session_id TEXT PRIMARY KEY NOT NULL, home_directory TEXT NOT NULL
      )`);
      return db;
    });
    databases.set(path, pending);
    void pending.catch(() => databases.delete(path));
  }
  return pending;
}

export function nativeSession(value: unknown): Record<string, unknown> | null {
  const data = isRecord(value) && "data" in value ? value.data : value;
  return isRecord(data) ? isRecord(data.info) ? data.info : data : null;
}

export function nativeSessionDirectory(value: unknown): string | null {
  const session = nativeSession(value);
  return isRecord(session?.location) && typeof session.location.directory === "string"
    ? session.location.directory : null;
}

/** OpenWork owns the conversation's home; native location remains the execution
 * directory. Only engine history can establish an older session's original home.
 * Never adopt a caller-supplied workspace or a mutable metadata label as proof. */
export function createV2SessionHomes(config: ServerConfig, read: (path: string) => Promise<unknown>) {
  const directories = new Map<string, Promise<string>>();
  const canonical = (directory: string) => {
    let pending = directories.get(directory);
    if (!pending) {
      pending = realpath(directory).catch(() => directory);
      directories.set(directory, pending);
    }
    return pending;
  };
  const stored = async (id: string): Promise<string | null> => {
    const db = await database(config);
    const row: unknown = db.sqlite.prepare("SELECT home_directory FROM opencode_v2_session_homes WHERE session_id = ?").get(id);
    return isRecord(row) && typeof row.home_directory === "string" ? row.home_directory : null;
  };
  const remember = async (id: string, directory: string) => {
    const home = await canonical(directory);
    const db = await database(config);
    db.sqlite.prepare("INSERT OR IGNORE INTO opencode_v2_session_homes (session_id, home_directory) VALUES (?, ?)").run(id, home);
    return (await stored(id)) ?? home;
  };
  const created = async (id: string, directory: string) => {
    const home = await canonical(directory);
    const db = await database(config);
    // Only a successful native creation may replace an old ID's binding.
    db.sqlite.prepare(`INSERT INTO opencode_v2_session_homes (session_id, home_directory) VALUES (?, ?)
      ON CONFLICT(session_id) DO UPDATE SET home_directory = excluded.home_directory`).run(id, home);
    return home;
  };
  const resolve = async (value: unknown, ancestors = new Set<string>()): Promise<string | null> => {
    const session = nativeSession(value);
    const directory = nativeSessionDirectory(value);
    if (!session || typeof session.id !== "string" || !directory) return null;
    const existing = await stored(session.id);
    if (existing) return existing;
    if (ancestors.has(session.id) || ancestors.size >= 256) throw new Error("Invalid conversation ancestry");
    const nextAncestors = new Set([...ancestors, session.id]);
    // Delegated sessions belong to the same conversation home even if they were
    // created after the parent moved into a worktree.
    if (typeof session.parentID === "string") {
      const parent = await resolve(await read(`/api/session/${encodeURIComponent(session.parentID)}`), nextAncestors);
      if (!parent) throw new Error("Could not verify the parent conversation");
      return remember(session.id, parent);
    }
    // Backfill sessions created before this index existed, including moves made
    // while OpenWork was closed. Read oldest first; the first move records origin.
    let cursor: string | undefined;
    const seen = new Set<string>();
    while (true) {
      const query = new URLSearchParams({ limit: "200", ...(cursor ? { cursor } : { order: "asc" }) });
      const page = await read(`/api/session/${encodeURIComponent(session.id)}/message?${query}`);
      const items = isRecord(page) ? page.data : null;
      if (!Array.isArray(items)) throw new Error("Could not verify the conversation's original folder");
      for (const item of items) {
        if (!isRecord(item) || item.type !== "location-switched") continue;
        const content = isRecord(item.data) ? item.data : item;
        const previous = isRecord(content.previous) ? content.previous : null;
        const location = previous && isRecord(previous.location) ? previous.location : null;
        if (typeof location?.directory !== "string") throw new Error("Invalid conversation move history");
        return remember(session.id, location.directory);
      }
      const next = isRecord(page) && isRecord(page.cursor) ? page.cursor.next : undefined;
      if (next === undefined || next === null) break;
      if (typeof next !== "string" || seen.has(next)) throw new Error("Invalid conversation history cursor");
      seen.add(next);
      cursor = next;
    }
    return remember(session.id, directory);
  };
  const project = async (value: unknown) => {
    const home = await resolve(value);
    const session = nativeSession(value);
    const directory = nativeSessionDirectory(value);
    if (!session || !home || !directory || home === await canonical(directory)) return value;
    const info = { ...session, openworkHomeDirectory: home };
    return isRecord(value) && isRecord(value.info) ? { ...value, info } : info;
  };
  return { canonical, stored, remember, created, resolve, project };
}
