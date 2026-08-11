import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import {
  clearEnginePoolForConfig,
  EnginePool,
  computeEngineConfigFingerprint,
  setEnginePoolForConfig,
  type EnginePoolHooks,
  type EngineSpawnTemplate,
} from "./engine-pool.js";
import { createManagedOpencodeServer, type ManagedOpencodeServer } from "./managed-opencode.js";
import { proxyOpencodeRequest } from "./server.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

const ENV_NAMES = [
  "OPENWORK_RUNTIME_DB",
  "OPENWORK_ENGINE_DRAIN_POLL_MS",
  "OPENWORK_ENGINE_DRAIN_TIMEOUT_MS",
  "OPENWORK_ENGINE_ABORT_SETTLE_MS",
  "OPENWORK_ENGINE_MIN_SPAWN_INTERVAL_MS",
  "OPENWORK_POOL_LOG",
  "OPENWORK_POOL_STATE",
];

const cleanups: Array<() => void | Promise<void>> = [];
const savedEnv = new Map<string, string | undefined>();

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedEnv.clear();
});

function setEnv(name: string, value: string): void {
  if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
  process.env[name] = value;
}

/**
 * A stand-in engine that answers the endpoints the pool depends on. Busy
 * sessions are read per request from a state file so the test can change what
 * a specific engine reports after it has been spawned.
 */
async function writeFakeEngineBin(root: string): Promise<string> {
  const binPath = join(root, "fake-engine.mjs");
  await writeFile(binPath, [
    "#!/usr/bin/env bun",
    "import { appendFileSync, readFileSync } from 'node:fs';",
    "const portIndex = process.argv.indexOf('--port');",
    "const requestedPort = Number(process.argv[portIndex + 1] ?? 0);",
    "const logPath = process.env.OPENWORK_POOL_LOG;",
    "const statePath = process.env.OPENWORK_POOL_STATE;",
    "const append = (line) => { if (logPath) appendFileSync(logPath, `${line}\\n`); };",
    "const busySessions = (port) => {",
    "  try {",
    "    const state = JSON.parse(readFileSync(statePath, 'utf8'));",
    "    return state[String(port)] ?? [];",
    "  } catch { return []; }",
    "};",
    "const server = Bun.serve({",
    "  hostname: '127.0.0.1',",
    "  port: requestedPort,",
    "  fetch(request) {",
    "    const url = new URL(request.url);",
    "    append(`${server.port} ${request.method} ${url.pathname}`);",
    "    if (url.pathname === '/session/status') {",
    "      const entries = busySessions(server.port).map((id) => [id, { type: 'busy' }]);",
    "      return Response.json(Object.fromEntries(entries));",
    "    }",
    "    if (url.pathname === '/permission') {",
    "      const sessionID = busySessions(server.port)[0] ?? `ses_${server.port}`;",
    "      return Response.json([{ id: `req_${server.port}`, sessionID }]);",
    "    }",
    "    if (url.pathname === '/event') {",
    "      const sessionID = busySessions(server.port)[0] ?? `ses_${server.port}`;",
    "      const payload = { type: 'session.updated', properties: { sessionID } };",
    "      return new Response(`data: ${JSON.stringify(payload)}\\n\\n`, { headers: { 'content-type': 'text/event-stream' } });",
    "    }",
    "    return Response.json({ ok: true, port: server.port, path: url.pathname });",
    "  },",
    "});",
    "console.log(`opencode server listening on http://127.0.0.1:${server.port}`);",
    "process.on('SIGTERM', () => { append(`${server.port} SIGTERM`); server.stop(true); process.exit(0); });",
  ].join("\n"));
  await chmod(binPath, 0o755);
  return binPath;
}

/** A binary that starts and never prints a readiness line. */
async function writeUnreadyEngineBin(root: string): Promise<string> {
  const binPath = join(root, "unready-engine.mjs");
  await writeFile(binPath, [
    "#!/usr/bin/env bun",
    "process.on('SIGTERM', () => process.exit(0));",
    "setInterval(() => undefined, 1000);",
  ].join("\n"));
  await chmod(binPath, 0o755);
  return binPath;
}

type Fixture = {
  root: string;
  config: ServerConfig;
  workspace: WorkspaceInfo;
  template: EngineSpawnTemplate;
  statePath: string;
  logPath: string;
  hookCalls: { reloadInPlace: number; postRefreshSync: number };
  hooks: EnginePoolHooks;
  setBusy: (port: number, sessionIds: string[]) => Promise<void>;
  logLines: () => Promise<string[]>;
  setRuntimeConfig: (content: string) => Promise<void>;
  spawnPrimary: () => Promise<ManagedOpencodeServer>;
  runtimeConfigPath: string;
};

async function createFixture(options?: { bin?: "ready" | "unready" }): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "openwork-engine-pool-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));

  const logPath = join(root, "engine.log");
  const statePath = join(root, "busy-state.json");
  const runtimeConfigPath = join(root, "runtime-opencode-config.json");
  await writeFile(statePath, "{}");
  await writeFile(runtimeConfigPath, JSON.stringify({ generation: 1 }));

  for (const name of ENV_NAMES) if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
  process.env.OPENWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  process.env.OPENWORK_POOL_LOG = logPath;
  process.env.OPENWORK_POOL_STATE = statePath;
  // Fast drain polling and no spawn throttle so the tests exercise the loop
  // rather than the clock.
  process.env.OPENWORK_ENGINE_DRAIN_POLL_MS = "100";
  process.env.OPENWORK_ENGINE_MIN_SPAWN_INTERVAL_MS = "0";

  const bin = options?.bin === "unready"
    ? await writeUnreadyEngineBin(root)
    : await writeFakeEngineBin(root);

  const workspace: WorkspaceInfo = {
    id: "ws_pool",
    name: "Pool workspace",
    path: root,
    preset: "starter",
    workspaceType: "local",
  };
  const config = {
    host: "127.0.0.1",
    port: 0,
    token: "token",
    hostToken: "host-token",
    configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [workspace],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
    engineRollover: true,
  } as ServerConfig;

  const template: EngineSpawnTemplate = {
    bin,
    cwd: root,
    runtimeConfigPath,
    env: {
      OPENWORK_POOL_LOG: logPath,
      OPENWORK_POOL_STATE: statePath,
      OPENCODE_CONFIG: runtimeConfigPath,
    },
    reservedPorts: () => [],
    spawnTimeoutMs: 2_000,
  };

  const hookCalls = { reloadInPlace: 0, postRefreshSync: 0 };
  const hooks: EnginePoolHooks = {
    reloadInPlace: async () => { hookCalls.reloadInPlace += 1; },
    engineBusy: async () => {
      const state = JSON.parse(await readFile(statePath, "utf8").catch(() => "{}")) as Record<string, string[]>;
      return Object.values(state).some((sessions) => sessions.length > 0);
    },
    postRefreshSync: async () => { hookCalls.postRefreshSync += 1; },
    writeRuntimeConfigFile: async () => ({ path: runtimeConfigPath }),
    registerTrusted: () => undefined,
    clearTrusted: () => undefined,
  };

  const setBusy = async (port: number, sessionIds: string[]): Promise<void> => {
    const state = JSON.parse(await readFile(statePath, "utf8").catch(() => "{}")) as Record<string, string[]>;
    if (sessionIds.length === 0) delete state[String(port)];
    else state[String(port)] = sessionIds;
    await writeFile(statePath, JSON.stringify(state));
  };

  const spawnPrimary = async (): Promise<ManagedOpencodeServer> => {
    const handle = await createManagedOpencodeServer({ bin, cwd: root, env: template.env });
    cleanups.push(() => handle.close().catch(() => undefined));
    return handle;
  };

  return {
    root,
    config,
    workspace,
    template,
    statePath,
    logPath,
    hookCalls,
    hooks,
    setBusy,
    logLines: async () => (await readFile(logPath, "utf8").catch(() => "")).split("\n").filter(Boolean),
    setRuntimeConfig: (content: string) => writeFile(runtimeConfigPath, content),
    spawnPrimary,
    runtimeConfigPath,
  };
}

function portOf(url: string): number {
  return Number(new URL(url).port);
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return await predicate();
}

async function createPool(fixture: Fixture): Promise<{ pool: EnginePool; primary: ManagedOpencodeServer }> {
  const primary = await fixture.spawnPrimary();
  const pool = new EnginePool({ config: fixture.config, template: fixture.template, hooks: fixture.hooks });
  setEnginePoolForConfig(fixture.config, pool);
  cleanups.push(async () => {
    clearEnginePoolForConfig(fixture.config);
    await pool.disposeAll().catch(() => undefined);
  });
  pool.adoptPrimary({
    handle: primary,
    fingerprint: await computeEngineConfigFingerprint(fixture.template),
    registryId: null,
    trustedIdentity: null,
  });
  fixture.config.opencodeBaseUrl = primary.url;
  fixture.config.workspaces[0]!.baseUrl = primary.url;
  return { pool, primary };
}

describe("engine pool", () => {
  test("skips entirely when nothing the engine reads at build time changed", async () => {
    const fixture = await createFixture();
    const { pool } = await createPool(fixture);
    await fixture.setBusy(portOf(pool.primaryUrl() ?? "http://127.0.0.1:0"), ["ses_live"]);

    const outcome = await pool.requestRollover({ reason: "unchanged", workspace: fixture.workspace });

    expect(outcome).toEqual({ action: "skipped", reason: "unchanged" });
    expect(pool.snapshot().generations).toHaveLength(1);
    expect(fixture.hookCalls.reloadInPlace).toBe(0);
  });

  test("reloads in place instead of spawning when the engine is idle", async () => {
    const fixture = await createFixture();
    const { pool, primary } = await createPool(fixture);
    await fixture.setRuntimeConfig(JSON.stringify({ generation: 2 }));

    const outcome = await pool.requestRollover({ reason: "config_changed", workspace: fixture.workspace });

    expect(outcome).toEqual({ action: "reloaded_in_place" });
    expect(fixture.hookCalls.reloadInPlace).toBe(1);
    expect(pool.snapshot().generations).toHaveLength(1);
    // Still the same process; nothing was replaced.
    expect(pool.primaryUrl()).toBe(primary.url);

    // The generation now matches the new config, so an immediate repeat is a
    // no-op rather than a second reload.
    expect(await pool.requestRollover({ reason: "repeat", workspace: fixture.workspace }))
      .toEqual({ action: "skipped", reason: "unchanged" });
    expect(fixture.hookCalls.reloadInPlace).toBe(1);
  });

  test("rolls over to a standby when the engine is busy, then closes the drained engine", async () => {
    const fixture = await createFixture();
    const { pool, primary } = await createPool(fixture);
    const oldPort = portOf(primary.url);
    await fixture.setBusy(oldPort, ["ses_live"]);
    await fixture.setRuntimeConfig(JSON.stringify({ generation: 2 }));

    const outcome = await pool.requestRollover({ reason: "config_changed", workspace: fixture.workspace });

    expect(outcome.action).toBe("rolled_over");
    if (outcome.action !== "rolled_over") throw new Error("expected a rollover");
    expect(outcome.drainingSessions).toBe(1);
    // The live run was never disposed.
    expect(fixture.hookCalls.reloadInPlace).toBe(0);
    expect(primary.isAlive()).toBe(true);

    // Requests now resolve to the new engine: the pool stamps the same config
    // object every request path reads.
    const newUrl = pool.primaryUrl();
    expect(newUrl).not.toBe(primary.url);
    expect(fixture.config.opencodeBaseUrl ?? null).toBe(newUrl);
    expect(fixture.config.workspaces[0]?.baseUrl ?? null).toBe(newUrl);
    expect(pool.snapshot().generations.map((entry) => entry.role).sort()).toEqual(["draining", "primary"]);

    // The old engine is closed only once its session finishes.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(primary.isAlive()).toBe(true);
    await fixture.setBusy(oldPort, []);

    expect(await waitUntil(() => !primary.isAlive(), 5_000)).toBe(true);
    expect(await waitUntil(async () => pool.snapshot().generations.length === 1, 5_000)).toBe(true);
    expect(pool.snapshot().generations[0]?.role).toBe("primary");
    expect(await fixture.logLines()).toContain(`${oldPort} SIGTERM`);
  });

  test("keeps live session and prompt traffic on the draining generation", async () => {
    const fixture = await createFixture();
    const { pool, primary } = await createPool(fixture);
    const oldPort = portOf(primary.url);
    await fixture.setBusy(oldPort, ["ses_live"]);
    await fixture.setRuntimeConfig(JSON.stringify({ generation: 2 }));

    expect((await pool.requestRollover({ reason: "config_changed", workspace: fixture.workspace })).action)
      .toBe("rolled_over");

    const connections = pool.connections();
    const current = connections.find((connection) => connection.role === "primary");
    const draining = connections.find((connection) => connection.role === "draining");
    expect(current?.baseUrl).not.toBe(primary.url);
    expect(draining?.baseUrl).toBe(primary.url);

    expect(pool.routeRequest("GET", "/session/ses_live/message")?.target.baseUrl).toBe(primary.url);
    expect(pool.routeRequest("POST", "/session/ses_live/prompt_async")?.target.baseUrl).toBe(primary.url);
    expect(pool.routeRequest("POST", "/session/ses_new/prompt_async")?.target.baseUrl).toBe(current?.baseUrl);

    const oldEvent = {
      type: "permission.asked",
      properties: { sessionID: "ses_live", requestID: "req_old" },
    };
    expect(pool.shouldForwardEvent(draining?.generationId ?? "", oldEvent)).toBe(true);
    expect(pool.shouldForwardEvent(current?.generationId ?? "", oldEvent)).toBe(false);
    expect(pool.routeRequest("POST", "/permission/req_old/reply")?.target.baseUrl).toBe(primary.url);
    expect(pool.shouldForwardEvent(current?.generationId ?? "", {
      type: "session.created",
      properties: { sessionID: "ses_new" },
    })).toBe(true);

    await fixture.setBusy(oldPort, []);
    expect(await waitUntil(() => pool.connections().length === 1, 5_000)).toBe(true);
    const remainingPrimaryUrl = pool.primaryUrl();
    if (!remainingPrimaryUrl) throw new Error("expected the primary engine to remain live");
    expect(pool.routeRequest("GET", "/session/ses_live/message")?.target.baseUrl).toBe(remainingPrimaryUrl);
  });

  test("proxies owned sessions to the old engine and merges cross-generation reads", async () => {
    const fixture = await createFixture();
    const { pool, primary } = await createPool(fixture);
    const oldPort = portOf(primary.url);
    await fixture.setBusy(oldPort, ["ses_live"]);
    await fixture.setRuntimeConfig(JSON.stringify({ generation: 2 }));

    expect((await pool.requestRollover({ reason: "config_changed", workspace: fixture.workspace })).action)
      .toBe("rolled_over");
    const newPort = portOf(pool.primaryUrl() ?? "http://127.0.0.1:0");
    const proxy = async (path: string, method = "GET") => {
      const url = new URL(`http://127.0.0.1/opencode${path}`);
      return proxyOpencodeRequest({
        config: fixture.config,
        request: new Request(url, { method }),
        url,
        workspace: fixture.workspace,
        proxyPath: path,
      });
    };

    const owned = await (await proxy("/session/ses_live/message")).json() as { port: number };
    const fresh = await (await proxy("/session/ses_new/message")).json() as { port: number };
    expect(owned.port).toBe(oldPort);
    expect(fresh.port).toBe(newPort);

    const statuses = await (await proxy("/session/status")).json() as Record<string, unknown>;
    expect(statuses.ses_live).toEqual({ type: "busy" });
    const pending = await (await proxy("/permission")).json() as Array<{ id: string }>;
    expect(pending.map((item) => item.id).sort()).toEqual([`req_${newPort}`, `req_${oldPort}`].sort());

    const reply = await (await proxy(`/permission/req_${oldPort}/reply`, "POST")).json() as { port: number };
    expect(reply.port).toBe(oldPort);

    const events = await (await proxy("/event")).text();
    expect(events).toContain('"sessionID":"ses_live"');
    expect(events).toContain(`"sessionID":"ses_${newPort}"`);
  });

  test("ends existing event fan-in leases when a generation flips", async () => {
    const fixture = await createFixture();
    const { pool, primary } = await createPool(fixture);
    const lease = pool.openEventProxy();
    await fixture.setBusy(portOf(primary.url), ["ses_live"]);
    await fixture.setRuntimeConfig(JSON.stringify({ generation: 2 }));

    expect(lease.signal.aborted).toBe(false);
    expect((await pool.requestRollover({ reason: "config_changed", workspace: fixture.workspace })).action)
      .toBe("rolled_over");
    expect(lease.signal.aborted).toBe(true);
    lease.release();
  });

  test("aborts the remaining sessions once the drain grace period expires", async () => {
    setEnv("OPENWORK_ENGINE_DRAIN_TIMEOUT_MS", "300");
    setEnv("OPENWORK_ENGINE_ABORT_SETTLE_MS", "100");
    const fixture = await createFixture();
    const { pool, primary } = await createPool(fixture);
    const oldPort = portOf(primary.url);
    // This session never finishes, so only the grace timeout can end the drain.
    await fixture.setBusy(oldPort, ["ses_stuck"]);
    await fixture.setRuntimeConfig(JSON.stringify({ generation: 2 }));

    expect((await pool.requestRollover({ reason: "config_changed", workspace: fixture.workspace })).action)
      .toBe("rolled_over");

    expect(await waitUntil(() => !primary.isAlive(), 15_000)).toBe(true);
    expect(await waitUntil(async () => (await fixture.logLines()).includes(`${oldPort} SIGTERM`), 2_000)).toBe(true);
    const lines = await fixture.logLines();
    expect(lines).toContain(`${oldPort} POST /session/ses_stuck/abort`);
    expect(lines).toContain(`${oldPort} SIGTERM`);
  });

  test("never runs more than one primary and one draining engine", async () => {
    const fixture = await createFixture();
    const { pool, primary } = await createPool(fixture);
    await fixture.setBusy(portOf(primary.url), ["ses_live"]);
    await fixture.setRuntimeConfig(JSON.stringify({ generation: 2 }));
    expect((await pool.requestRollover({ reason: "first", workspace: fixture.workspace })).action)
      .toBe("rolled_over");

    // A burst of further changes while the first drain is still running must
    // coalesce instead of stacking processes.
    for (let index = 0; index < 4; index += 1) {
      await fixture.setRuntimeConfig(JSON.stringify({ generation: 3 + index }));
      const outcome = await pool.requestRollover({ reason: `burst_${index}`, workspace: fixture.workspace });
      expect(outcome).toEqual({ action: "coalesced" });
    }

    const roles = pool.snapshot().generations.map((entry) => entry.role).sort();
    expect(roles).toEqual(["draining", "primary"]);
  });

  test("leaves the live engine serving when the standby cannot start", async () => {
    const fixture = await createFixture();
    const { pool, primary } = await createPool(fixture);
    await fixture.setBusy(portOf(primary.url), ["ses_live"]);
    await fixture.setRuntimeConfig(JSON.stringify({ generation: 2 }));
    // Point the template at a binary that never reports readiness.
    fixture.template.bin = await writeUnreadyEngineBin(fixture.root);

    await expect(pool.requestRollover({ reason: "bad_standby", workspace: fixture.workspace })).rejects.toThrow();

    expect(primary.isAlive()).toBe(true);
    expect(pool.primaryUrl()).toBe(primary.url);
    expect(fixture.config.opencodeBaseUrl).toBe(primary.url);
    expect(pool.snapshot().generations).toHaveLength(1);
    expect(pool.snapshot().generations[0]?.role).toBe("primary");
  });

  test("disposeAll closes the draining engine as well as the primary", async () => {
    const fixture = await createFixture();
    const { pool, primary } = await createPool(fixture);
    await fixture.setBusy(portOf(primary.url), ["ses_live"]);
    await fixture.setRuntimeConfig(JSON.stringify({ generation: 2 }));
    const outcome = await pool.requestRollover({ reason: "config_changed", workspace: fixture.workspace });
    expect(outcome.action).toBe("rolled_over");
    const replacementUrl = pool.primaryUrl();

    await pool.disposeAll();

    expect(primary.isAlive()).toBe(false);
    expect(pool.snapshot().generations).toHaveLength(0);
    const lines = await fixture.logLines();
    expect(lines).toContain(`${portOf(primary.url)} SIGTERM`);
    expect(lines).toContain(`${portOf(replacementUrl ?? "http://127.0.0.1:0")} SIGTERM`);
  });
});
