import { dirname, join, resolve } from "node:path";
import { openworkConfigDir } from "@openwork/paths";
import type { Database as BunDatabase } from "bun:sqlite";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import type { DatabaseSync } from "node:sqlite";
import type { ServerConfig } from "./types.js";
import { ensureDir } from "./utils.js";

export type RuntimeBunSqliteDatabase = {
  kind: "bun";
  sqlite: BunDatabase;
  db: BunSQLiteDatabase;
  close: () => void;
};

export type RuntimeNodeSqliteDatabase = {
  kind: "node";
  sqlite: DatabaseSync;
  close: () => void;
};

export type RuntimeSqliteDatabase = RuntimeBunSqliteDatabase | RuntimeNodeSqliteDatabase;

export const NODE_SQLITE_SPECIFIER = "node:sqlite";

export function importNodeSqlite(): Promise<typeof import("node:sqlite")> {
  return import(NODE_SQLITE_SPECIFIER);
}

export const RUNTIME_SQLITE_BUSY_TIMEOUT_MS = 5000;

type SqlExecutor = { exec: (sql: string) => unknown };

export function configureRuntimeSqliteReader(sqlite: SqlExecutor): void {
  sqlite.exec(`PRAGMA busy_timeout = ${RUNTIME_SQLITE_BUSY_TIMEOUT_MS}`);
}

export function configureRuntimeSqliteConnection(sqlite: SqlExecutor, path: string): void {
  configureRuntimeSqliteReader(sqlite);
  try {
    sqlite.exec("PRAGMA journal_mode = WAL");
  } catch (error) {
    console.warn(
      `[runtime-db] could not enable WAL for ${path}; continuing with busy timeout only: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function runtimeDbPath(config: Pick<ServerConfig, "configPath">): string {
  const override = process.env.OPENWORK_RUNTIME_DB?.trim();
  if (override) return resolve(override);
  const configPath = config.configPath?.trim();
  const configDir = configPath ? dirname(configPath) : openworkConfigDir();
  return join(configDir, "runtime.sqlite");
}

export function runtimeStorageDir(config: Pick<ServerConfig, "configPath">): string {
  return dirname(runtimeDbPath(config));
}

export async function openRuntimeSqliteDatabase(path: string): Promise<RuntimeSqliteDatabase> {
  await ensureDir(dirname(path));
  if (typeof process.versions.bun === "string") {
    const { Database } = await import("bun:sqlite");
    const { drizzle } = await import("drizzle-orm/bun-sqlite");
    const sqlite = new Database(path, { create: true });
    configureRuntimeSqliteConnection(sqlite, path);
    return {
      kind: "bun",
      sqlite,
      db: drizzle(sqlite),
      close: () => sqlite.close(),
    };
  }

  const { DatabaseSync } = await importNodeSqlite();
  const sqlite = new DatabaseSync(path);
  configureRuntimeSqliteConnection(sqlite, path);
  return {
    kind: "node",
    sqlite,
    close: () => sqlite.close(),
  };
}
