import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventually, test } from "@openwork/testkit";
import { expect } from "vitest";

import { resetManagedProviderAuthCache } from "../../apps/server/src/managed-provider-auth.js";
import { openworkRuntimeConfigFilePath } from "../../apps/server/src/openwork-runtime-config.js";
import { startServer } from "../../apps/server/src/server.js";
import type { ServerConfig } from "../../apps/server/src/types.js";

const CLIENT_TOKEN = "owt_managed_provider_env_client";
const HOST_TOKEN = "owt_managed_provider_env_host";

function hostHeaders() {
  return { "x-openwork-host-token": HOST_TOKEN, "content-type": "application/json" };
}

function managedProviderChanges(requests: string[]): string[] {
  return requests.filter((entry) => entry.startsWith("PUT /auth/") || entry === "POST /instance/dispose");
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function handleEngineRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: ServerConfig,
  requests: string[],
): Promise<void> {
  const method = request.method ?? "GET";
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  requests.push(`${method} ${path}`);
  if (method === "GET" && path === "/config") {
    const content = await readFile(openworkRuntimeConfigFilePath(config), "utf8");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(content);
    return;
  }
  if (method === "POST" && path === "/instance/dispose") {
    sendJson(response, 200, { ok: true });
    return;
  }
  if ((method === "PUT" || method === "DELETE") && path.startsWith("/auth/")) {
    sendJson(response, 200, true);
    return;
  }
  sendJson(response, 404, { error: "not_found" });
}

async function startFakeEngine(config: ServerConfig, requests: string[]) {
  const engine = createServer((request, response) => {
    void handleEngineRequest(request, response, config, requests).catch((error) => {
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });
  await new Promise<void>((resolve, reject) => {
    engine.once("error", reject);
    engine.listen(0, "127.0.0.1", resolve);
  });
  const address = engine.address();
  if (!address || typeof address === "string") throw new Error("Fake engine did not bind a TCP port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    stop: () => new Promise<void>((resolve, reject) => {
      engine.close((error) => error ? reject(error) : resolve());
      engine.closeAllConnections();
    }),
  };
}

test("stored managed provider credentials reload the engine after auth delivery", async () => {
  const root = await mkdtemp(join(tmpdir(), "openwork-provider-env-reload-"));
  const previousRuntimeDb = process.env.OPENWORK_RUNTIME_DB;
  const previousEnvStore = process.env.OPENWORK_ENV_STORE;
  process.env.OPENWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  process.env.OPENWORK_ENV_STORE = join(root, "env.json");
  resetManagedProviderAuthCache();

  const engineRequests: string[] = [];
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    configPath: join(root, "server.json"),
    token: CLIENT_TOKEN,
    hostToken: HOST_TOKEN,
    approval: { mode: "auto", timeoutMs: 1_000 },
    corsOrigins: ["*"],
    workspaces: [{
      id: "ws_managed_provider_env",
      name: "Managed provider env",
      path: root,
      preset: "starter",
      workspaceType: "local",
    }],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  const provider = {
    id: "anthropic",
    name: "Managed",
    env: ["MANAGED_TEST_API_KEY"],
    npm: "@ai-sdk/anthropic",
  };
  let engine: Awaited<ReturnType<typeof startFakeEngine>> | undefined;
  let server: Awaited<ReturnType<typeof startServer>> | undefined;

  try {
    engine = await startFakeEngine(config, engineRequests);
    const workspace = config.workspaces[0];
    if (!workspace) throw new Error("Expected one workspace");
    workspace.baseUrl = engine.baseUrl;
    server = await startServer(config);
    const base = `http://127.0.0.1:${server.port}`;

    const initialPatch = await fetch(`${base}/runtime-config/providers`, {
      method: "PATCH",
      headers: hostHeaders(),
      body: JSON.stringify({ provider: { lpr_test: provider } }),
    });
    expect(initialPatch.status).toBe(200);
    expect(await initialPatch.json()).toMatchObject({ changed: true, reload: "reloaded" });
    expect(engineRequests.filter((entry) => entry === "POST /instance/dispose")).toHaveLength(1);
    expect(engineRequests.some((entry) => entry === "PUT /auth/lpr_test")).toBe(false);
    engineRequests.length = 0;

    const firstPut = await fetch(`${base}/env`, {
      method: "PUT",
      headers: hostHeaders(),
      body: JSON.stringify({ entries: [{ key: "MANAGED_TEST_API_KEY", value: "sk-first" }] }),
    });
    expect(firstPut.status).toBe(200);
    expect(await firstPut.json()).toEqual({ ok: true, count: 1 });
    expect(await eventually(() => managedProviderChanges(engineRequests), {
      within: 10_000,
      intervalMs: 25,
      until: (entries) => entries.length >= 2,
      label: "managed auth delivery followed by engine reload",
    })).toEqual(["PUT /auth/lpr_test", "POST /instance/dispose"]);
    expect(engineRequests).toEqual(["PUT /auth/lpr_test", "GET /session/status", "POST /instance/dispose"]);

    const stored = await fetch(`${base}/env/MANAGED_TEST_API_KEY`, { headers: hostHeaders() });
    expect(stored.status).toBe(200);
    expect(await stored.json()).toMatchObject({
      item: { key: "MANAGED_TEST_API_KEY", value: "sk-first" },
    });
    engineRequests.length = 0;

    const unrelatedPut = await fetch(`${base}/env`, {
      method: "PUT",
      headers: hostHeaders(),
      body: JSON.stringify({ entries: [{ key: "UNRELATED_KEY", value: "x" }] }),
    });
    expect(unrelatedPut.status).toBe(200);
    expect(await unrelatedPut.json()).toEqual({ ok: true, count: 1 });
    expect(managedProviderChanges(engineRequests)).toEqual([]);
    engineRequests.length = 0;

    const identicalPatch = await fetch(`${base}/runtime-config/providers`, {
      method: "PATCH",
      headers: hostHeaders(),
      body: JSON.stringify({ provider: { lpr_test: provider } }),
    });
    expect(identicalPatch.status).toBe(200);
    expect(await identicalPatch.json()).toMatchObject({ changed: false, reload: "skipped" });
    expect(managedProviderChanges(engineRequests)).toEqual([]);
    engineRequests.length = 0;

    const identicalPut = await fetch(`${base}/env`, {
      method: "PUT",
      headers: hostHeaders(),
      body: JSON.stringify({ entries: [{ key: "MANAGED_TEST_API_KEY", value: "sk-first" }] }),
    });
    expect(identicalPut.status).toBe(200);
    expect(await identicalPut.json()).toEqual({ ok: true, count: 1 });
    expect(managedProviderChanges(engineRequests)).toEqual([]);
    engineRequests.length = 0;

    const rotatedPut = await fetch(`${base}/env`, {
      method: "PUT",
      headers: hostHeaders(),
      body: JSON.stringify({ entries: [{ key: "MANAGED_TEST_API_KEY", value: "sk-second" }] }),
    });
    expect(rotatedPut.status).toBe(200);
    expect(await rotatedPut.json()).toEqual({ ok: true, count: 1 });
    expect(await eventually(() => managedProviderChanges(engineRequests), {
      within: 10_000,
      intervalMs: 25,
      until: (entries) => entries.length >= 2,
      label: "rotated managed auth delivery followed by engine reload",
    })).toEqual(["PUT /auth/lpr_test", "POST /instance/dispose"]);
    expect(engineRequests).toEqual(["PUT /auth/lpr_test", "GET /session/status", "POST /instance/dispose"]);
  } finally {
    await server?.stop();
    await engine?.stop();
    resetManagedProviderAuthCache();
    if (previousRuntimeDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
    else process.env.OPENWORK_RUNTIME_DB = previousRuntimeDb;
    if (previousEnvStore === undefined) delete process.env.OPENWORK_ENV_STORE;
    else process.env.OPENWORK_ENV_STORE = previousEnvStore;
    await rm(root, { recursive: true, force: true });
  }
});
