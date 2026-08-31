import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import {
  BoundedSseFrameBuffer,
  clearEnginePoolForConfig,
  EnginePool,
  computeEngineConfigFingerprint,
  isEngineConnectionFailure,
  setEnginePoolForConfig,
  type EnginePoolHooks,
  type EngineSpawnTemplate,
} from "./engine-pool.js";
import { createManagedOpencodeServer, type ManagedOpencodeServer } from "./managed-opencode.js";
import { proxyOpencodeRequest, startServer } from "./server.js";
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
    "const busySessions = (port, directory) => {",
    "  try {",
    "    const state = JSON.parse(readFileSync(statePath, 'utf8'));",
    "    const value = state[String(port)];",
    "    if (Array.isArray(value)) return value;",
    "    if (!value || typeof value !== 'object') return [];",
    "    return value[directory ?? ''] ?? [];",
    "  } catch { return []; }",
    "};",
    "const eventSessions = (port) => {",
    "  try {",
    "    const state = JSON.parse(readFileSync(statePath, 'utf8'));",
    "    const events = state.__events;",
    "    if (!events || typeof events !== 'object') return null;",
    "    const value = events[String(port)];",
    "    return Array.isArray(value) ? value : null;",
    "  } catch { return null; }",
    "};",
    "const eventMode = (port) => {",
    "  try {",
    "    const state = JSON.parse(readFileSync(statePath, 'utf8'));",
    "    const modes = state.__eventMode;",
    "    if (!modes || typeof modes !== 'object') return null;",
    "    const value = modes[String(port)];",
    "    return typeof value === 'string' ? value : null;",
    "  } catch { return null; }",
    "};",
    "const server = Bun.serve({",
    "  hostname: '127.0.0.1',",
    "  port: requestedPort,",
    "  fetch(request) {",
    "    const url = new URL(request.url);",
    "    append(`${server.port} ${request.method} ${url.pathname}`);",
    "    if (url.pathname === '/session/status') {",
    "      const entries = busySessions(server.port, url.searchParams.get('directory')).map((id) => [id, { type: 'busy' }]);",
    "      return Response.json(Object.fromEntries(entries));",
    "    }",
    "    if (url.pathname === '/permission') {",
    "      const owner = Number(url.searchParams.get('owner') ?? 0);",
    "      if (owner && owner !== server.port) return Response.json([]);",
    "      const sessionID = url.searchParams.get('session') ?? busySessions(server.port, url.searchParams.get('directory'))[0] ?? `ses_${server.port}`;",
    "      return Response.json([{ id: url.searchParams.get('request') ?? `req_${server.port}`, sessionID }]);",
    "    }",
    "    if (url.pathname === '/event' || url.pathname === '/global/event') {",
    "      const mode = eventMode(server.port);",
    "      // stall: accept the socket but never answer with headers.",
    "      if (mode === 'stall') return new Promise(() => {});",
    "      // giant: one unterminated frame far above the cap on a stream that never closes.",
    "      if (mode === 'giant') {",
    "        const body = new ReadableStream({",
    "          start(controller) {",
    "            const chunk = new TextEncoder().encode('data: ' + 'x'.repeat(1024 * 1024));",
    "            for (let i = 0; i < 6; i += 1) controller.enqueue(chunk);",
    "          },",
    "        });",
    "        return new Response(body, { headers: { 'content-type': 'text/event-stream' } });",
    "      }",
    "    }",
    "    if (url.pathname === '/global/event') {",
    "      const frame = (id) => `data: ${JSON.stringify({ directory: '/workspace', payload: { type: 'session.updated', properties: { sessionID: id } } })}\\n\\n`;",
    "      if (eventSessions(server.port) !== null) {",
    "        // Test-controlled live bus: emit an event per configured session",
    "        // every 50ms on a held stream, re-reading state between beats.",
    "        let timer = null;",
    "        const body = new ReadableStream({",
    "          start(controller) {",
    "            timer = setInterval(() => {",
    "              for (const id of eventSessions(server.port) ?? []) controller.enqueue(new TextEncoder().encode(frame(id)));",
    "            }, 50);",
    "          },",
    "          cancel() { if (timer) clearInterval(timer); },",
    "        });",
    "        return new Response(body, { headers: { 'content-type': 'text/event-stream' } });",
    "      }",
    "      return new Response(frame(`ses_${server.port}`), { headers: { 'content-type': 'text/event-stream' } });",
    "    }",
    "    if (url.pathname === '/event') {",
    "      const frame = (id) => `data: ${JSON.stringify({ type: 'session.updated', properties: { sessionID: id } })}\\n\\n`;",
    "      const sessionID = busySessions(server.port, url.searchParams.get('directory'))[0] ?? `ses_${server.port}`;",
    "      if (url.searchParams.has('hold')) {",
    "        const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(frame(sessionID))); } });",
    "        return new Response(body, { headers: { 'content-type': 'text/event-stream' } });",
    "      }",
    "      return new Response(frame(sessionID), { headers: { 'content-type': 'text/event-stream' } });",
    "    }",
    "    if (url.pathname.endsWith('/reply')) {",
    "      const owner = Number(url.searchParams.get('owner') ?? 0);",
    "      if (owner && owner !== server.port) return Response.json({ ok: false }, { status: 404 });",
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
  setBusyForDirectory: (port: number, directory: string, sessionIds: string[]) => Promise<void>;
  setEventSessions: (port: number, sessionIds: string[] | null) => Promise<void>;
  setEventMode: (port: number, mode: "stall" | "giant" | null) => Promise<void>;
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
    const state = JSON.parse(await readFile(statePath, "utf8").catch(() => "{}")) as Record<string, string[] | Record<string, string[]>>;
    if (sessionIds.length === 0) delete state[String(port)];
    else state[String(port)] = sessionIds;
    await writeFile(statePath, JSON.stringify(state));
  };

  const setBusyForDirectory = async (port: number, directory: string, sessionIds: string[]): Promise<void> => {
    const state = JSON.parse(await readFile(statePath, "utf8").catch(() => "{}")) as Record<string, string[] | Record<string, string[]>>;
    const current = state[String(port)];
    const byDirectory = current !== undefined && !Array.isArray(current) ? current : {};
    if (sessionIds.length === 0) delete byDirectory[directory];
    else byDirectory[directory] = sessionIds;
    if (Object.keys(byDirectory).length === 0) delete state[String(port)];
    else state[String(port)] = byDirectory;
    await writeFile(statePath, JSON.stringify(state));
  };

  /**
   * Configure which sessions the fake engine's event bus reports as active.
   * An array (even empty) switches that engine to a held live stream; null
   * restores the legacy single-shot event body.
   */
  const setEventSessions = async (port: number, sessionIds: string[] | null): Promise<void> => {
    const state = JSON.parse(await readFile(statePath, "utf8").catch(() => "{}")) as Record<string, string[] | Record<string, string[]>>;
    const current = state.__events;
    const events = current !== undefined && !Array.isArray(current) ? current : {};
    if (sessionIds === null) delete events[String(port)];
    else events[String(port)] = sessionIds;
    if (Object.keys(events).length === 0) delete state.__events;
    else state.__events = events;
    await writeFile(statePath, JSON.stringify(state));
  };

  /**
   * Force a misbehaving event endpoint on one engine: "stall" accepts the
   * socket but never returns headers; "giant" streams one unterminated frame
   * far above the frame cap; null restores normal behavior.
   */
  const setEventMode = async (port: number, mode: "stall" | "giant" | null): Promise<void> => {
    const state = JSON.parse(await readFile(statePath, "utf8").catch(() => "{}")) as Record<string, unknown>;
    const current = state.__eventMode;
    const modes: Record<string, string> = {};
    if (current !== undefined && typeof current === "object" && current !== null && !Array.isArray(current)) {
      for (const [key, value] of Object.entries(current)) {
        if (typeof value === "string") modes[key] = value;
      }
    }
    if (mode === null) delete modes[String(port)];
    else modes[String(port)] = mode;
    if (Object.keys(modes).length === 0) delete state.__eventMode;
    else state.__eventMode = modes;
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
    setBusyForDirectory,
    setEventSessions,
    setEventMode,
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
  test("classifies undici header timeouts as engine connection failures", () => {
    const error = new TypeError("fetch failed", {
      cause: { code: "UND_ERR_HEADERS_TIMEOUT", message: "Headers Timeout Error" },
    });

    expect(isEngineConnectionFailure(error)).toBe(true);
  });

  test("classifies a cause-less fetch failure only in the engine transport classifier", () => {
    expect(isEngineConnectionFailure(new TypeError("fetch failed"))).toBe(true);
    expect(isEngineConnectionFailure(new Error("fetch failed"))).toBe(false);
  });

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

  test("provider sync holds the serving primary until a standby is healthy and keeps it on spawn failure", async () => {
    const fixture = await createFixture();
    const { pool, primary } = await createPool(fixture);
    const oldPort = portOf(primary.url);
    let markStandbyHealthReached: () => void = () => undefined;
    const standbyHealthReached = new Promise<void>((resolve) => {
      markStandbyHealthReached = resolve;
    });
    let releaseStandbyHealth: () => void = () => undefined;
    const standbyHealthReleased = new Promise<void>((resolve) => {
      releaseStandbyHealth = resolve;
    });
    let standbyHealthChecks = 0;
    fixture.hooks.waitForHealthy = async () => {
      standbyHealthChecks += 1;
      markStandbyHealthReached();
      await standbyHealthReleased;
    };
    await fixture.setRuntimeConfig(JSON.stringify({ generation: 2 }));

    const rollover = pool.requestRollover({
      reason: "cloud_provider_sync",
      workspace: fixture.workspace,
      forceStandby: true,
    });
    await standbyHealthReached;

    const url = new URL("http://127.0.0.1/opencode/config");
    const oldPrimaryRead = await proxyOpencodeRequest({
      config: fixture.config,
      request: new Request(url),
      url,
      workspace: fixture.workspace,
      proxyPath: "/config",
    });
    expect(await oldPrimaryRead.json()).toMatchObject({ port: oldPort });
    expect(pool.primaryUrl()).toBe(primary.url);
    expect(fixture.hookCalls.reloadInPlace).toBe(0);
    expect((await fixture.logLines()).filter((line) => line === `${oldPort} POST /instance/dispose`)).toEqual([]);

    releaseStandbyHealth();
    expect((await rollover).action).toBe("rolled_over");
    const replacementUrl = pool.primaryUrl();
    expect(replacementUrl).not.toBe(primary.url);
    expect(standbyHealthChecks).toBe(1);

    expect(await pool.requestRollover({
      reason: "cloud_provider_sync_unchanged",
      workspace: fixture.workspace,
      forceStandby: true,
    })).toEqual({ action: "skipped", reason: "unchanged" });
    expect(standbyHealthChecks).toBe(1);

    expect(await waitUntil(() => pool.snapshot().generations.length === 1, 5_000)).toBe(true);
    await fixture.setRuntimeConfig(JSON.stringify({ generation: 3 }));
    fixture.hooks.spawn = async () => {
      throw new Error("standby spawn failed");
    };
    await expect(pool.requestRollover({
      reason: "cloud_provider_sync_failed",
      workspace: fixture.workspace,
      forceStandby: true,
    })).rejects.toThrow("standby spawn failed");

    expect(pool.primaryUrl()).toBe(replacementUrl);
    expect(pool.snapshot().generations).toEqual([expect.objectContaining({ role: "primary" })]);
    expect((await fixture.logLines()).some((line) => line.endsWith("POST /instance/dispose"))).toBe(false);
  });

  test("forwards detached post-refresh policy without returning before the in-place switch", async () => {
    const fixture = await createFixture();
    let markReloadStarted: () => void = () => undefined;
    const reloadStarted = new Promise<void>((resolve) => {
      markReloadStarted = resolve;
    });
    let releaseReload: () => void = () => undefined;
    const reloadReleased = new Promise<void>((resolve) => {
      releaseReload = resolve;
    });
    let awaitPostRefreshSync: boolean | undefined;
    fixture.hooks.reloadInPlace = async (_config, _workspace, options) => {
      awaitPostRefreshSync = options?.awaitPostRefreshSync;
      markReloadStarted();
      await reloadReleased;
    };
    const { pool } = await createPool(fixture);
    await fixture.setRuntimeConfig(JSON.stringify({ generation: 2 }));

    const rollover = pool.requestRollover({
      reason: "workspace_activation",
      workspace: fixture.workspace,
      awaitPostRefreshSync: false,
    });
    await reloadStarted;
    expect(await Promise.race([
      rollover.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 25)),
    ])).toBe(false);

    releaseReload();
    expect(await rollover).toEqual({ action: "reloaded_in_place" });
    expect(awaitPostRefreshSync).toBe(false);
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

  test("keeps a live session from another workspace on the draining generation", async () => {
    const fixture = await createFixture();
    const secondWorkspace: WorkspaceInfo = {
      ...fixture.workspace,
      id: "ws_pool_second",
      name: "Second pool workspace",
      path: join(fixture.root, "second"),
    };
    fixture.config.workspaces.push(secondWorkspace);
    const { pool, primary } = await createPool(fixture);
    const oldPort = portOf(primary.url);
    await fixture.setBusyForDirectory(oldPort, fixture.workspace.path, ["ses_first_workspace"]);
    await fixture.setRuntimeConfig(JSON.stringify({ generation: 2 }));

    const outcome = await pool.requestRollover({
      reason: "second_workspace_sync",
      workspace: secondWorkspace,
      forceStandby: true,
    });

    expect(outcome.action).toBe("rolled_over");
    if (outcome.action !== "rolled_over") throw new Error("expected a rollover");
    expect(outcome.drainingSessions).toBe(1);
    expect(primary.isAlive()).toBe(true);
    expect(pool.routeRequest("GET", "/session/ses_first_workspace/message")?.target.baseUrl).toBe(primary.url);

    await fixture.setBusyForDirectory(oldPort, fixture.workspace.path, []);
    expect(await waitUntil(() => !primary.isAlive(), 5_000)).toBe(true);
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

    const lateUrl = new URL(`http://127.0.0.1/opencode/permission?request=req_late&owner=${newPort}&session=ses_live`);
    const latePending = await proxyOpencodeRequest({
      config: fixture.config,
      request: new Request(lateUrl),
      url: lateUrl,
      workspace: fixture.workspace,
      proxyPath: "/permission",
    });
    expect(await latePending.json()).toEqual([{ id: "req_late", sessionID: "ses_live" }]);
    const lateReply = await (await proxy("/permission/req_late/reply", "POST")).json() as { port: number };
    expect(lateReply.port).toBe(oldPort);

    const currentGeneration = pool.connections().find((connection) => connection.role === "primary");
    if (!currentGeneration) throw new Error("expected a current generation");
    pool.observePendingRequests(currentGeneration.generationId, [{ id: "req_stale", sessionID: "ses_new" }]);
    const staleUrl = new URL(`http://127.0.0.1/opencode/permission/req_stale/reply?owner=${oldPort}`);
    const staleReply = await proxyOpencodeRequest({
      config: fixture.config,
      request: new Request(staleUrl, { method: "POST" }),
      url: staleUrl,
      workspace: fixture.workspace,
      proxyPath: "/permission/req_stale/reply",
    });
    expect(await staleReply.json()).toMatchObject({ port: oldPort });

    const events = await (await proxy("/event")).text();
    expect(events).toContain('"sessionID":"ses_live"');
    expect(events).toContain(`"sessionID":"ses_${newPort}"`);
  });

  test("returns a controlled 502 when the selected engine is unreachable", async () => {
    const fixture = await createFixture();
    const { primary } = await createPool(fixture);
    await primary.close();
    const url = new URL("http://127.0.0.1/opencode/config");

    await expect(proxyOpencodeRequest({
      config: fixture.config,
      request: new Request(url, { method: "GET" }),
      url,
      workspace: fixture.workspace,
      proxyPath: "/config",
    })).rejects.toMatchObject({
      status: 502,
      code: "opencode_unreachable",
    });
  });

  test.serial("returns an uncaptured 502 for a cause-less loopback proxy fetch failure", async () => {
    const fixture = await createFixture();
    await createPool(fixture);
    const originalFetch = globalThis.fetch;
    const originalTelemetry = globalThis.__openworkDesktopTelemetry;
    const captured: unknown[] = [];
    const server = await startServer(fixture.config);
    globalThis.__openworkDesktopTelemetry = {
      captureException(error) {
        captured.push(error);
        return true;
      },
    };
    globalThis.fetch = Object.assign(
      async () => {
        throw new TypeError("fetch failed");
      },
      { preconnect: originalFetch.preconnect },
    );

    try {
      const response = await originalFetch(`http://127.0.0.1:${server.port}/opencode/config`, {
        headers: { Authorization: `Bearer ${fixture.config.token}` },
      });
      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({ code: "opencode_unreachable" });
      expect(captured).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.__openworkDesktopTelemetry = originalTelemetry;
      await server.stop();
    }
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

  test("closes an existing event response when a generation flips", async () => {
    const fixture = await createFixture();
    const { pool, primary } = await createPool(fixture);
    await fixture.setBusy(portOf(primary.url), ["ses_live"]);
    const url = new URL("http://127.0.0.1/opencode/event?hold=1");
    const response = await proxyOpencodeRequest({
      config: fixture.config,
      request: new Request(url),
      url,
      workspace: fixture.workspace,
      proxyPath: "/event",
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error("expected an event response body");
    expect((await reader.read()).done).toBe(false);
    await fixture.setRuntimeConfig(JSON.stringify({ generation: 2 }));

    expect((await pool.requestRollover({ reason: "config_changed", workspace: fixture.workspace })).action)
      .toBe("rolled_over");
    const closed = await Promise.race([
      reader.read().then((result) => result.done),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_000)),
    ]);
    expect(closed).toBe(true);
  });

  test("aborts the remaining sessions once the drain inactivity grace period expires", async () => {
    setEnv("OPENWORK_ENGINE_DRAIN_TIMEOUT_MS", "300");
    setEnv("OPENWORK_ENGINE_ABORT_SETTLE_MS", "100");
    const fixture = await createFixture();
    const { pool, primary } = await createPool(fixture);
    const oldPort = portOf(primary.url);
    // This session reports busy forever but never emits an event, so only the
    // inactivity grace timeout can end the drain.
    await fixture.setBusy(oldPort, ["ses_stuck"]);
    await fixture.setEventSessions(oldPort, []);
    await fixture.setRuntimeConfig(JSON.stringify({ generation: 2 }));

    expect((await pool.requestRollover({ reason: "config_changed", workspace: fixture.workspace })).action)
      .toBe("rolled_over");

    expect(await waitUntil(() => !primary.isAlive(), 15_000)).toBe(true);
    expect(await waitUntil(async () => (await fixture.logLines()).includes(`${oldPort} SIGTERM`), 2_000)).toBe(true);
    const lines = await fixture.logLines();
    expect(lines).toContain(`${oldPort} POST /session/ses_stuck/abort`);
    expect(lines).toContain(`${oldPort} SIGTERM`);
  });

  test("uses one global activity stream across many workspaces and never aborts an active session", async () => {
    setEnv("OPENWORK_ENGINE_DRAIN_TIMEOUT_MS", "300");
    setEnv("OPENWORK_ENGINE_ABORT_SETTLE_MS", "100");
    const fixture = await createFixture();
    for (let index = 1; index < 32; index += 1) {
      fixture.config.workspaces.push({
        ...fixture.workspace,
        id: `ws_pool_${index}`,
        name: `Pool workspace ${index}`,
        path: join(fixture.root, `workspace-${index}`),
      });
    }
    const { pool, primary } = await createPool(fixture);
    const oldPort = portOf(primary.url);
    // The run keeps streaming: the engine event bus names it continuously.
    await fixture.setBusy(oldPort, ["ses_streaming"]);
    await fixture.setEventSessions(oldPort, ["ses_streaming"]);
    await fixture.setRuntimeConfig(JSON.stringify({ generation: 2 }));

    expect((await pool.requestRollover({ reason: "config_changed", workspace: fixture.workspace })).action)
      .toBe("rolled_over");
    expect(await waitUntil(async () => (await fixture.logLines()).includes(`${oldPort} GET /global/event`), 2_000))
      .toBe(true);

    // Wait out four full grace periods: an actively working session must
    // never be aborted, so the draining engine stays alive the whole time.
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(primary.isAlive()).toBe(true);
    const activeLines = await fixture.logLines();
    expect(activeLines.filter((line) => line === `${oldPort} GET /global/event`)).toHaveLength(1);
    expect(activeLines.some((line) => line === `${oldPort} GET /event`)).toBe(false);
    expect(activeLines.some((line) => line.includes("/abort"))).toBe(false);

    // The run finishes: the engine idles and the drained generation closes
    // without ever aborting anything.
    await fixture.setEventSessions(oldPort, []);
    await fixture.setBusy(oldPort, []);
    expect(await waitUntil(() => !primary.isAlive(), 5_000)).toBe(true);
    expect((await fixture.logLines()).some((line) => line.includes("/abort"))).toBe(false);
    expect(await fixture.logLines()).toContain(`${oldPort} SIGTERM`);
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

describe("BoundedSseFrameBuffer", () => {
  const encoder = new TextEncoder();

  test("splits frames across chunk boundaries and both delimiter styles", () => {
    const buffer = new BoundedSseFrameBuffer(64);
    expect(buffer.push(encoder.encode("data: one\n\ndata: tw"))).toEqual({ frames: ["data: one"], overflow: false });
    expect(buffer.push(encoder.encode("o\r\n\r\ndata: three"))).toEqual({ frames: ["data: two"], overflow: false });
    expect(buffer.push(encoder.encode("\n\n"))).toEqual({ frames: ["data: three"], overflow: false });
  });

  test("keeps completed frames and flags overflow once the unterminated remainder exceeds the cap", () => {
    const buffer = new BoundedSseFrameBuffer(8);
    expect(buffer.push(encoder.encode("data: a\n\n0123456789"))).toEqual({ frames: ["data: a"], overflow: true });
  });

  test("never overflows while frames keep terminating", () => {
    const buffer = new BoundedSseFrameBuffer(16);
    for (let index = 0; index < 100; index += 1) {
      expect(buffer.push(encoder.encode("data: abcdefgh\n\n"))).toEqual({ frames: ["data: abcdefgh"], overflow: false });
    }
  });
});

describe("engine event stream bounds", () => {
  const proxyEvent = async (fixture: Fixture, path: string): Promise<Response> => {
    const url = new URL(`http://127.0.0.1/opencode${path}`);
    return proxyOpencodeRequest({
      config: fixture.config,
      request: new Request(url),
      url,
      workspace: fixture.workspace,
      proxyPath: url.pathname.slice("/opencode".length),
    });
  };

  test("a sibling that never returns headers does not stall the client event stream", async () => {
    setEnv("OPENWORK_ENGINE_EVENT_ESTABLISH_TIMEOUT_MS", "300");
    const fixture = await createFixture();
    const { pool, primary } = await createPool(fixture);
    const oldPort = portOf(primary.url);
    await fixture.setBusy(oldPort, ["ses_live"]);
    await fixture.setRuntimeConfig(JSON.stringify({ generation: 2 }));
    expect((await pool.requestRollover({ reason: "config_changed", workspace: fixture.workspace })).action)
      .toBe("rolled_over");
    const newPort = portOf(pool.primaryUrl() ?? "http://127.0.0.1:0");
    // The draining sibling accepts the socket but never answers with headers.
    await fixture.setEventMode(oldPort, "stall");

    const startedAt = Date.now();
    const response = await proxyEvent(fixture, "/event");
    const events = await response.text();

    expect(response.status).toBe(200);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(events).toContain(`"sessionID":"ses_${newPort}"`);
  });

  test("a quiet live event stream stays open past the establishment deadline", async () => {
    setEnv("OPENWORK_ENGINE_EVENT_ESTABLISH_TIMEOUT_MS", "300");
    const fixture = await createFixture();
    await createPool(fixture);

    // hold=1 sends one frame and then goes silent on an open stream.
    const response = await proxyEvent(fixture, "/event?hold=1");
    expect(response.status).toBe(200);
    if (!response.body) throw new Error("expected a streaming body");
    const reader = response.body.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);

    // The establishment deadline is long past; only establishment is bounded,
    // so the silent-but-live body must still be open.
    const idle = await Promise.race([
      reader.read().then((chunk) => (chunk.done ? "closed" : "data")),
      new Promise<string>((resolve) => setTimeout(() => resolve("open"), 1_200)),
    ]);
    expect(idle).toBe("open");
    await reader.cancel().catch(() => undefined);
  });

  test("closes an event connection whose frame never terminates instead of buffering it", async () => {
    const fixture = await createFixture();
    const { primary } = await createPool(fixture);
    await fixture.setEventMode(portOf(primary.url), "giant");

    const response = await proxyEvent(fixture, "/event");
    expect(response.status).toBe(200);
    // The runaway frame hits the cap: the connection is dropped and the
    // merged stream closes instead of buffering the frame forever.
    const events = await response.text();
    expect(events).toBe("");
  });

  test("the drain activity watch drops a runaway frame stream and reconnects", async () => {
    setEnv("OPENWORK_ENGINE_DRAIN_ACTIVITY_RECONNECT_MS", "100");
    const fixture = await createFixture();
    const { pool, primary } = await createPool(fixture);
    const oldPort = portOf(primary.url);
    await fixture.setBusy(oldPort, ["ses_stuck"]);
    await fixture.setEventMode(oldPort, "giant");
    await fixture.setRuntimeConfig(JSON.stringify({ generation: 2 }));
    expect((await pool.requestRollover({ reason: "config_changed", workspace: fixture.workspace })).action)
      .toBe("rolled_over");

    // Every malformed stream is dropped at the frame cap and re-dialed;
    // without the bound the first connection would buffer forever and a
    // second dial would never happen.
    expect(await waitUntil(async () => {
      const lines = await fixture.logLines();
      return lines.filter((line) => line === `${oldPort} GET /global/event`).length >= 2;
    }, 10_000)).toBe(true);
  });
});
