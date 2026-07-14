import { createRequire } from "node:module";

export type ConnectSqliteRunResult = { changes: number };
export type ConnectSqliteBinding = string | number | bigint | null | Uint8Array;

export type ConnectSqliteStatement = {
  get: (...parameters: ConnectSqliteBinding[]) => unknown;
  all: (...parameters: ConnectSqliteBinding[]) => unknown[];
  run: (...parameters: ConnectSqliteBinding[]) => ConnectSqliteRunResult;
};

export type ConnectSqliteDatabase = {
  exec: (sql: string) => void;
  prepare: (sql: string) => ConnectSqliteStatement;
  immediate: <T>(operation: () => T) => T;
};

/**
 * The standalone server runs on Bun while Electron embeds it in Node. Keep the
 * store above both native SQLite APIs so Connect state and migrations are
 * identical in either package shape.
 */
export function openConnectSqlite(path: string): ConnectSqliteDatabase {
  if (typeof process.versions.bun === "string") {
    const require = createRequire(import.meta.url);
    const module = require("bun:sqlite") as typeof import("bun:sqlite");
    const database = new module.Database(path, { create: true });
    return {
      exec: (sql) => { database.exec(sql); },
      prepare: (sql) => {
        const statement = database.query(sql);
        return {
          get: (...parameters) => statement.get(...parameters),
          all: (...parameters) => statement.all(...parameters),
          run: (...parameters) => statement.run(...parameters),
        };
      },
      immediate: (operation) => database.transaction(operation).immediate(),
    };
  }

  const require = createRequire(import.meta.url);
  const module = require("node:sqlite") as typeof import("node:sqlite");
  const database = new module.DatabaseSync(path);
  return {
    exec: (sql) => { database.exec(sql); },
    prepare: (sql) => {
      const statement = database.prepare(sql);
      return {
        get: (...parameters) => statement.get(...parameters),
        all: (...parameters) => statement.all(...parameters),
        run: (...parameters) => {
          const result = statement.run(...parameters);
          return { changes: Number(result.changes) };
        },
      };
    },
    immediate: (operation) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        const result = operation();
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
