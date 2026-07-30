import { eq } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { openRuntimeSqliteDatabase, runtimeDbPath, type RuntimeSqliteDatabase } from "./runtime-db.js";
import type { ServerConfig } from "./types.js";

type WorkspaceKvSchemaVersionColumn = {
  name: string;
  definition: string;
  value: number;
};

type WorkspaceKvExtraColumns = {
  schemaVersion?: WorkspaceKvSchemaVersionColumn;
};

type WorkspaceKvStoreOptions<T> = {
  tableName: string;
  valueColumn: string;
  extraColumns?: WorkspaceKvExtraColumns;
  parse: (json: string) => T;
  serialize: (value: T) => string;
};

type WorkspaceKvTableConfig = {
  tableName: string;
  valueColumn: string;
  createTableSql: string;
  selectSql: string;
  upsertSql: string;
  schemaVersion?: WorkspaceKvSchemaVersionColumn;
};

type WorkspaceKvStoredRow = {
  valueJson: string;
  updatedAt: number | null;
};

type WorkspaceKvRow<T> = WorkspaceKvStoredRow & {
  value: T;
};

type WorkspaceKvDb = {
  get: (workspaceId: string) => WorkspaceKvStoredRow | undefined;
  upsert: (value: { workspaceId: string; valueJson: string; updatedAt: number }) => void;
};

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const dbByPath = new Map<string, Promise<RuntimeSqliteDatabase>>();
const tableDbByPath = new Map<string, Map<string, Promise<WorkspaceKvDb>>>();

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validIdentifier(value: string, label: string): string {
  if (!IDENTIFIER_RE.test(value)) throw new Error(`Invalid ${label}: ${value}`);
  return value;
}

function validSchemaVersion(column: WorkspaceKvSchemaVersionColumn | undefined): WorkspaceKvSchemaVersionColumn | undefined {
  if (!column) return undefined;
  validIdentifier(column.name, "extra column");
  return column;
}

function createTableSql(config: {
  tableName: string;
  valueColumn: string;
  schemaVersion?: WorkspaceKvSchemaVersionColumn;
}): string {
  const columns = [
    "workspace_id TEXT PRIMARY KEY NOT NULL",
    `${config.valueColumn} TEXT NOT NULL`,
    ...(config.schemaVersion ? [`${config.schemaVersion.name} ${config.schemaVersion.definition}`] : []),
    "updated_at INTEGER NOT NULL",
  ];
  return `CREATE TABLE IF NOT EXISTS ${config.tableName} (${columns.join(", ")})`;
}

function upsertSql(config: {
  tableName: string;
  valueColumn: string;
  schemaVersion?: WorkspaceKvSchemaVersionColumn;
}): string {
  const insertColumns = ["workspace_id", config.valueColumn, ...(config.schemaVersion ? [config.schemaVersion.name] : []), "updated_at"];
  const insertValues = ["?", "?", ...(config.schemaVersion ? [String(config.schemaVersion.value)] : []), "?"];
  const updateColumns = [config.valueColumn, ...(config.schemaVersion ? [config.schemaVersion.name] : []), "updated_at"];
  const updates = updateColumns.map((column) => `${column} = excluded.${column}`);
  return `INSERT INTO ${config.tableName} (${insertColumns.join(", ")}) VALUES (${insertValues.join(", ")}) ON CONFLICT(workspace_id) DO UPDATE SET ${updates.join(", ")}`;
}

function tableConfig<T>(options: WorkspaceKvStoreOptions<T>): WorkspaceKvTableConfig {
  const tableName = validIdentifier(options.tableName, "table name");
  const valueColumn = validIdentifier(options.valueColumn, "value column");
  const schemaVersion = validSchemaVersion(options.extraColumns?.schemaVersion);
  return {
    tableName,
    valueColumn,
    createTableSql: createTableSql({ tableName, valueColumn, schemaVersion }),
    selectSql: `SELECT ${valueColumn} AS valueJson, updated_at AS updatedAt FROM ${tableName} WHERE workspace_id = ?`,
    upsertSql: upsertSql({ tableName, valueColumn, schemaVersion }),
    ...(schemaVersion ? { schemaVersion } : {}),
  };
}

function rowFromUnknown(row: unknown): WorkspaceKvStoredRow | undefined {
  if (!isRecord(row) || typeof row.valueJson !== "string") return undefined;
  return {
    valueJson: row.valueJson,
    updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : null,
  };
}

async function runtimeDb(path: string): Promise<RuntimeSqliteDatabase> {
  const existing = dbByPath.get(path);
  if (existing) return existing;
  const db = openRuntimeSqliteDatabase(path);
  dbByPath.set(path, db);
  return db;
}

async function openTableDb(path: string, config: WorkspaceKvTableConfig): Promise<WorkspaceKvDb> {
  const runtime = await runtimeDb(path);
  if (runtime.kind === "bun") {
    runtime.sqlite.run(config.createTableSql);
    const db = runtime.db;
    const schemaVersion = config.schemaVersion;
    if (schemaVersion) {
      const table = sqliteTable(config.tableName, {
        workspaceId: text("workspace_id").primaryKey(),
        valueJson: text(config.valueColumn).notNull(),
        schemaVersion: integer(schemaVersion.name).notNull().default(schemaVersion.value),
        updatedAt: integer("updated_at").notNull(),
      });
      return {
        get: (workspaceId) => db
          .select({ valueJson: table.valueJson, updatedAt: table.updatedAt })
          .from(table)
          .where(eq(table.workspaceId, workspaceId))
          .get(),
        upsert: ({ workspaceId, valueJson, updatedAt }) => {
          db
            .insert(table)
            .values({ workspaceId, valueJson, schemaVersion: schemaVersion.value, updatedAt })
            .onConflictDoUpdate({
              target: table.workspaceId,
              set: { valueJson, schemaVersion: schemaVersion.value, updatedAt },
            })
            .run();
        },
      };
    }
    const table = sqliteTable(config.tableName, {
      workspaceId: text("workspace_id").primaryKey(),
      valueJson: text(config.valueColumn).notNull(),
      updatedAt: integer("updated_at").notNull(),
    });
    return {
      get: (workspaceId) => db
        .select({ valueJson: table.valueJson, updatedAt: table.updatedAt })
        .from(table)
        .where(eq(table.workspaceId, workspaceId))
        .get(),
      upsert: ({ workspaceId, valueJson, updatedAt }) => {
        db
          .insert(table)
          .values({ workspaceId, valueJson, updatedAt })
          .onConflictDoUpdate({
            target: table.workspaceId,
            set: { valueJson, updatedAt },
          })
          .run();
      },
    };
  }

  const sqlite = runtime.sqlite;
  sqlite.exec(config.createTableSql);
  const get = sqlite.prepare(config.selectSql);
  const upsert = sqlite.prepare(config.upsertSql);
  return {
    get: (workspaceId) => rowFromUnknown(get.get(workspaceId)),
    upsert: ({ workspaceId, valueJson, updatedAt }) => {
      upsert.run(workspaceId, valueJson, updatedAt);
    },
  };
}

async function workspaceKvDb(path: string, config: WorkspaceKvTableConfig): Promise<WorkspaceKvDb> {
  let tableDbs = tableDbByPath.get(path);
  if (!tableDbs) {
    tableDbs = new Map<string, Promise<WorkspaceKvDb>>();
    tableDbByPath.set(path, tableDbs);
  }
  const existing = tableDbs.get(config.tableName);
  if (existing) return existing;
  const db = openTableDb(path, config);
  tableDbs.set(config.tableName, db);
  return db;
}

export function createWorkspaceKvStore<T>(options: WorkspaceKvStoreOptions<T>) {
  const config = tableConfig(options);

  async function getRow(serverConfig: ServerConfig, workspaceId: string): Promise<WorkspaceKvRow<T> | undefined> {
    const db = await workspaceKvDb(runtimeDbPath(serverConfig), config);
    const row = db.get(workspaceId);
    return row ? { ...row, value: options.parse(row.valueJson) } : undefined;
  }

  async function setSerialized(
    serverConfig: ServerConfig,
    workspaceId: string,
    valueJson: string,
    updatedAt: number,
  ): Promise<void> {
    const db = await workspaceKvDb(runtimeDbPath(serverConfig), config);
    db.upsert({ workspaceId, valueJson, updatedAt });
  }

  return {
    serialize: options.serialize,
    getRow,
    get: async (serverConfig: ServerConfig, workspaceId: string): Promise<T | undefined> => {
      return (await getRow(serverConfig, workspaceId))?.value;
    },
    has: async (serverConfig: ServerConfig, workspaceId: string): Promise<boolean> => {
      const db = await workspaceKvDb(runtimeDbPath(serverConfig), config);
      return Boolean(db.get(workspaceId));
    },
    set: async (serverConfig: ServerConfig, workspaceId: string, value: T, updatedAt = Date.now()): Promise<void> => {
      await setSerialized(serverConfig, workspaceId, options.serialize(value), updatedAt);
    },
    setSerialized,
  };
}

export function workspaceKvStoreCacheStatsForTests(path: string): { connectionEntries: number; tableEntries: number } {
  return {
    connectionEntries: dbByPath.has(path) ? 1 : 0,
    tableEntries: tableDbByPath.get(path)?.size ?? 0,
  };
}
