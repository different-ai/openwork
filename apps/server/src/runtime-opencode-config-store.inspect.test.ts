import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  inspectRuntimeOpencodeConfig,
  inspectRuntimeOpencodeConfigState,
  readRuntimeOpencodeConfig,
} from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";

const WORKSPACE_ID = "ws_passive_inspection";

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

async function withRuntimePath(
  run: (input: { root: string; stateDir: string; dbPath: string; config: ServerConfig }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "openwork-passive-runtime-inspection-"));
  const stateDir = join(root, "state");
  const dbPath = join(stateDir, "runtime.sqlite");
  const previousDb = process.env.OPENWORK_RUNTIME_DB;
  process.env.OPENWORK_RUNTIME_DB = dbPath;
  try {
    await run({ root, stateDir, dbPath, config: serverConfig(root) });
  } finally {
    if (previousDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
    else process.env.OPENWORK_RUNTIME_DB = previousDb;
    await rm(root, { recursive: true, force: true });
  }
}

type DirectorySnapshot = {
  directoryMtimeMs: number;
  entries: Array<{
    name: string;
    size: number;
    mtimeMs: number;
    contentHex: string;
  }>;
};

async function snapshotDirectory(directory: string): Promise<DirectorySnapshot> {
  const names = (await readdir(directory)).sort();
  const entries = await Promise.all(names.map(async (name) => {
    const path = join(directory, name);
    const metadata = await stat(path);
    return {
      name,
      size: metadata.size,
      mtimeMs: metadata.mtimeMs,
      contentHex: metadata.isFile() ? (await readFile(path)).toString("hex") : "",
    };
  }));
  return {
    directoryMtimeMs: (await stat(directory)).mtimeMs,
    entries,
  };
}

describe("passive runtime OpenCode config inspection", () => {
  test("does not create a missing runtime database or state directory", async () => {
    await withRuntimePath(async ({ stateDir, dbPath, config }) => {
      await expect(stat(stateDir)).rejects.toThrow();
      await expect(stat(dbPath)).rejects.toThrow();

      expect(await inspectRuntimeOpencodeConfig(config, WORKSPACE_ID)).toEqual({});

      await expect(stat(stateDir)).rejects.toThrow();
      await expect(stat(dbPath)).rejects.toThrow();
    });
  });

  test("reads an existing row without changing directory contents, bytes, or mtimes", async () => {
    await withRuntimePath(async ({ stateDir, dbPath, config }) => {
      await mkdir(stateDir, { recursive: true });
      const sqlite = new Database(dbPath, { create: true });
      sqlite.run("CREATE TABLE runtime_opencode_configs (workspace_id TEXT PRIMARY KEY NOT NULL, config_json TEXT NOT NULL, updated_at INTEGER NOT NULL)");
      sqlite.query("INSERT INTO runtime_opencode_configs (workspace_id, config_json, updated_at) VALUES (?, ?, ?)")
        .run(WORKSPACE_ID, JSON.stringify({ default_agent: "openwork", plugin: ["safe-plugin"] }), 1234);
      sqlite.close();
      await writeFile(join(stateDir, "sentinel.txt"), "unchanged\n", "utf8");

      const before = await snapshotDirectory(stateDir);
      expect(await inspectRuntimeOpencodeConfig(config, WORKSPACE_ID)).toEqual({
        default_agent: "openwork",
        plugin: ["safe-plugin"],
      });
      const after = await snapshotDirectory(stateDir);

      expect(after).toEqual(before);
    });
  });

  test("returns an empty snapshot for a missing table without modifying the database", async () => {
    await withRuntimePath(async ({ stateDir, dbPath, config }) => {
      await mkdir(stateDir, { recursive: true });
      const sqlite = new Database(dbPath, { create: true });
      sqlite.run("PRAGMA user_version = 7");
      sqlite.close();

      const before = await snapshotDirectory(stateDir);
      expect(await inspectRuntimeOpencodeConfig(config, WORKSPACE_ID)).toEqual({});
      const after = await snapshotDirectory(stateDir);

      expect(after).toEqual(before);
    });
  });

  test("returns an empty snapshot for corrupt SQLite bytes without rewriting them", async () => {
    await withRuntimePath(async ({ stateDir, dbPath, config }) => {
      await mkdir(stateDir, { recursive: true });
      await writeFile(dbPath, "not-a-sqlite-database\n", "utf8");
      await writeFile(join(stateDir, "sentinel.txt"), "unchanged\n", "utf8");

      const before = await snapshotDirectory(stateDir);
      expect(await inspectRuntimeOpencodeConfig(config, WORKSPACE_ID)).toEqual({});
      const after = await snapshotDirectory(stateDir);

      expect(after).toEqual(before);
    });
  });

  test("classifies malformed runtime MCP rows without exposing a partial snapshot", async () => {
    await withRuntimePath(async ({ stateDir, dbPath, config }) => {
      await mkdir(stateDir, { recursive: true });
      const sqlite = new Database(dbPath, { create: true });
      sqlite.run("CREATE TABLE runtime_opencode_configs (workspace_id TEXT PRIMARY KEY NOT NULL, config_json TEXT NOT NULL, updated_at INTEGER NOT NULL)");
      sqlite.query("INSERT INTO runtime_opencode_configs (workspace_id, config_json, updated_at) VALUES (?, ?, ?)")
        .run(WORKSPACE_ID, JSON.stringify({ mcp: { valid: { type: "remote" }, invalid: null } }), 1234);
      sqlite.close();

      expect(await inspectRuntimeOpencodeConfigState(config, WORKSPACE_ID)).toEqual({
        status: "invalid-row",
        config: {},
      });
    });
  });

  test("rejects deeply nested diagnostics rows before registration fingerprinting", async () => {
    await withRuntimePath(async ({ stateDir, dbPath, config }) => {
      await mkdir(stateDir, { recursive: true });
      const sqlite = new Database(dbPath, { create: true });
      sqlite.run("CREATE TABLE runtime_opencode_configs (workspace_id TEXT PRIMARY KEY NOT NULL, config_json TEXT NOT NULL, updated_at INTEGER NOT NULL)");
      let nested: Record<string, unknown> = { leaf: true };
      for (let depth = 0; depth < 40; depth += 1) nested = { child: nested };
      sqlite.query("INSERT INTO runtime_opencode_configs (workspace_id, config_json, updated_at) VALUES (?, ?, ?)")
        .run(WORKSPACE_ID, JSON.stringify({ mcp: { deeplyNested: { type: "remote", nested } } }), 1234);
      sqlite.close();

      expect(await inspectRuntimeOpencodeConfigState(config, WORKSPACE_ID)).toEqual({
        status: "invalid-row",
        config: {},
      });
    });
  });

  test("rejects an oversized diagnostics row before parsing without changing the ordinary runtime reader", async () => {
    await withRuntimePath(async ({ stateDir, dbPath, config }) => {
      await mkdir(stateDir, { recursive: true });
      const sqlite = new Database(dbPath, { create: true });
      sqlite.run("CREATE TABLE runtime_opencode_configs (workspace_id TEXT PRIMARY KEY NOT NULL, config_json TEXT NOT NULL, updated_at INTEGER NOT NULL)");
      sqlite.query("INSERT INTO runtime_opencode_configs (workspace_id, config_json, updated_at) VALUES (?, ?, ?)")
        .run(WORKSPACE_ID, JSON.stringify({
          default_agent: "openwork",
          padding: "x".repeat(1024 * 1024),
        }), 1234);
      sqlite.close();

      expect(await inspectRuntimeOpencodeConfigState(config, WORKSPACE_ID)).toEqual({
        status: "invalid-row",
        config: {},
      });
      expect(await inspectRuntimeOpencodeConfig(config, WORKSPACE_ID)).toEqual({});
      expect(await readRuntimeOpencodeConfig(config, WORKSPACE_ID)).toEqual({
        default_agent: "openwork",
      });
    });
  });
});
