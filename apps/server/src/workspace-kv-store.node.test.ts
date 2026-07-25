import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeSessionGroupState } from "./session-groups.js";
import type { ServerConfig } from "./types.js";
import { createWorkspaceKvStore, isRecord, workspaceKvStoreCacheStatsForTests } from "./workspace-kv-store.js";

const WORKSPACE_ID = "ws_workspace_kv_node";

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

async function sessionGroupSchemaVersion(dbPath: string): Promise<number> {
  const { DatabaseSync } = await import("node:sqlite");
  const sqlite = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = sqlite.prepare("SELECT schema_version AS schemaVersion FROM session_group_states WHERE workspace_id = ?").get(WORKSPACE_ID);
    if (!isRecord(row) || typeof row.schemaVersion !== "number") throw new Error("missing schema version");
    return row.schemaVersion;
  } finally {
    sqlite.close();
  }
}

async function setSessionGroupSchemaVersion(dbPath: string, schemaVersion: number): Promise<void> {
  const { DatabaseSync } = await import("node:sqlite");
  const sqlite = new DatabaseSync(dbPath);
  try {
    sqlite.prepare("UPDATE session_group_states SET schema_version = ? WHERE workspace_id = ?").run(schemaVersion, WORKSPACE_ID);
  } finally {
    sqlite.close();
  }
}

if (typeof process.versions.bun !== "string") {
  test("workspace kv store uses Node SQLite with one shared connection per runtime DB", async () => {
    const root = await mkdtemp(join(tmpdir(), "openwork-workspace-kv-node-"));
    const previousRuntimeDb = process.env.OPENWORK_RUNTIME_DB;
    const dbPath = join(root, "runtime.sqlite");
    process.env.OPENWORK_RUNTIME_DB = dbPath;
    try {
      const config = serverConfig(root);
      const first = recordStore("workspace_kv_node_cache_one");
      const second = recordStore("workspace_kv_node_cache_two");

      await Promise.all([
        first.set(config, WORKSPACE_ID, { first: true }),
        second.set(config, WORKSPACE_ID, { second: true }),
      ]);

      assert.deepEqual(await first.get(config, WORKSPACE_ID), { first: true });
      assert.deepEqual(await second.get(config, WORKSPACE_ID), { second: true });
      assert.deepEqual(workspaceKvStoreCacheStatsForTests(dbPath), { connectionEntries: 1, tableEntries: 2 });

      await writeSessionGroupState(config, WORKSPACE_ID, {
        groups: [{ id: "grp_node", label: "Node" }],
        assignments: {},
      });
      assert.equal(await sessionGroupSchemaVersion(dbPath), 1);

      await setSessionGroupSchemaVersion(dbPath, 9);
      await writeSessionGroupState(config, WORKSPACE_ID, {
        groups: [{ id: "grp_node_next", label: "Node Next" }],
        assignments: {},
      });
      assert.equal(await sessionGroupSchemaVersion(dbPath), 1);
    } finally {
      if (previousRuntimeDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
      else process.env.OPENWORK_RUNTIME_DB = previousRuntimeDb;
      await rm(root, { recursive: true, force: true });
    }
  });
}
