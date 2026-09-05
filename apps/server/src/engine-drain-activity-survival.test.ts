import { expect, test } from "bun:test";
import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EnginePool } from "./engine-pool.js";
import type { ManagedOpencodeServer } from "./managed-opencode.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

const ENV = {
  OPENWORK_ENGINE_DRAIN_TIMEOUT_MS: "300",
  OPENWORK_ENGINE_DRAIN_POLL_MS: "100",
  OPENWORK_ENGINE_ABORT_SETTLE_MS: "50",
  OPENWORK_ENGINE_MIN_SPAWN_INTERVAL_MS: "0",
};

type FakeEngine = {
  handle: ManagedOpencodeServer;
  aborted: string[];
  setBusy: (sessionIds: string[]) => void;
  emit: (sessionId: string) => void;
  globalEventSubscriptions: () => number;
  instanceEventSubscriptions: () => number;
  isClosed: () => boolean;
  stop: () => Promise<void>;
};

async function startFakeEngine(): Promise<FakeEngine> {
  const busy = new Set<string>();
  const aborted: string[] = [];
  const eventClients = new Set<ServerResponse>();
  let globalEventSubscriptions = 0;
  let instanceEventSubscriptions = 0;
  let closed = false;

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/session/status") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(Object.fromEntries([...busy].map((id) => [id, { type: "busy" }]))));
      return;
    }
    if (url.pathname === "/global/event") {
      globalEventSubscriptions += 1;
      response.writeHead(200, { "content-type": "text/event-stream" });
      eventClients.add(response);
      request.on("close", () => eventClients.delete(response));
      return;
    }
    if (url.pathname === "/event") {
      instanceEventSubscriptions += 1;
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
    globalEventSubscriptions: () => globalEventSubscriptions,
    instanceEventSubscriptions: () => instanceEventSubscriptions,
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

type Scenario = {
  pool: EnginePool;
  old: FakeEngine;
  workspace: WorkspaceInfo;
  rollover: () => Promise<{ action: string }>;
  dispose: () => Promise<void>;
};

async function startScenario(root: string, name: string, workspaceCount = 1): Promise<Scenario> {
  const old = await startFakeEngine();
  const next = await startFakeEngine();
  const runtimeConfigPath = join(root, `${name}-runtime-config.json`);
  await writeFile(runtimeConfigPath, JSON.stringify({ scenario: name }));

  const workspaces = Array.from({ length: workspaceCount }, (_, index): WorkspaceInfo => ({
    id: `ws_${name}_${index}`,
    name: `Drain ${name} ${index}`,
    path: join(root, `${name}-${index}`),
    preset: "starter",
    workspaceType: "local",
    baseUrl: old.handle.url,
  }));
  const workspace = workspaces[0];
  if (!workspace) throw new Error("a drain scenario needs at least one workspace");
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: "token",
    hostToken: "host-token",
    configPath: join(root, `${name}-server.json`),
    approval: { mode: "auto", timeoutMs: 1_000 },
    corsOrigins: ["*"],
    workspaces,
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
    opencodeBaseUrl: old.handle.url,
  };

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
      spawn: async () => next.handle,
      waitForHealthy: async () => undefined,
    },
  });
  pool.adoptPrimary({
    handle: old.handle,
    fingerprint: "superseded-config",
    registryId: null,
    trustedIdentity: null,
  });

  return {
    pool,
    old,
    workspace,
    rollover: () => pool.requestRollover({ reason: `${name}_config_changed`, workspace }),
    dispose: async () => {
      await pool.disposeAll().catch(() => undefined);
      await old.stop();
      await next.stop();
    },
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

test("drain grace bounds inactivity without aborting an active session", async () => {
  const savedEnv = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(ENV)) {
    savedEnv.set(name, process.env[name]);
    process.env[name] = value;
  }
  const root = await mkdtemp(join(tmpdir(), "openwork-drain-activity-"));
  const scenarios: Scenario[] = [];
  try {
    const streaming = await startScenario(root, "streaming", 32);
    scenarios.push(streaming);
    streaming.old.setBusy(["ses_streaming"]);
    expect((await streaming.rollover()).action).toBe("rolled_over");
    const heartbeat = setInterval(() => streaming.old.emit("ses_streaming"), 50);
    await sleep(1_200);
    clearInterval(heartbeat);
    expect(streaming.old.isClosed()).toBe(false);
    expect(streaming.old.aborted).toEqual([]);
    expect(streaming.old.globalEventSubscriptions()).toBe(1);
    expect(streaming.old.instanceEventSubscriptions()).toBe(0);

    streaming.old.setBusy([]);
    expect(await waitUntil(() => streaming.old.isClosed(), 5_000)).toBe(true);
    expect(streaming.old.aborted).toEqual([]);

    const wedged = await startScenario(root, "wedged");
    scenarios.push(wedged);
    wedged.old.setBusy(["ses_wedged"]);
    expect((await wedged.rollover()).action).toBe("rolled_over");
    expect(await waitUntil(
      () => wedged.old.isClosed() && wedged.old.aborted.includes("ses_wedged"),
      5_000,
    )).toBe(true);
  } finally {
    for (const scenario of scenarios) await scenario.dispose();
    await rm(root, { recursive: true, force: true });
    for (const [name, value] of savedEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
