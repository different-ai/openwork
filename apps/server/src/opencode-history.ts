import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { isolatedOpencodeV1Database } from "./managed-opencode.js";
import { importNodeSqlite } from "./runtime-db.js";

export function opencodeV1DatabasePath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OPENCODE_DB === ":memory:") throw new Error("In-memory OpenCode history cannot be migrated.");
  const isolated = env === process.env ? isolatedOpencodeV1Database() : undefined;
  if (isolated) return isolated;
  if (env.OPENCODE_DB?.trim()) return resolve(env.OPENCODE_DB);
  return join(env.XDG_DATA_HOME || join(env.HOME || homedir(), ".local", "share"), "opencode", "opencode.db");
}

async function openReadOnlyDatabase(database: string) {
  return typeof process.versions.bun === "string"
    ? new (await import("bun:sqlite")).Database(database, { readonly: true })
    : new (await importNodeSqlite()).DatabaseSync(database, { readOnly: true });
}

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

  const db = await openReadOnlyDatabase(legacyDatabase);
  try {
    const hasTable = (name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
    for (const table of ["session_v2", "session"]) {
      if (hasTable(table) && db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) return legacyDatabase;
    }
  } finally { db.close(); }
  return opencodeV1DatabasePath(env);
}

const adoptedHosts = new WeakSet<object>();

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

export async function v1ChatDirectory(database: string, id: string): Promise<string | null> {
  try {
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
