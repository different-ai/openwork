import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clearEnginePoolForConfig, EnginePool, setEnginePoolForConfig } from "./engine-pool.js";
import type { ManagedOpencodeServer } from "./managed-opencode.js";
import { startServer } from "./server.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

const ENV = {
  OPENWORK_ENGINE_RELOAD_RETRY_MS: "50",
  OPENWORK_ENGINE_DRAIN_TIMEOUT_MS: "5000",
  OPENWORK_ENGINE_DRAIN_POLL_MS: "100",
  OPENWORK_ENGINE_MIN_SPAWN_INTERVAL_MS: "0",
};

type FakeEngine = {
  handle: ManagedOpencodeServer;
  aborted: string[];
  setBusy: (sessionIds: string[]) => void;
  emit: (sessionId: string) => void;
  isClosed: () => boolean;
  stop: () => Promise<void>;
};

type Fixture = {
  engineA: FakeEngine;
  pool: EnginePool;
  serverBaseUrl: string;
  spawnCount: () => number;
  releaseDrain: () => void;
  releaseProviderList: () => void;
};

const savedEnv = new Map<string, string | undefined>();
const engines: FakeEngine[] = [];
let root: string | null = null;
let poolToDispose: EnginePool | null = null;
let configToClear: ServerConfig | null = null;
let serverToStop: (() => void | Promise<void>) | null = null;
let denToStop: (() => void | Promise<void>) | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;
let fixture: Fixture | null = null;

async function startFakeEngine(): Promise<FakeEngine> {
  const busy = new Set<string>();
  const aborted: string[] = [];
  const eventClients = new Set<ServerResponse>();
  let closed = false;

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/session/status") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(Object.fromEntries([...busy].map((id) => [id, { type: "busy" }]))));
      return;
    }
    if (url.pathname === "/global/event") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      eventClients.add(response);
      request.on("close", () => eventClients.delete(response));
      return;
    }
    if (url.pathname === "/event") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      return;
    }
    const abortMatch = url.pathname.match(/^\/session\/([^/]+)\/abort$/);
    if (abortMatch && request.method === "POST") {
      aborted.push(decodeURIComponent(abortMatch[1] ?? ""));
      response.setHeader("content-type", "application/json");
      response.end("{}");
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end("{}");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fake engine failed to bind a port");
  const url = `http://127.0.0.1:${address.port}`;

  const stop = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    for (const client of eventClients) client.end();
    eventClients.clear();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  return {
    handle: {
      url,
      username: "engine",
      password: "engine-password",
      pid: null,
      execution: { command: "fake-engine", args: [], cwd: "/", env: [] },
      isAlive: () => !closed,
      close: stop,
    },
    aborted,
    setBusy: (sessionIds) => {
      busy.clear();
      for (const id of sessionIds) busy.add(id);
    },
    emit: (sessionId) => {
      const frame = `data: ${JSON.stringify({
        directory: "/workspace",
        payload: { type: "session.updated", properties: { sessionID: sessionId } },
      })}\n\n`;
      for (const client of eventClients) client.write(frame);
    },
    isClosed: () => closed,
    stop,
  };
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(25);
  }
  return await predicate();
}

function timeout(durationMs: number): Promise<{ status: "timeout" }> {
  return new Promise((resolve) => setTimeout(() => resolve({ status: "timeout" }), durationMs));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hostHeaders() {
  return { "x-openwork-host-token": "host-token", "content-type": "application/json" };
}

function clientHeaders() {
  return { authorization: "Bearer token", "content-type": "application/json" };
}

async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
  const payload: unknown = await response.json();
  if (!isRecord(payload)) throw new Error("Expected JSON object");
  return payload;
}

async function runSync(serverBaseUrl: string): Promise<Record<string, unknown>> {
  return readJsonObject(await fetch(`${serverBaseUrl}/cloud-provider-sync/run`, {
    method: "POST",
    headers: hostHeaders(),
    body: JSON.stringify({ reason: "settings_cloud_opened" }),
  }));
}

async function syncStatus(serverBaseUrl: string): Promise<Record<string, unknown>> {
  return readJsonObject(await fetch(`${serverBaseUrl}/cloud-provider-sync/status`, {
    headers: clientHeaders(),
  }));
}

function currentFixture(): Fixture {
  if (!fixture) throw new Error("fixture not initialized");
  return fixture;
}

beforeEach(async () => {
  for (const [name, value] of Object.entries(ENV)) {
    savedEnv.set(name, process.env[name]);
    process.env[name] = value;
  }

  const fixtureRoot = await mkdtemp(join(tmpdir(), "openwork-cloud-sync-drain-"));
  root = fixtureRoot;
  savedEnv.set("OPENWORK_RUNTIME_DB", process.env.OPENWORK_RUNTIME_DB);
  savedEnv.set("OPENWORK_ENV_STORE", process.env.OPENWORK_ENV_STORE);
  process.env.OPENWORK_RUNTIME_DB = join(fixtureRoot, "runtime.sqlite");
  process.env.OPENWORK_ENV_STORE = join(fixtureRoot, "env.json");

  const engineA = await startFakeEngine();
  engines.push(engineA);
  const runtimeConfigPath = join(fixtureRoot, "runtime-opencode-config.json");
  await writeFile(runtimeConfigPath, JSON.stringify({ scenario: "initial" }));
  const workspace: WorkspaceInfo = {
    id: "ws_cloud_sync_drain",
    name: "Cloud sync drain",
    path: fixtureRoot,
    preset: "starter",
    workspaceType: "local",
    baseUrl: engineA.handle.url,
  };
  const config = {
    host: "127.0.0.1",
    port: 0,
    token: "token",
    hostToken: "host-token",
    configPath: join(fixtureRoot, "server.json"),
    approval: { mode: "auto", timeoutMs: 1_000 },
    corsOrigins: ["*"],
    workspaces: [workspace],
    authorizedRoots: [fixtureRoot],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
    opencodeBaseUrl: engineA.handle.url,
  } as ServerConfig;

  let spawnCount = 0;
  const pool = new EnginePool({
    config,
    template: {
      cwd: fixtureRoot,
      runtimeConfigPath,
      env: {},
      reservedPorts: () => [],
    },
    hooks: {
      reloadInPlace: async () => undefined,
      engineBusy: async () => true,
      postRefreshSync: async () => undefined,
      writeRuntimeConfigFile: async () => ({ path: runtimeConfigPath }),
      registerTrusted: () => undefined,
      clearTrusted: () => undefined,
      spawn: async () => {
        const engine = await startFakeEngine();
        engines.push(engine);
        spawnCount += 1;
        return engine.handle;
      },
      waitForHealthy: async () => undefined,
    },
  });
  pool.adoptPrimary({
    handle: engineA.handle,
    fingerprint: "initial-config",
    registryId: null,
    trustedIdentity: null,
  });
  poolToDispose = pool;

  engineA.setBusy(["ses_live"]);
  await writeFile(runtimeConfigPath, JSON.stringify({ scenario: "config_changed" }));
  const rollover = await pool.requestRollover({ reason: "config_changed", workspace });
  if (rollover.action !== "rolled_over" || !pool.hasDrainingGeneration() || spawnCount !== 1) {
    throw new Error(`failed to establish drain: action=${rollover.action} draining=${pool.hasDrainingGeneration()} spawns=${spawnCount}`);
  }
  heartbeat = setInterval(() => engineA.emit("ses_live"), 50);

  const provider = {
    id: "lpr_test",
    providerId: "openai-compatible",
    name: "Test provider",
    source: "custom",
    updatedAt: "2026-08-04T10:00:00.000Z",
    providerConfig: {
      env: ["TEST_PROVIDER_API_KEY"],
      npm: "@ai-sdk/openai-compatible",
      api: "https://models.example.test/api/v1",
      options: { baseURL: "https://models.example.test/api/v1" },
      whitelist: ["allowed-model"],
      blacklist: ["blocked-model"],
    },
    apiKey: "sk-test-provider",
    apiKeys: null,
    models: [{ id: "model-a", name: "Model A", config: {} }],
  };
  let markProviderListReached: () => void = () => undefined;
  const providerListReached = new Promise<void>((resolve) => {
    markProviderListReached = resolve;
  });
  let releaseProviderList: () => void = () => undefined;
  const providerListReleased = new Promise<void>((resolve) => {
    releaseProviderList = resolve;
  });
  const den = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/v1/llm-providers") {
        markProviderListReached();
        await providerListReleased;
        return Response.json({ llmProviders: [provider] });
      }
      if (url.pathname === `/v1/llm-providers/${provider.id}/connect`) {
        return Response.json({ llmProvider: provider });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    },
  });
  denToStop = () => den.stop(true);

  setEnginePoolForConfig(config, pool);
  configToClear = config;
  const server = await startServer(config);
  serverToStop = () => server.stop();
  const serverBaseUrl = `http://127.0.0.1:${server.port}`;
  const sessionResponse = await fetch(`${serverBaseUrl}/den-session`, {
    method: "PUT",
    headers: hostHeaders(),
    body: JSON.stringify({
      baseUrl: `http://127.0.0.1:${den.port}`,
      token: "token-a",
      orgId: "org_a",
    }),
  });
  if (sessionResponse.status !== 204) throw new Error(`failed to set Den session: ${sessionResponse.status}`);
  await providerListReached;

  fixture = {
    engineA,
    pool,
    serverBaseUrl,
    spawnCount: () => spawnCount,
    releaseDrain: () => {
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      engineA.setBusy([]);
    },
    releaseProviderList,
  };
});

afterEach(async () => {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
  await poolToDispose?.disposeAll().catch(() => undefined);
  poolToDispose = null;
  await serverToStop?.();
  serverToStop = null;
  await denToStop?.();
  denToStop = null;
  if (configToClear) clearEnginePoolForConfig(configToClear);
  configToClear = null;
  for (const engine of engines) await engine.stop();
  engines.length = 0;
  if (root) await rm(root, { recursive: true, force: true });
  root = null;
  fixture = null;
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedEnv.clear();
});

describe("cloud provider sync drain defer", () => {
  test("boundedRun: applies provider sync and returns with a pending deferred reload", async () => {
    const { releaseProviderList, serverBaseUrl } = currentFixture();
    const run = runSync(serverBaseUrl);
    await sleep(25);
    releaseProviderList();
    const result = await Promise.race([run, timeout(5_000)]);
    const deferredStatus = await syncStatus(serverBaseUrl);
    const lastRun = isRecord(deferredStatus.lastRun) ? deferredStatus.lastRun : {};
    const detail = isRecord(lastRun.detail) ? lastRun.detail : {};

    expect(result.status).toBe("applied");
    expect(detail.reloadDeferred).toBe(true);
    expect(deferredStatus.reloadPending).toBe(true);
  }, 10_000);

  test("drainUntouched: leaves the draining engine and its live session untouched", async () => {
    const { engineA, pool, releaseProviderList, serverBaseUrl, spawnCount } = currentFixture();
    const run = runSync(serverBaseUrl);
    await sleep(25);
    releaseProviderList();
    await Promise.race([run, timeout(5_000)]);

    expect(engineA.isClosed()).toBe(false);
    expect(engineA.aborted).toHaveLength(0);
    expect(spawnCount()).toBe(1);
    expect(pool.hasDrainingGeneration()).toBe(true);
  }, 10_000);

  test("retryLands: retries after the drain and rolls over exactly once", async () => {
    const { pool, releaseDrain, releaseProviderList, serverBaseUrl, spawnCount } = currentFixture();
    const run = runSync(serverBaseUrl);
    await sleep(25);
    releaseProviderList();
    await Promise.race([run, timeout(5_000)]);

    releaseDrain();
    const drainRetired = await waitUntil(() => !pool.hasDrainingGeneration(), 5_000);
    const retryFinished = await waitUntil(async () => (await syncStatus(serverBaseUrl)).reloadPending === false, 5_000);
    await sleep(300);
    const settledSpawnCount: number = spawnCount();
    const settledStatus = await syncStatus(serverBaseUrl);

    expect(drainRetired).toBe(true);
    expect(retryFinished).toBe(true);
    expect(settledStatus.reloadPending).toBe(false);
    expect(settledSpawnCount).toBe(2);
  }, 10_000);
});
