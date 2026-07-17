import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { inspectConnectSnapshot, inspectConnectState } from "./connect-state.js";
import type { ServerConfig } from "./types.js";

function serverConfig(root: string): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    token: "owt_connect_state_inspection_client",
    hostToken: "owt_connect_state_inspection_host",
    configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 1_000 },
    corsOrigins: ["*"],
    workspaces: [],
    authorizedRoots: [],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "generated",
    hostTokenSource: "generated",
    logFormat: "pretty",
    logRequests: false,
  };
}

describe("Connect state inspection", () => {
  test("distinguishes a missing state file from bounded read failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "openwork-connect-state-inspect-"));
    const config = serverConfig(root);
    const path = join(root, "connect-state.json");
    try {
      expect(await inspectConnectState(config)).toMatchObject({
        status: "missing",
        state: { connectEnabled: false },
      });

      await writeFile(path, JSON.stringify({ connectEnabled: true, updatedAt: 123 }), "utf8");
      expect(await inspectConnectState(config)).toEqual({
        status: "available",
        state: { connectEnabled: true, updatedAt: 123 },
      });

      await writeFile(path, JSON.stringify({
        connectEnabled: true,
        padding: "x".repeat(128),
      }), "utf8");
      expect(await inspectConnectState(config, { maxBytes: 64 })).toMatchObject({
        status: "unreadable",
        state: { connectEnabled: false },
      });

      await rm(path);
      await mkdir(path);
      expect(await inspectConnectState(config)).toMatchObject({
        status: "unreadable",
        state: { connectEnabled: false },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("propagates an aborted diagnostics deadline", async () => {
    const root = await mkdtemp(join(tmpdir(), "openwork-connect-state-inspect-"));
    try {
      const controller = new AbortController();
      controller.abort(new Error("diagnostics deadline exceeded"));

      await expect(inspectConnectState(serverConfig(root), {
        signal: controller.signal,
      })).rejects.toThrow("diagnostics deadline exceeded");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails a snapshot closed when a runtime row exceeds the diagnostics byte limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "openwork-connect-snapshot-inspect-"));
    const dbPath = join(root, "runtime.sqlite");
    const previousDb = process.env.OPENWORK_RUNTIME_DB;
    process.env.OPENWORK_RUNTIME_DB = dbPath;
    try {
      const config = serverConfig(root);
      config.workspaces = [{
        id: "oversized",
        name: "Oversized",
        path: root,
        preset: "starter",
        workspaceType: "local",
      }];
      await writeFile(join(root, "connect-state.json"), JSON.stringify({
        connectEnabled: true,
        updatedAt: 123,
      }), "utf8");
      const sqlite = new Database(dbPath, { create: true });
      sqlite.run("CREATE TABLE runtime_opencode_configs (workspace_id TEXT PRIMARY KEY NOT NULL, config_json TEXT NOT NULL, updated_at INTEGER NOT NULL)");
      sqlite.query("INSERT INTO runtime_opencode_configs (workspace_id, config_json, updated_at) VALUES (?, ?, ?)")
        .run("oversized", JSON.stringify({ mcp: {}, padding: "x".repeat(128) }), 1234);
      sqlite.close();

      expect(await inspectConnectSnapshot(config, { runtimeConfigMaxBytes: 64 })).toMatchObject({
        status: "unreadable",
        snapshot: {
          connectEnabled: true,
          cloudMcpPresent: false,
        },
      });
    } finally {
      if (previousDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
      else process.env.OPENWORK_RUNTIME_DB = previousDb;
      await rm(root, { recursive: true, force: true });
    }
  });

  test("bounds the number of local runtime rows inspected", async () => {
    const root = await mkdtemp(join(tmpdir(), "openwork-connect-snapshot-inspect-"));
    const dbPath = join(root, "runtime.sqlite");
    const previousDb = process.env.OPENWORK_RUNTIME_DB;
    process.env.OPENWORK_RUNTIME_DB = dbPath;
    try {
      const config = serverConfig(root);
      config.workspaces = [
        { id: "first", name: "First", path: root, preset: "starter", workspaceType: "local" },
        { id: "second", name: "Second", path: root, preset: "starter", workspaceType: "local" },
      ];
      await writeFile(join(root, "connect-state.json"), JSON.stringify({
        connectEnabled: true,
        updatedAt: 123,
      }), "utf8");
      const sqlite = new Database(dbPath, { create: true });
      sqlite.run("CREATE TABLE runtime_opencode_configs (workspace_id TEXT PRIMARY KEY NOT NULL, config_json TEXT NOT NULL, updated_at INTEGER NOT NULL)");
      sqlite.query("INSERT INTO runtime_opencode_configs (workspace_id, config_json, updated_at) VALUES (?, ?, ?)")
        .run("first", JSON.stringify({ mcp: {} }), 1234);
      sqlite.query("INSERT INTO runtime_opencode_configs (workspace_id, config_json, updated_at) VALUES (?, ?, ?)")
        .run("second", JSON.stringify({ mcp: { "openwork-cloud": { type: "remote" } } }), 1234);
      sqlite.close();

      expect(await inspectConnectSnapshot(config, { maxRuntimeRows: 1 })).toMatchObject({
        status: "unreadable",
        snapshot: { cloudMcpPresent: false },
      });
      expect(await inspectConnectSnapshot(config, { maxRuntimeRows: 2 })).toMatchObject({
        status: "available",
        snapshot: { cloudMcpPresent: true },
      });
    } finally {
      if (previousDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
      else process.env.OPENWORK_RUNTIME_DB = previousDb;
      await rm(root, { recursive: true, force: true });
    }
  });
});
