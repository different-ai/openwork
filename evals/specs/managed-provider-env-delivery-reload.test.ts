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
  busy: boolean,
): Promise<void> {
  const method = request.method ?? "GET";
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  requests.push(`${method} ${path}`);
  if (method === "GET" && path === "/session/status") {
    sendJson(response, 200, busy ? { ses_live: { type: "busy" } } : {});
    return;
  }
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
  let busy = false;
  const engine = createServer((request, response) => {
    void handleEngineRequest(request, response, config, requests, busy).catch((error) => {
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
    setBusy: (value: boolean) => { busy = value; },
    stop: () => new Promise<void>((resolve, reject) => {
      engine.close((error) => error ? reject(error) : resolve());
      engine.closeAllConnections();
    }),
  };
}

test("stored managed provider credentials reload only after full session or auth delivery", async () => {
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
  let den: ReturnType<typeof createServer> | undefined;

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
    engineRequests.length = 0;

    const denRequests: string[] = [];
    const cloudProvider = {
      id: "lpr_ready", providerId: "openai-compatible", name: "Ready provider", source: "custom",
      providerConfig: { env: ["READY_PROVIDER_KEY"], npm: "@ai-sdk/openai-compatible" },
      apiKey: "sk-ready-only", models: [{ id: "ready-model", name: "Ready model", config: {} }],
    };
    const denWitness = createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      denRequests.push(path);
      if (path === "/v1/me/desktop-config") sendJson(response, 200, {});
      else if (path === "/v1/llm-providers") sendJson(response, 200, { llmProviders: [cloudProvider] });
      else if (path === "/v1/llm-providers/lpr_ready/connect") sendJson(response, 200, { llmProvider: cloudProvider });
      else sendJson(response, 404, { error: "not_found" });
    });
    den = denWitness;
    await new Promise<void>((resolve, reject) => {
      denWitness.once("error", reject);
      denWitness.listen(0, "127.0.0.1", resolve);
    });
    const address = denWitness.address();
    if (!address || typeof address === "string") throw new Error("Den witness did not bind a port");
    const identity = JSON.stringify({ baseUrl: `http://127.0.0.1:${address.port}`, token: "test-den-token", orgId: "org_ready" });
    const providersBefore = await (await fetch(`${base}/runtime-config/providers`, { headers: hostHeaders() })).json();
    const envBefore = await readFile(process.env.OPENWORK_ENV_STORE, "utf8");
    const configBefore = await readFile(openworkRuntimeConfigFilePath(config), "utf8");
    const early = await fetch(`${base}/den-session/identity`, { method: "PUT", headers: hostHeaders(), body: identity });
    expect(early.status).toBe(204);
    expect(await (await fetch(`${base}/managed-policy`, { headers: { authorization: `Bearer ${CLIENT_TOKEN}` } })).json())
      .toMatchObject({ policy: {} });
    const premature = await fetch(`${base}/cloud-provider-sync/run`, { method: "POST", headers: hostHeaders(), body: "{}" });
    expect(await premature.json()).toEqual({ status: "no_session" });
    expect(denRequests.every((path) => path === "/v1/me/desktop-config")).toBe(true);
    expect(await (await fetch(`${base}/runtime-config/providers`, { headers: hostHeaders() })).json()).toEqual(providersBefore);
    expect(await readFile(process.env.OPENWORK_ENV_STORE, "utf8")).toBe(envBefore);
    expect(await readFile(openworkRuntimeConfigFilePath(config), "utf8")).toBe(configBefore);
    expect(engineRequests).toEqual([]);

    const ready = await fetch(`${base}/den-session`, { method: "PUT", headers: hostHeaders(), body: identity });
    expect(ready.status).toBe(204);
    await eventually(async () => {
      const response = await fetch(`${base}/cloud-provider-sync/status`, { headers: { authorization: `Bearer ${CLIENT_TOKEN}` } });
      return response.json();
    }, { within: 5_000, intervalMs: 25, until: (status) => status.lastRun?.status === "applied", label: "automatic sync after full session delivery" });
    expect(denRequests).toContain("/v1/llm-providers/lpr_ready/connect");
    expect(await (await fetch(`${base}/env/READY_PROVIDER_KEY`, { headers: hostHeaders() })).json())
      .toMatchObject({ item: { value: "sk-ready-only" } });
    expect(managedProviderChanges(engineRequests)).toContain("PUT /auth/lpr_ready");
    expect(engineRequests.indexOf("PUT /auth/lpr_ready")).toBeLessThan(engineRequests.indexOf("POST /instance/dispose"));

    const materializedEnv = await readFile(process.env.OPENWORK_ENV_STORE, "utf8");
    const materializedConfig = await readFile(openworkRuntimeConfigFilePath(config), "utf8");
    engine.setBusy(true);
    engineRequests.length = 0;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect((await fetch(`${base}/den-session/identity`, { method: "PUT", headers: hostHeaders(), body: identity })).status).toBe(204);
    }
    expect((await fetch(`${base}/den-session`, { method: "PUT", headers: hostHeaders(), body: identity })).status).toBe(204);
    const resumed = await fetch(`${base}/cloud-provider-sync/run`, { method: "POST", headers: hostHeaders(), body: "{}" });
    expect(await resumed.json()).toEqual({ status: "noop" });
    expect(await readFile(process.env.OPENWORK_ENV_STORE, "utf8")).toBe(materializedEnv);
    expect(await readFile(openworkRuntimeConfigFilePath(config), "utf8")).toBe(materializedConfig);
    expect(engineRequests.filter((entry) => !entry.startsWith("GET "))).toEqual([]);
  } finally {
    await server?.stop();
    if (den) {
      const witness = den;
      await new Promise<void>((resolve) => { witness.close(() => resolve()); witness.closeAllConnections(); });
    }
    await engine?.stop();
    resetManagedProviderAuthCache();
    if (previousRuntimeDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
    else process.env.OPENWORK_RUNTIME_DB = previousRuntimeDb;
    if (previousEnvStore === undefined) delete process.env.OPENWORK_ENV_STORE;
    else process.env.OPENWORK_ENV_STORE = previousEnvStore;
    await rm(root, { recursive: true, force: true });
  }
});
