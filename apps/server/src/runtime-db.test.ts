import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { installCloudPlugin, readInstalledCloudPlugins } from "./cloud-plugins.js";
import { readOpenworkWorkspaceConfig, writeOpenworkWorkspaceConfig } from "./openwork-workspace-config-store.js";
import { openRuntimeSqliteDatabase, runtimeDbPath, runtimeStorageDir } from "./runtime-db.js";
import { readRuntimeOpencodeConfig, writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import { readSessionGroupState, writeSessionGroupState } from "./session-groups.js";
import type { ServerConfig } from "./types.js";

const WORKSPACE_ID = "ws_runtime_db_primitive";

const roots: string[] = [];
const previousRuntimeDb = process.env.OPENWORK_RUNTIME_DB;

afterEach(async () => {
  while (roots.length) {
    const root = roots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
  if (previousRuntimeDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
  else process.env.OPENWORK_RUNTIME_DB = previousRuntimeDb;
});

function serverConfig(root: string, configPath: string | null = join(root, "server.json")): ServerConfig {
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: "token",
    hostToken: "host-token",
    approval: { mode: "auto", timeoutMs: 0 },
    corsOrigins: [],
    workspaces: [{ id: WORKSPACE_ID, name: "Test", path: root, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "generated",
    hostTokenSource: "generated",
    logFormat: "pretty",
    logRequests: false,
  };
  if (configPath) config.configPath = configPath;
  return config;
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "openwork-runtime-db-primitive-"));
  roots.push(root);
  return root;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rowNames(rows: unknown[]): string[] {
  return rows.flatMap((row) => (isRecord(row) && typeof row.name === "string" ? [row.name] : []));
}

function rowCount(db: Database, tableName: string): number {
  const row = db.query(`SELECT COUNT(*) AS count FROM ${tableName}`).get();
  return isRecord(row) && typeof row.count === "number" ? row.count : -1;
}

describe("runtime DB primitive", () => {
  test("resolves default and env-overridden runtime database paths", async () => {
    const root = await tempRoot();
    delete process.env.OPENWORK_RUNTIME_DB;

    const config = serverConfig(root);
    expect(runtimeDbPath(config)).toBe(join(root, "runtime.sqlite"));
    expect(runtimeStorageDir(config)).toBe(root);

    const configWithoutPath = serverConfig(root, null);
    expect(runtimeDbPath(configWithoutPath)).toBe(join(homedir(), ".config", "openwork", "runtime.sqlite"));

    const overridePath = join(root, "state", "override.sqlite");
    process.env.OPENWORK_RUNTIME_DB = ` ${overridePath} `;
    expect(runtimeDbPath(configWithoutPath)).toBe(resolve(overridePath));
    expect(runtimeStorageDir(configWithoutPath)).toBe(join(root, "state"));

    process.env.OPENWORK_RUNTIME_DB = "   ";
    expect(runtimeDbPath(config)).toBe(join(root, "runtime.sqlite"));
  });

  test("opens and closes the active runtime SQLite driver while creating the parent directory", async () => {
    const root = await tempRoot();
    const dbPath = join(root, "nested", "runtime.sqlite");
    const runtimeDb = await openRuntimeSqliteDatabase(dbPath);
    try {
      expect(runtimeDb.kind).toBe("bun");
      if (runtimeDb.kind !== "bun") throw new Error("expected Bun runtime DB driver");
      runtimeDb.sqlite.run("CREATE TABLE active_driver_check (id TEXT PRIMARY KEY NOT NULL)");
      runtimeDb.sqlite.query("INSERT INTO active_driver_check (id) VALUES (?)").run("ok");
      const row = runtimeDb.sqlite.query("SELECT id FROM active_driver_check").get();
      expect(isRecord(row) && row.id === "ok").toBe(true);
    } finally {
      runtimeDb.close();
    }

    expect((await stat(dbPath)).isFile()).toBe(true);
  });

  test("keeps each migrated store in its own runtime DB table", async () => {
    const root = await tempRoot();
    const dbPath = join(root, "runtime.sqlite");
    process.env.OPENWORK_RUNTIME_DB = dbPath;
    const config = serverConfig(root);

    await writeSessionGroupState(config, WORKSPACE_ID, {
      groups: [{ id: "grp_runtime", label: "Runtime" }],
      assignments: { ses_runtime: "grp_runtime" },
    });
    await writeOpenworkWorkspaceConfig(config, WORKSPACE_ID, (current) => ({
      ...current,
      workspace: { label: "Workspace config" },
    }));
    await writeRuntimeOpencodeConfig(config, WORKSPACE_ID, (current) => ({
      ...current,
      plugin: ["runtime-plugin"],
    }));
    await installCloudPlugin({
      serverConfig: config,
      workspaceId: WORKSPACE_ID,
      workspaceRoot: root,
      marketplaceId: "marketplace_runtime",
      marketplace: { id: "marketplace_runtime", name: "Runtime Marketplace", updatedAt: null },
      resolved: {
        plugin: { id: "plugin_runtime", name: "Runtime Primitive Plugin", description: null, updatedAt: null },
        memberships: [],
      },
    });

    expect((await readSessionGroupState(config, WORKSPACE_ID)).state).toEqual({
      groups: [{ id: "grp_runtime", label: "Runtime" }],
      assignments: { ses_runtime: "grp_runtime" },
    });
    expect((await readOpenworkWorkspaceConfig(config, WORKSPACE_ID)).workspace).toEqual({ label: "Workspace config" });
    expect((await readRuntimeOpencodeConfig(config, WORKSPACE_ID)).plugin).toEqual(["runtime-plugin"]);
    expect((await readInstalledCloudPlugins(config, WORKSPACE_ID)).plugins.plugin_runtime?.name).toBe("Runtime Primitive Plugin");

    const sqlite = new Database(dbPath, { readonly: true, create: false });
    try {
      const tables = rowNames(sqlite.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all());
      expect(tables).toEqual([
        "cloud_plugin_install_configs",
        "openwork_workspace_configs",
        "runtime_opencode_configs",
        "session_group_states",
      ]);
      for (const table of tables) expect(rowCount(sqlite, table)).toBe(1);
    } finally {
      sqlite.close();
    }
  });
});
