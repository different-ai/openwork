import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deleteLocalManagedMcp, setLocalManagedMcpEnabled } from "./local-managed-mcp.js";
import type { ServerConfig } from "./types.js";

function serverConfig(root: string): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    token: "token",
    hostToken: "host-token",
    configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 0 },
    corsOrigins: [],
    workspaces: [{ id: "ws_test", name: "Test", path: root, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "generated",
    hostTokenSource: "generated",
    logFormat: "pretty",
    logRequests: false,
  };
}

describe("local managed MCP vault", () => {
  test("returns false for non-managed connections when secure storage is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "openwork-local-managed-mcp-vault-"));
    const previousEncryptionKey = process.env.OPENWORK_ENCRYPTION_KEY;
    delete process.env.OPENWORK_ENCRYPTION_KEY;

    try {
      const config = serverConfig(root);
      await expect(deleteLocalManagedMcp(config, "ws_test", "ordinary-mcp")).resolves.toBe(false);
      await expect(setLocalManagedMcpEnabled(config, "ws_test", "ordinary-mcp", false)).resolves.toBe(false);
    } finally {
      if (previousEncryptionKey === undefined) delete process.env.OPENWORK_ENCRYPTION_KEY;
      else process.env.OPENWORK_ENCRYPTION_KEY = previousEncryptionKey;
      await rm(root, { recursive: true, force: true });
    }
  });
});
