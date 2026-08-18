import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerConfig } from "./types.js";
import { readWorkspaceEngine, writeWorkspaceEngine } from "./workspace-engine-store.js";

const WORKSPACE_ID = "ws_workspace_engine_store";
const roots: string[] = [];
const previousDefaultEngine = process.env.OPENWORK_WORKSPACE_ENGINE_DEFAULT;
const previousRuntimeDb = process.env.OPENWORK_RUNTIME_DB;

afterEach(async () => {
  while (roots.length) {
    const root = roots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
  if (previousDefaultEngine === undefined) delete process.env.OPENWORK_WORKSPACE_ENGINE_DEFAULT;
  else process.env.OPENWORK_WORKSPACE_ENGINE_DEFAULT = previousDefaultEngine;
  if (previousRuntimeDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
  else process.env.OPENWORK_RUNTIME_DB = previousRuntimeDb;
});

async function serverConfig(): Promise<ServerConfig> {
  const root = await mkdtemp(join(tmpdir(), "openwork-workspace-engine-store-"));
  roots.push(root);
  process.env.OPENWORK_RUNTIME_DB = join(root, "runtime.sqlite");
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

describe("workspace engine store", () => {
  test("defaults to opencode when the environment override is unset", async () => {
    delete process.env.OPENWORK_WORKSPACE_ENGINE_DEFAULT;
    expect(await readWorkspaceEngine(await serverConfig(), WORKSPACE_ID)).toBe("opencode");
  });

  test("defaults to flue when the environment override is flue", async () => {
    process.env.OPENWORK_WORKSPACE_ENGINE_DEFAULT = "flue";
    expect(await readWorkspaceEngine(await serverConfig(), WORKSPACE_ID)).toBe("flue");
  });

  test("defaults to opencode when the environment override is invalid", async () => {
    process.env.OPENWORK_WORKSPACE_ENGINE_DEFAULT = "bogus";
    expect(await readWorkspaceEngine(await serverConfig(), WORKSPACE_ID)).toBe("opencode");
  });

  test("keeps a stored opencode engine when the environment override is flue", async () => {
    const config = await serverConfig();
    await writeWorkspaceEngine(config, WORKSPACE_ID, "opencode");
    process.env.OPENWORK_WORKSPACE_ENGINE_DEFAULT = "flue";
    expect(await readWorkspaceEngine(config, WORKSPACE_ID)).toBe("opencode");
  });

  test("keeps a stored flue engine when the environment override is unset", async () => {
    const config = await serverConfig();
    await writeWorkspaceEngine(config, WORKSPACE_ID, "flue");
    delete process.env.OPENWORK_WORKSPACE_ENGINE_DEFAULT;
    expect(await readWorkspaceEngine(config, WORKSPACE_ID)).toBe("flue");
  });
});
