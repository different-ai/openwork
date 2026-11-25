import { realpath } from "node:fs/promises";
import { opencodeV1DatabasePath, v1ChatDirectory } from "./opencode-history.js";
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

export type V2SessionOrigin = (sessionId: string) => Promise<string | null>;

async function v1Origin(sessionId: string): Promise<string | null> {
  let database: string;
  try { database = opencodeV1DatabasePath(); } catch { return null; }
  return v1ChatDirectory(database, sessionId);
}

const HISTORY_SCAN_CONCURRENCY = 4;
let historyScans = 0;
const historyScanQueue: Array<() => void> = [];

async function withHistoryScanSlot<T>(scan: () => Promise<T>): Promise<T> {
  if (historyScans >= HISTORY_SCAN_CONCURRENCY) {
    await new Promise<void>(resolve => historyScanQueue.push(resolve));
  } else {
    historyScans++;
  }
  try { return await scan(); }
  finally {
    const next = historyScanQueue.shift();
    if (next) next();
    else historyScans--;
  }
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

export function createV2SessionHomes(
  config: ServerConfig,
  read: (path: string) => Promise<unknown>,
  origin: V2SessionOrigin = v1Origin,
) {
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
    if (typeof session.parentID === "string") {
      const parent = await resolve(await read(`/api/session/${encodeURIComponent(session.parentID)}`), nextAncestors);
      if (!parent) throw new Error("Could not verify the parent conversation");
      return remember(session.id, parent);
    }
    const id = session.id;
    const copied = await origin(id).catch(() => null);
    if (copied) return remember(id, copied);
    const recorded = await withHistoryScanSlot(() => historyOrigin(id));
    return remember(id, recorded ?? directory);
  };
  const historyOrigin = async (id: string): Promise<string | null> => {
    let cursor: string | undefined;
    const seen = new Set<string>();
    while (true) {
      const query = new URLSearchParams({ limit: "200", ...(cursor ? { cursor } : { order: "asc" }) });
      const page = await read(`/api/session/${encodeURIComponent(id)}/message?${query}`);
      const items = isRecord(page) ? page.data : null;
      if (!Array.isArray(items)) throw new Error("Could not verify the conversation's original folder");
      for (const item of items) {
        if (!isRecord(item) || item.type !== "location-switched") continue;
        const content = isRecord(item.data) ? item.data : item;
        const previous = isRecord(content.previous) ? content.previous : null;
        const location = previous && isRecord(previous.location) ? previous.location : null;
        if (typeof location?.directory !== "string") throw new Error("Invalid conversation move history");
        return location.directory;
      }
      const next = isRecord(page) && isRecord(page.cursor) ? page.cursor.next : undefined;
      if (next === undefined || next === null) break;
      if (typeof next !== "string" || seen.has(next)) throw new Error("Invalid conversation history cursor");
      seen.add(next);
      cursor = next;
    }
    return null;
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
