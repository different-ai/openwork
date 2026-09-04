import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { briefTest, claim, testBrief } from "@openwork/testkit";
import { CloudProviderSync } from "../../apps/server/src/cloud-provider-sync.js";
import { EnginePool } from "../../apps/server/src/engine-pool.js";
import { EnvService } from "../../apps/server/src/env-file.js";
import type { ManagedOpencodeServer } from "../../apps/server/src/managed-opencode.js";
import type { ServerConfig, WorkspaceInfo } from "../../apps/server/src/types.js";

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

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(25);
  }
  return predicate();
}

function timeout(durationMs: number): Promise<{ status: "timeout" }> {
  return new Promise((resolve) => setTimeout(() => resolve({ status: "timeout" }), durationMs));
}

briefTest(testBrief({
  behavior: "Cloud provider sync defers its reload while an engine generation drains, then lands exactly one rollover after the drain retires.",
  claims: {
    boundedRun: claim("provider sync applies its materialization and returns with a pending deferred reload", {
      never: "park the sync queue on waitForDrain() until the draining generation retires",
    }),
    drainUntouched: claim("deferring provider sync leaves the draining engine and its live session untouched", {
      never: "abort the draining session or spawn a second standby to satisfy the sync",
    }),
    retryLands: claim("the deferred reload retries after the drain and rolls over exactly once", {
      never: "leave the reload pending forever or roll over more than once",
    }),
  },
}), async ({ prove }) => {
  const savedEnv = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(ENV)) {
    savedEnv.set(name, process.env[name]);
    process.env[name] = value;
  }

  const root = await mkdtemp(join(tmpdir(), "openwork-cloud-sync-drain-"));
  savedEnv.set("OPENWORK_RUNTIME_DB", process.env.OPENWORK_RUNTIME_DB);
  savedEnv.set("OPENWORK_ENV_STORE", process.env.OPENWORK_ENV_STORE);
  process.env.OPENWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  process.env.OPENWORK_ENV_STORE = join(root, "env.json");

  const engines: FakeEngine[] = [];
  let poolToDispose: EnginePool | null = null;
  let syncToStop: CloudProviderSync | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  try {
    const engineA = await startFakeEngine();
    engines.push(engineA);
    const runtimeConfigPath = join(root, "runtime-opencode-config.json");
    await writeFile(runtimeConfigPath, JSON.stringify({ scenario: "initial" }));
    const workspace: WorkspaceInfo = {
      id: "ws_cloud_sync_drain",
      name: "Cloud sync drain",
      path: root,
      preset: "starter",
      workspaceType: "local",
      baseUrl: engineA.handle.url,
    };
    const config = {
      host: "127.0.0.1",
      port: 0,
      token: "token",
      configPath: join(root, "server.json"),
      approval: { mode: "auto", timeoutMs: 1_000 },
      corsOrigins: ["*"],
      workspaces: [workspace],
      authorizedRoots: [root],
      readOnly: false,
      startedAt: Date.now(),
      tokenSource: "cli",
      logFormat: "pretty",
      logRequests: false,
      opencodeBaseUrl: engineA.handle.url,
    } as ServerConfig;

    let spawnCount = 0;
    const pool = new EnginePool({
      config,
      template: {
        cwd: root,
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
    const fetchImpl = async (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1],
    ) => {
      const url = new URL(String(input));
      if (url.hostname === "den.example.test") {
        if (url.pathname === "/v1/llm-providers") return Response.json({ llmProviders: [provider] });
        if (url.pathname === `/v1/llm-providers/${provider.id}/connect`) return Response.json({ llmProvider: provider });
      }
      if (url.hostname === "127.0.0.1" && url.pathname === `/auth/${provider.id}` && init?.method === "PUT") {
        return Response.json(true);
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    };
    const sync = new CloudProviderSync({
      config,
      env: new EnvService({ path: process.env.OPENWORK_ENV_STORE }),
      fetchImpl,
      reloadEngine: () => pool.requestRollover({
        reason: "cloud_provider_sync",
        workspace,
        forceStandby: true,
      }).then(() => undefined),
      engineBusy: () => Promise.resolve(pool.hasDrainingGeneration()),
      intervalMs: 3_600_000,
    });
    syncToStop = sync;
    await sync.setSession({ baseUrl: "https://den.example.test", token: "token-a", orgId: "org_a" });

    const result = await Promise.race([sync.run("settings_cloud_opened"), timeout(5_000)]);
    const deferredStatus = sync.status();
    prove.boundedRun(
      result.status === "applied"
        && deferredStatus.lastRun?.detail?.reloadDeferred === true
        && deferredStatus.reloadPending === true,
      `Sync result=${result.status}; reloadDeferred=${deferredStatus.lastRun?.detail?.reloadDeferred ?? false}; reloadPending=${deferredStatus.reloadPending}.`,
    );
    prove.drainUntouched(
      !engineA.isClosed()
        && engineA.aborted.length === 0
        && spawnCount === 1
        && pool.hasDrainingGeneration(),
      `Engine A closed=${engineA.isClosed()} aborts=${engineA.aborted.length} spawns=${spawnCount} draining=${pool.hasDrainingGeneration()}.`,
    );

    clearInterval(heartbeat);
    heartbeat = null;
    engineA.setBusy([]);
    const drainRetired = await waitUntil(() => !pool.hasDrainingGeneration(), 5_000);
    const retryFinished = await waitUntil(() => sync.status().reloadPending === false, 5_000);
    await sleep(300);
    const settledSpawnCount: number = spawnCount;
    prove.retryLands(
      drainRetired && retryFinished && sync.status().reloadPending === false && settledSpawnCount === 2,
      `Drain retired=${drainRetired}; retry finished=${retryFinished}; reloadPending=${sync.status().reloadPending}; spawns after settle=${settledSpawnCount}.`,
    );
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    await poolToDispose?.disposeAll().catch(() => undefined);
    for (const engine of engines) await engine.stop();
    syncToStop?.stop();
    await rm(root, { recursive: true, force: true });
    for (const [name, value] of savedEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
