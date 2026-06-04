import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { addMcp, listMcp, removeMcp } from "./mcp.js";
import { readRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";

const WORKSPACE_ID = "ws_mcp_remote";

function serverConfig(workspaceRoot: string): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    token: "token",
    hostToken: "host-token",
    configPath: join(workspaceRoot, "server.json"),
    approval: { mode: "auto", timeoutMs: 0 },
    corsOrigins: [],
    workspaces: [{ id: WORKSPACE_ID, name: "Test", path: workspaceRoot, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [workspaceRoot],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "generated",
    hostTokenSource: "generated",
    logFormat: "pretty",
    logRequests: false,
  } satisfies ServerConfig;
}

describe("mcp remote connect flow", () => {
  test("adds, lists, and removes a remote MCP without OAuth", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "openwork-mcp-remote-e2e-"));
    const previousDb = process.env.OPENWORK_RUNTIME_DB;
    process.env.OPENWORK_RUNTIME_DB = join(workspaceRoot, "runtime.sqlite");
    const config = serverConfig(workspaceRoot);

    try {
      const added = await addMcp(config, WORKSPACE_ID, "simple-remote", {
        type: "remote",
        url: "https://example.com/mcp",
        enabled: true,
      });
      expect(added.action).toBe("added");

      const listedAfterAdd = await listMcp(config, WORKSPACE_ID, workspaceRoot);
      const item = listedAfterAdd.find((entry) => entry.name === "simple-remote");
      expect(item).toBeDefined();
      expect(item?.config).toEqual({
        type: "remote",
        url: "https://example.com/mcp",
        enabled: true,
      });
      expect(item?.source).toBe("config.remote");

      await expect(readFile(join(workspaceRoot, "opencode.jsonc"), "utf8")).rejects.toThrow();
      await expect(stat(join(workspaceRoot, ".opencode", "openwork.json"))).rejects.toThrow();
      expect((await readRuntimeOpencodeConfig(config, WORKSPACE_ID)).mcp?.["simple-remote"]?.url).toBe("https://example.com/mcp");

      const removed = await removeMcp(config, WORKSPACE_ID, "simple-remote");
      expect(removed).toBe(true);

      const listedAfterRemove = await listMcp(config, WORKSPACE_ID, workspaceRoot);
      expect(listedAfterRemove.some((entry) => entry.name === "simple-remote")).toBe(false);
    } finally {
      if (previousDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
      else process.env.OPENWORK_RUNTIME_DB = previousDb;
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
