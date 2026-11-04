import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { isolatedOpencodeV1Database } from "./managed-opencode.js";
import { importNodeSqlite } from "./runtime-db.js";

/** The original v1 store, including a private store selected after a collision. */
export function opencodeV1DatabasePath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OPENCODE_DB === ":memory:") throw new Error("In-memory OpenCode history cannot be migrated.");
  if (env.OPENCODE_DB?.trim()) return resolve(env.OPENCODE_DB);
  // The isolated store belongs to this running host, not to a caller-supplied
  // environment describing a different profile.
  const isolated = env === process.env ? isolatedOpencodeV1Database() : undefined;
  if (isolated) return isolated;
  return join(env.XDG_DATA_HOME || join(env.HOME || homedir(), ".local", "share"), "opencode", "opencode.db");
}

async function openReadOnlyDatabase(database: string) {
  return typeof process.versions.bun === "string"
    ? new (await import("bun:sqlite")).Database(database, { readonly: true })
    : new (await importNodeSqlite()).DatabaseSync(database, { readOnly: true });
}

/**
 * Keep an existing OpenWork v2 history; otherwise let upstream OpenCode migrate
 * the original database in place. Merely starting the old sidecar created an
 * empty schema, so the existence of opencode.db alone does not establish history.
 *
 * Selection only: never copy, merge, delete, reset conversion markers, recover
 * copy checkpoints, or clear locks. In-place upstream conversion resumes its own
 * `kv` migration.v1-v2 cursor and retains the original v1 tables. An interrupted
 * OpenWork copy's private checkpoints are not upstream cursors: leave them alone
 * and keep serving any existing v2 history, without reviving the copy or its fence.
 *
 * Split history stays split: once the separate database contains chats it wins,
 * even when the original has newer chats. Staging directories and old lock/lease
 * files do not establish history and are left untouched. Callers must stop any
 * engines that could write these databases before selecting/starting an engine.
 */
export async function resolveOpencodeHistoryDatabase(
  legacyRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const legacyDatabase = join(legacyRoot, "opencode.db");
  let size: number;
  try {
    const info = await stat(legacyDatabase);
    if (!info.isFile()) throw new Error("The existing OpenWork chat database is not a file. Nothing was changed.");
    size = info.size;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return opencodeV1DatabasePath(env);
    throw error;
  }
  if (size === 0) return opencodeV1DatabasePath(env);

  // Opening must fail closed: unreadable/corrupt history is not an empty store.
  const db = await openReadOnlyDatabase(legacyDatabase);
  try {
    const hasTable = (name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
    for (const table of ["session_v2", "session"]) {
      if (hasTable(table) && db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) return legacyDatabase;
    }
  } finally { db.close(); }
  return opencodeV1DatabasePath(env);
}

/** Once upstream has initialized v2 tables, v1 writes would no longer be
 * reconciled into that projection. Reads and recovery files remain untouched. */
const adoptedHosts = new WeakSet<object>();

/** Close the write race between routing to v2 and its first schema write. */
export function adoptOriginalHistory(host: object): void { adoptedHosts.add(host); }

export async function originalHistoryUsesV2(host?: object): Promise<boolean> {
  if (host && adoptedHosts.has(host)) return true;
  const database = opencodeV1DatabasePath();
  try { await stat(database); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
  const db = await openReadOnlyDatabase(database);
  try { return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_v2'").get()); }
  finally { db.close(); }
}

/** The original top-level chat's folder; delegated, missing or unreadable chats have none. */
export async function v1ChatDirectory(database: string, id: string): Promise<string | null> {
  try {
    // A read-only open never creates a missing database.
    const db = await openReadOnlyDatabase(database);
    try {
      const row: unknown = db.prepare("SELECT directory, parent_id FROM session WHERE id = ?").get(id);
      return typeof row === "object" && row !== null
        && "parent_id" in row && row.parent_id === null
        && "directory" in row && typeof row.directory === "string" && isAbsolute(row.directory)
        ? row.directory : null;
    } finally { db.close(); }
  } catch {
    return null;
  }
}
