import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

const WORKSPACE_ID = "ws_config_engine_test";

type Served = {
  port: number;
  stop: (closeActiveConnections?: boolean) => void | Promise<void>;
};

test("workspace config exposes the exact engine config without changing the editable surface", async () => {
  const root = await mkdtemp(join(tmpdir(), "openwork-config-engine-"));
  const previousDb = process.env.OPENWORK_RUNTIME_DB;
  process.env.OPENWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  const config: ServerConfig = {
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

  let server: Served | undefined;
  try {
    await writeFile(join(root, "opencode.jsonc"), JSON.stringify({
      compaction: { auto: false },
      plugin: ["project-plugin"],
    }));
    await writeRuntimeOpencodeConfig(config, WORKSPACE_ID, (current) => ({
      ...current,
      plugin: ["runtime-plugin"],
      mcp: { demo: { type: "remote", url: "https://example.test/mcp", enabled: true } },
    }));

    server = await startServer(config) as Served;
    const response = await fetch(`http://127.0.0.1:${server.port}/workspace/${WORKSPACE_ID}/config`, {
      headers: { authorization: `Bearer ${config.token}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const payload = await response.json() as {
      opencode: Record<string, unknown>;
      engine: {
        default_agent?: string;
        agent?: Record<string, unknown>;
        plugin?: string[];
        mcp?: Record<string, unknown>;
      };
    };

    expect(payload.opencode).toMatchObject({
      compaction: { auto: false },
      plugin: ["project-plugin", "runtime-plugin"],
    });
    expect(payload.opencode).not.toHaveProperty("default_agent");
    expect(payload.opencode).not.toHaveProperty("agent");
    expect(payload.engine.default_agent).toBe("openwork");
    expect(payload.engine.agent).toHaveProperty("openwork");
    expect(payload.engine.plugin?.[0]).toBe("opencode-chrome-devtools");
    expect(payload.engine.plugin).toContain("runtime-plugin");
    expect(payload.engine.plugin?.at(-1)).toMatch(/openwork-prompt-log\.(?:ts|js)$/);
    expect(payload.engine.mcp).toHaveProperty("demo");

    const readOnlyResponse = await fetch(`http://127.0.0.1:${server.port}/workspace/${WORKSPACE_ID}/config`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${config.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ engine: { plugin: ["untrusted"] } }),
    });
    expect(readOnlyResponse.status).toBe(400);
  } finally {
    await server?.stop(true);
    if (previousDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
    else process.env.OPENWORK_RUNTIME_DB = previousDb;
    await rm(root, { recursive: true, force: true });
  }
});
