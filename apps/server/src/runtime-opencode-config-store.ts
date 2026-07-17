import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { ServerConfig } from "./types.js";
import { ensureDir } from "./utils.js";

export type RuntimeOpencodeConfig = {
  default_agent?: string;
  plugin?: string[];
  disabled_providers?: string[];
  mcp?: Record<string, Record<string, unknown>>;
  permission?: {
    external_directory?: Record<string, unknown>;
  };
  provider?: Record<string, unknown>;
};

const runtimeOpencodeConfigs = sqliteTable("runtime_opencode_configs", {
  workspaceId: text("workspace_id").primaryKey(),
  configJson: text("config_json").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

type RuntimeOpencodeDb = {
  get: (workspaceId: string) => { configJson: string } | undefined;
  upsert: (value: { workspaceId: string; configJson: string; updatedAt: number }) => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeRuntimeOpencodeConfig(value: unknown): RuntimeOpencodeConfig {
  if (!isRecord(value)) return {};
  const defaultAgent = typeof value.default_agent === "string" ? value.default_agent : undefined;
  const plugin = Array.isArray(value.plugin) ? value.plugin.filter((item) => typeof item === "string") : undefined;
  const disabledProviders = Array.isArray(value.disabled_providers)
    ? value.disabled_providers.filter((item) => typeof item === "string")
    : undefined;
  const mcp = isRecord(value.mcp) ? value.mcp as Record<string, Record<string, unknown>> : undefined;
  const permission = isRecord(value.permission) ? value.permission : undefined;
  const externalDirectory = permission && isRecord(permission.external_directory) ? permission.external_directory : undefined;
  const provider = isRecord(value.provider) ? value.provider : undefined;
  return {
    ...(defaultAgent ? { default_agent: defaultAgent } : {}),
    ...(plugin ? { plugin } : {}),
    ...(disabledProviders ? { disabled_providers: disabledProviders } : {}),
    ...(mcp ? { mcp } : {}),
    ...(externalDirectory ? { permission: { external_directory: externalDirectory } } : {}),
    ...(provider ? { provider } : {}),
  };
}

function parseRuntimeOpencodeConfig(configJson: string): RuntimeOpencodeConfig {
  try {
    return normalizeRuntimeOpencodeConfig(JSON.parse(configJson));
  } catch {
    return {};
  }
}

export function runtimeDbPath(config: ServerConfig): string {
  const override = process.env.OPENWORK_RUNTIME_DB?.trim();
  if (override) return resolve(override);
  const configPath = config.configPath?.trim();
  const configDir = configPath ? dirname(configPath) : join(homedir(), ".config", "openwork");
  return join(configDir, "runtime.sqlite");
}

/** Directory holding runtime state (the SQLite DB and derived files). */
export function runtimeStorageDir(config: ServerConfig): string {
  return dirname(runtimeDbPath(config));
}

export type RuntimeOpencodeConfigWriteListener = (config: ServerConfig, workspaceId: string) => void;

const writeListeners = new Set<RuntimeOpencodeConfigWriteListener>();

/**
 * Observe runtime config writes. Used to keep derived state (e.g. the
 * engine-visible runtime config file) in sync with the DB. Returns an
 * unsubscribe function. Listeners must not throw.
 */
export function onRuntimeOpencodeConfigWrite(listener: RuntimeOpencodeConfigWriteListener): () => void {
  writeListeners.add(listener);
  return () => writeListeners.delete(listener);
}

async function openRuntimeDb(path: string): Promise<RuntimeOpencodeDb> {
  await ensureDir(dirname(path));
  if (typeof process.versions.bun === "string") {
    const { Database } = await import("bun:sqlite");
    const { drizzle } = await import("drizzle-orm/bun-sqlite");
    const sqlite = new Database(path, { create: true });
    sqlite.run("CREATE TABLE IF NOT EXISTS runtime_opencode_configs (workspace_id TEXT PRIMARY KEY NOT NULL, config_json TEXT NOT NULL, updated_at INTEGER NOT NULL)");
    const db = drizzle(sqlite);
    return {
      get: (workspaceId) => db
        .select()
        .from(runtimeOpencodeConfigs)
        .where(eq(runtimeOpencodeConfigs.workspaceId, workspaceId))
        .get(),
      upsert: ({ workspaceId, configJson, updatedAt }) => {
        db
          .insert(runtimeOpencodeConfigs)
          .values({ workspaceId, configJson, updatedAt })
          .onConflictDoUpdate({
            target: runtimeOpencodeConfigs.workspaceId,
            set: { configJson, updatedAt },
          })
          .run();
      },
    };
  }
  const { DatabaseSync } = await import("node:sqlite");
  const sqlite = new DatabaseSync(path);
  sqlite.exec("CREATE TABLE IF NOT EXISTS runtime_opencode_configs (workspace_id TEXT PRIMARY KEY NOT NULL, config_json TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  const get = sqlite.prepare("SELECT config_json AS configJson FROM runtime_opencode_configs WHERE workspace_id = ?");
  const upsert = sqlite.prepare("INSERT INTO runtime_opencode_configs (workspace_id, config_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(workspace_id) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at");
  return {
    get: (workspaceId) => {
      const row = get.get(workspaceId);
      if (!isRecord(row) || typeof row.configJson !== "string") return undefined;
      return { configJson: row.configJson };
    },
    upsert: ({ workspaceId, configJson, updatedAt }) => {
      upsert.run(workspaceId, configJson, updatedAt);
    },
  };
}

const dbByPath = new Map<string, Promise<RuntimeOpencodeDb>>();

async function runtimeDb(config: ServerConfig): Promise<RuntimeOpencodeDb> {
  const path = runtimeDbPath(config);
  const existing = dbByPath.get(path);
  if (existing) return existing;
  const db = openRuntimeDb(path);
  dbByPath.set(path, db);
  return db;
}

export function runtimePluginList(config: RuntimeOpencodeConfig): string[] {
  return Array.isArray(config.plugin) ? config.plugin.filter((item) => typeof item === "string") : [];
}

export function runtimeDisabledProviderList(config: RuntimeOpencodeConfig): string[] {
  return Array.isArray(config.disabled_providers)
    ? config.disabled_providers.filter((item) => typeof item === "string")
    : [];
}

export function runtimeMcpMap(config: RuntimeOpencodeConfig): Record<string, Record<string, unknown>> {
  return isRecord(config.mcp) ? config.mcp as Record<string, Record<string, unknown>> : {};
}

export function runtimeExternalDirectory(config: RuntimeOpencodeConfig): Record<string, unknown> {
  const permission = isRecord(config.permission) ? config.permission : null;
  const externalDirectory = permission && isRecord(permission.external_directory) ? permission.external_directory : null;
  return externalDirectory ?? {};
}

/**
 * Per-provider merge for runtime config patches: record values upsert the
 * provider, explicit `null` deletes it (so clients can remove runtime-managed
 * providers, e.g. cloud imports, without racing a read-modify-write of the
 * whole map). Returns undefined when the resulting map is empty.
 */
export function mergeRuntimeProviderUpdate(
  current: unknown,
  update: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const next: Record<string, unknown> = { ...(isRecord(current) ? current : {}) };
  for (const [providerId, value] of Object.entries(update)) {
    if (value === null) {
      delete next[providerId];
    } else if (isRecord(value)) {
      next[providerId] = value;
    }
  }
  return Object.keys(next).length ? next : undefined;
}

export async function readRuntimeOpencodeConfig(config: ServerConfig, workspaceId: string): Promise<RuntimeOpencodeConfig> {
  const db = await runtimeDb(config);
  const row = db.get(workspaceId);
  if (!row) return {};
  return parseRuntimeOpencodeConfig(row.configJson);
}

export type RuntimeOpencodeConfigInspection = {
  status: "available" | "database-missing" | "row-missing" | "table-missing" | "unreadable" | "invalid-row" | "remote-workspace";
  config: RuntimeOpencodeConfig;
};

export type RuntimeOpencodeConfigInspectionOptions = {
  maxBytes?: number;
  signal?: AbortSignal;
};

const RUNTIME_OPENCODE_CONFIG_INSPECTION_MAX_BYTES = 1024 * 1024;
const RUNTIME_OPENCODE_CONFIG_INSPECTION_MAX_DEPTH = 32;
const RUNTIME_OPENCODE_CONFIG_INSPECTION_MAX_NODES = 20_000;

function inspectionMaxBytes(value: number | undefined): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : RUNTIME_OPENCODE_CONFIG_INSPECTION_MAX_BYTES;
}

function hasBoundedRuntimeConfigStructure(value: unknown): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const visited = new Set<object>();
  let nodes = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    nodes += 1;
    if (nodes > RUNTIME_OPENCODE_CONFIG_INSPECTION_MAX_NODES) return false;
    if (current.depth > RUNTIME_OPENCODE_CONFIG_INSPECTION_MAX_DEPTH) return false;
    if (typeof current.value !== "object" || current.value === null) continue;
    if (visited.has(current.value)) return false;
    visited.add(current.value);

    const children = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value);
    for (const child of children) {
      stack.push({ value: child, depth: current.depth + 1 });
    }
  }
  return true;
}

function inspectRuntimeConfigRow(
  row: unknown,
  maxBytes: number,
): RuntimeOpencodeConfigInspection {
  if (!isRecord(row)) return { status: "row-missing", config: {} };
  if (
    typeof row.configBytes !== "number"
    || !Number.isSafeInteger(row.configBytes)
    || row.configBytes < 0
  ) {
    return { status: "invalid-row", config: {} };
  }
  if (row.configBytes > maxBytes || typeof row.configJson !== "string") {
    return { status: "invalid-row", config: {} };
  }

  try {
    const parsed = JSON.parse(row.configJson) as unknown;
    if (!isRecord(parsed)) return { status: "invalid-row", config: {} };
    if (!hasBoundedRuntimeConfigStructure(parsed)) {
      return { status: "invalid-row", config: {} };
    }
    if (Object.hasOwn(parsed, "mcp")) {
      if (!isRecord(parsed.mcp) || Object.values(parsed.mcp).some((entry) => !isRecord(entry))) {
        return { status: "invalid-row", config: {} };
      }
    }
    return { status: "available", config: normalizeRuntimeOpencodeConfig(parsed) };
  } catch {
    return { status: "invalid-row", config: {} };
  }
}

function classifyReadonlySqliteFailure(error: unknown): "table-missing" | "unreadable" {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return message.includes("no such table") ? "table-missing" : "unreadable";
}

/**
 * Inspect one runtime config row without creating the state directory, SQLite
 * file, or schema. Diagnostics use this path so a read on a fresh install is
 * genuinely side-effect free.
 */
export async function inspectRuntimeOpencodeConfigState(
  config: ServerConfig,
  workspaceId: string,
  options?: RuntimeOpencodeConfigInspectionOptions,
): Promise<RuntimeOpencodeConfigInspection> {
  options?.signal?.throwIfAborted();
  const path = runtimeDbPath(config);
  if (!existsSync(path)) return { status: "database-missing", config: {} };
  const maxBytes = inspectionMaxBytes(options?.maxBytes);

  if (typeof process.versions.bun === "string") {
    const { Database } = await import("bun:sqlite");
    options?.signal?.throwIfAborted();
    try {
      const sqlite = new Database(path, { readonly: true, create: false });
      try {
        const row = sqlite.query(`
          SELECT
            length(CAST(config_json AS BLOB)) AS configBytes,
            CASE
              WHEN length(CAST(config_json AS BLOB)) <= ? THEN config_json
              ELSE NULL
            END AS configJson
          FROM runtime_opencode_configs
          WHERE workspace_id = ?
        `).get(maxBytes, workspaceId);
        options?.signal?.throwIfAborted();
        return inspectRuntimeConfigRow(row, maxBytes);
      } finally {
        sqlite.close();
      }
    } catch (error) {
      options?.signal?.throwIfAborted();
      return { status: classifyReadonlySqliteFailure(error), config: {} };
    }
  }

  const { DatabaseSync } = await import("node:sqlite");
  options?.signal?.throwIfAborted();
  try {
    const sqlite = new DatabaseSync(path, { readOnly: true });
    try {
      const row = sqlite.prepare(`
          SELECT
            length(CAST(config_json AS BLOB)) AS configBytes,
            CASE
              WHEN length(CAST(config_json AS BLOB)) <= ? THEN config_json
              ELSE NULL
            END AS configJson
          FROM runtime_opencode_configs
          WHERE workspace_id = ?
      `).get(maxBytes, workspaceId);
      options?.signal?.throwIfAborted();
      return inspectRuntimeConfigRow(row, maxBytes);
    } finally {
      sqlite.close();
    }
  } catch (error) {
    options?.signal?.throwIfAborted();
    return { status: classifyReadonlySqliteFailure(error), config: {} };
  }
}

export async function inspectRuntimeOpencodeConfig(
  config: ServerConfig,
  workspaceId: string,
  options?: RuntimeOpencodeConfigInspectionOptions,
): Promise<RuntimeOpencodeConfig> {
  return (await inspectRuntimeOpencodeConfigState(config, workspaceId, options)).config;
}

export async function writeRuntimeOpencodeConfig(
  config: ServerConfig,
  workspaceId: string,
  updater: (current: RuntimeOpencodeConfig) => RuntimeOpencodeConfig,
): Promise<{ config: RuntimeOpencodeConfig; changed: boolean }> {
  const db = await runtimeDb(config);
  const row = db.get(workspaceId);
  const current = row ? parseRuntimeOpencodeConfig(row.configJson) : {};
  const next = normalizeRuntimeOpencodeConfig(updater(current));
  const now = Date.now();
  const configJson = JSON.stringify(next);
  if (row?.configJson === configJson) {
    return { config: next, changed: false };
  }
  db.upsert({ workspaceId, configJson, updatedAt: now });
  for (const listener of writeListeners) listener(config, workspaceId);
  return { config: next, changed: true };
}

export function mergeOpencodeConfigs(
  persisted: Record<string, unknown>,
  runtime: RuntimeOpencodeConfig,
): Record<string, unknown> {
  const persistedPermission = isRecord(persisted.permission) ? persisted.permission : {};
  const persistedExternalDirectory = isRecord(persistedPermission.external_directory)
    ? persistedPermission.external_directory
    : {};
  return {
    ...persisted,
    plugin: [
      ...(Array.isArray(persisted.plugin) ? persisted.plugin.filter((item) => typeof item === "string") : []),
      ...runtimePluginList(runtime),
    ],
    disabled_providers: [
      ...(Array.isArray(persisted.disabled_providers) ? persisted.disabled_providers.filter((item) => typeof item === "string") : []),
      ...runtimeDisabledProviderList(runtime),
    ].filter((item, index, list) => list.indexOf(item) === index),
    mcp: {
      ...(isRecord(persisted.mcp) ? persisted.mcp : {}),
      ...runtimeMcpMap(runtime),
    },
    permission: {
      ...persistedPermission,
      external_directory: {
        ...persistedExternalDirectory,
        ...runtimeExternalDirectory(runtime),
      },
    },
    ...(runtime.provider ? { provider: { ...(isRecord(persisted.provider) ? persisted.provider : {}), ...runtime.provider } } : {}),
    ...(runtime.default_agent ? { default_agent: runtime.default_agent } : {}),
  };
}
