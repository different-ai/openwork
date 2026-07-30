import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installCloudPlugin, readInstalledCloudPlugins } from "./cloud-plugins.js";
import { readOpenworkWorkspaceConfig, writeOpenworkWorkspaceConfig } from "./openwork-workspace-config-store.js";
import { readRuntimeOpencodeConfig, writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import { readSessionGroupState, writeSessionGroupState } from "./session-groups.js";
import type { ServerConfig } from "./types.js";
import { createWorkspaceKvStore, isRecord, workspaceKvStoreCacheStatsForTests } from "./workspace-kv-store.js";

const WORKSPACE_ID = "ws_workspace_kv_store";
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

function serverConfig(root: string): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    token: "token",
    hostToken: "host-token",
    configPath: join(root, "server.json"),
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
}

async function tempWorkspace(): Promise<{ root: string; dbPath: string; config: ServerConfig }> {
  const root = await mkdtemp(join(tmpdir(), "openwork-workspace-kv-store-"));
  roots.push(root);
  const dbPath = join(root, "runtime.sqlite");
  process.env.OPENWORK_RUNTIME_DB = dbPath;
  return { root, dbPath, config: serverConfig(root) };
}

function parseRecordJson(json: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(json);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function recordStore(tableName: string) {
  return createWorkspaceKvStore<Record<string, unknown>>({
    tableName,
    valueColumn: "config_json",
    parse: parseRecordJson,
    serialize: (value) => JSON.stringify(value),
  });
}

function corruptStoreJson(dbPath: string): void {
  const sqlite = new Database(dbPath);
  try {
    sqlite.query("UPDATE runtime_opencode_configs SET config_json = ? WHERE workspace_id = ?").run("{", WORKSPACE_ID);
    sqlite.query("UPDATE openwork_workspace_configs SET config_json = ? WHERE workspace_id = ?").run("{", WORKSPACE_ID);
    sqlite.query("UPDATE cloud_plugin_install_configs SET config_json = ? WHERE workspace_id = ?").run("{", WORKSPACE_ID);
    sqlite.query("UPDATE session_group_states SET state_json = ? WHERE workspace_id = ?").run("{", WORKSPACE_ID);
  } finally {
    sqlite.close();
  }
}

function setSessionGroupSchemaVersion(dbPath: string, schemaVersion: number): void {
  const sqlite = new Database(dbPath);
  try {
    sqlite.query("UPDATE session_group_states SET schema_version = ? WHERE workspace_id = ?").run(schemaVersion, WORKSPACE_ID);
  } finally {
    sqlite.close();
  }
}

function sessionGroupSchemaVersion(dbPath: string): number {
  const sqlite = new Database(dbPath, { readonly: true, create: false });
  try {
    const row = sqlite.query("SELECT schema_version AS schemaVersion FROM session_group_states WHERE workspace_id = ?").get(WORKSPACE_ID);
    if (!isRecord(row) || typeof row.schemaVersion !== "number") throw new Error("missing schema version");
    return row.schemaVersion;
  } finally {
    sqlite.close();
  }
}

describe("workspace kv store", () => {
  test("creates, reads, updates, and parses malformed JSON", async () => {
    const { config, dbPath } = await tempWorkspace();
    const store = recordStore("workspace_kv_factory_round_trip");

    expect(await store.get(config, "missing")).toBeUndefined();

    await store.set(config, WORKSPACE_ID, { enabled: true });
    expect(await store.get(config, WORKSPACE_ID)).toEqual({ enabled: true });

    await store.set(config, WORKSPACE_ID, { enabled: false, count: 2 });
    expect(await store.get(config, WORKSPACE_ID)).toEqual({ enabled: false, count: 2 });

    const sqlite = new Database(dbPath);
    try {
      sqlite.query("UPDATE workspace_kv_factory_round_trip SET config_json = ? WHERE workspace_id = ?").run("{", WORKSPACE_ID);
    } finally {
      sqlite.close();
    }
    expect(await store.get(config, WORKSPACE_ID)).toEqual({});
  });

  test("returns each migrated store's documented defaults for missing and malformed rows", async () => {
    const { root, config, dbPath } = await tempWorkspace();

    expect(await readRuntimeOpencodeConfig(config, WORKSPACE_ID)).toEqual({});
    expect(await readOpenworkWorkspaceConfig(config, WORKSPACE_ID)).toEqual({});
    expect(await readInstalledCloudPlugins(config, WORKSPACE_ID)).toEqual({ skills: {}, providers: {}, marketplaces: {}, plugins: {} });
    expect(await readSessionGroupState(config, WORKSPACE_ID)).toEqual({ state: { groups: [], assignments: {} }, updatedAt: null });

    await writeRuntimeOpencodeConfig(config, WORKSPACE_ID, () => ({ plugin: ["runtime-plugin"] }));
    await writeOpenworkWorkspaceConfig(config, WORKSPACE_ID, () => ({ workspace: { name: "Runtime" } }));
    await installCloudPlugin({
      serverConfig: config,
      workspaceId: WORKSPACE_ID,
      workspaceRoot: root,
      marketplaceId: null,
      resolved: {
        plugin: { id: "plugin_kv", name: "KV Plugin", description: null, updatedAt: null },
        memberships: [],
      },
    });
    const session = await writeSessionGroupState(config, WORKSPACE_ID, {
      groups: [{ id: "grp_kv", label: "KV" }],
      assignments: { ses_kv: "grp_kv" },
    });

    corruptStoreJson(dbPath);

    expect(await readRuntimeOpencodeConfig(config, WORKSPACE_ID)).toEqual({});
    expect(await readOpenworkWorkspaceConfig(config, WORKSPACE_ID)).toEqual({});
    expect(await readInstalledCloudPlugins(config, WORKSPACE_ID)).toEqual({ skills: {}, providers: {}, marketplaces: {}, plugins: {} });
    expect(await readSessionGroupState(config, WORKSPACE_ID)).toEqual({ state: { groups: [], assignments: {} }, updatedAt: session.updatedAt });
  });

  test("keeps session group schema_version at 1 on insert and update", async () => {
    const { config, dbPath } = await tempWorkspace();

    await writeSessionGroupState(config, WORKSPACE_ID, {
      groups: [{ id: "grp_one", label: "One" }],
      assignments: {},
    });
    expect(sessionGroupSchemaVersion(dbPath)).toBe(1);

    setSessionGroupSchemaVersion(dbPath, 7);
    await writeSessionGroupState(config, WORKSPACE_ID, {
      groups: [{ id: "grp_two", label: "Two" }],
      assignments: {},
    });
    expect(sessionGroupSchemaVersion(dbPath)).toBe(1);
  });

  test("shares one underlying runtime DB connection across stores for the same file", async () => {
    const { config, dbPath } = await tempWorkspace();
    const first = recordStore("workspace_kv_cache_one");
    const second = recordStore("workspace_kv_cache_two");

    expect(workspaceKvStoreCacheStatsForTests(dbPath)).toEqual({ connectionEntries: 0, tableEntries: 0 });

    await Promise.all([
      first.set(config, WORKSPACE_ID, { first: true }),
      second.set(config, WORKSPACE_ID, { second: true }),
    ]);

    expect(workspaceKvStoreCacheStatsForTests(dbPath)).toEqual({ connectionEntries: 1, tableEntries: 2 });
  });
});
