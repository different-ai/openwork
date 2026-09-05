import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { engineInstanceReaperForConfig } from "./engine-instance-reaper.js";
import { clearEnginePoolForConfig, computeEngineConfigFingerprint, type EngineSpawnTemplate } from "./engine-pool.js";
import type { ManagedOpencodeServer } from "./managed-opencode.js";
import { createEnginePoolForConfig, registerTrustedOpencodeProcess, startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

/**
 * The continuous engine keeps one managed engine process alive across
 * workspace switches, so every visited workspace retains a live per-directory
 * instance forever. This tape proves the reaper's full loop against a real
 * server: an idle background workspace's instance is disposed after the TTL,
 * the active workspace and a busy background run are immune, and the next
 * traffic for the evicted workspace re-attaches its runtime-DB MCPs.
 */

type Served = { port: number; stop: (closeActiveConnections?: boolean) => void | Promise<void> };

type EngineRequest = { method: string; pathname: string; search: string; body: unknown };

const stops: Array<() => void | Promise<void>> = [];
const roots: string[] = [];
const savedEnv = new Map<string, string | undefined>();

afterEach(async () => {
  while (stops.length) await stops.pop()?.();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
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

async function createWorkspaceRoot(label: string) {
  const root = await mkdtemp(join(tmpdir(), `openwork-instance-eviction-${label}-`));
  await mkdir(join(root, ".opencode"), { recursive: true });
  roots.push(root);
  return root;
}

function startMockEngine() {
  const requests: EngineRequest[] = [];
  const busySessionsByDirectory = new Map<string, string[]>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = request.method === "POST" ? await request.json().catch(() => null) : null;
      requests.push({ method: request.method, pathname: url.pathname, search: url.search, body });

      if (url.pathname === "/instance/dispose") return Response.json({ disposed: true });
      if (url.pathname === "/session/status") {
        const directory = url.searchParams.get("directory") ?? request.headers.get("x-opencode-directory") ?? "";
        const sessions = busySessionsByDirectory.get(directory) ?? [];
        return Response.json(Object.fromEntries(sessions.map((id) => [id, { type: "busy" }])));
      }
      if (url.pathname === "/mcp" && request.method === "POST") {
        const name = (body as { name?: string } | null)?.name;
        return Response.json(name ? { [name]: { status: "connected" } } : {});
      }
      if (url.pathname === "/mcp" && request.method === "GET") return Response.json({});
      if (url.pathname.match(/^\/mcp\/[^/]+\/disconnect$/)) return Response.json({});
      if (url.pathname === "/session") return Response.json([]);
      if (url.pathname === "/event") {
        // Held open like a real engine event stream; ends when the proxy
        // aborts it after its client disconnects.
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: {}\n\n"));
          },
        });
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      }
      return Response.json({ code: "not_found", message: "Not found" }, { status: 404 });
    },
  }) as Served & { port: number };
  stops.push(() => server.stop(true));
  return {
    requests,
    url: `http://127.0.0.1:${server.port}`,
    setBusySessions: (directory: string, sessions: string[]) => {
      busySessionsByDirectory.set(directory, sessions);
    },
  };
}

function syntheticManagedHandle(url: string): ManagedOpencodeServer {
  return {
    url,
    username: "instance-eviction-user",
    password: "instance-eviction-pass",
    pid: null,
    execution: { command: "opencode", args: [], cwd: "/", env: [] },
    isAlive: () => true,
    close: async () => undefined,
  };
}

async function startPooledOpenworkServer(input: { activeRoot: string; idleRoot: string; engineUrl: string }) {
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: "owt_test_token",
    hostToken: "owt_host_token",
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [
      {
        id: "ws_active",
        name: "Active",
        path: input.activeRoot,
        preset: "starter",
        workspaceType: "local",
        baseUrl: input.engineUrl,
      },
      {
        id: "ws_idle",
        name: "Idle",
        path: input.idleRoot,
        preset: "starter",
        workspaceType: "local",
        baseUrl: input.engineUrl,
      },
    ],
    authorizedRoots: [input.activeRoot, input.idleRoot],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  registerTrustedOpencodeProcess(config, {
    baseUrl: input.engineUrl,
    identity: "test-managed-instance-eviction",
    isAlive: () => true,
  });
  const runtimeConfigPath = join(input.activeRoot, ".opencode", "runtime-config.json");
  await writeFile(runtimeConfigPath, "{}\n", "utf8");
  const template: EngineSpawnTemplate = {
    cwd: input.activeRoot,
    runtimeConfigPath,
    env: {},
    reservedPorts: () => [],
  };
  const pool = createEnginePoolForConfig({
    config,
    template,
    handle: syntheticManagedHandle(input.engineUrl),
    fingerprint: await computeEngineConfigFingerprint(template),
    registryId: null,
    trustedIdentity: null,
  });
  stops.push(async () => {
    clearEnginePoolForConfig(config);
    await pool.disposeAll();
  });
  const server = await startServer(config) as Served;
  stops.push(() => server.stop(true));
  return { base: `http://127.0.0.1:${server.port}`, token: config.token, config };
}

function auth(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function waitForRequest(
  requests: EngineRequest[],
  match: (entry: EngineRequest) => boolean,
  label: string,
  timeoutMs = 3_000,
): Promise<EngineRequest> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const found = requests.find(match);
    if (found) return found;
    await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const disposesFor = (requests: EngineRequest[], root: string) =>
  requests.filter((entry) =>
    entry.pathname === "/instance/dispose" && entry.search.includes(`directory=${encodeURIComponent(root)}`),
  );

describe("engine instance eviction", () => {
  test("an idle background instance is evicted after the TTL and re-attached on return; active and busy instances stay", async () => {
    setEnv("OPENWORK_ENGINE_INSTANCE_IDLE_TTL_MS", "250");
    setEnv("OPENWORK_MCP_SYNC_RETRY_DELAY_MS", "10");
    const activeRoot = await createWorkspaceRoot("active");
    const idleRoot = await createWorkspaceRoot("idle");
    setEnv("OPENWORK_RUNTIME_DB", join(activeRoot, "runtime.sqlite"));
    const engine = startMockEngine();
    const openwork = await startPooledOpenworkServer({ activeRoot, idleRoot, engineUrl: engine.url });
    const reaper = engineInstanceReaperForConfig(openwork.config);
    expect(reaper).not.toBeNull();
    if (!reaper) throw new Error("engine instance reaper was not registered");

    // A runtime-DB MCP on the background workspace: the dynamic push is the
    // state a fresh instance cannot recover from disk.
    const added = await fetch(`${openwork.base}/workspace/ws_idle/mcp`, {
      method: "POST",
      headers: auth(openwork.token),
      body: JSON.stringify({
        name: "posthog",
        config: { type: "remote", url: "https://mcp.posthog.com/mcp", enabled: true, oauth: {} },
      }),
    });
    expect(added.status).toBe(200);
    await waitForRequest(
      engine.requests,
      (entry) => entry.method === "POST" && entry.pathname === "/mcp",
      "the initial runtime MCP push",
    );

    // Both workspaces see traffic, so both instances are tracked.
    for (const workspaceId of ["ws_active", "ws_idle"]) {
      const proxied = await fetch(`${openwork.base}/workspace/${workspaceId}/opencode/session`, {
        headers: auth(openwork.token),
      });
      expect(proxied.status).toBe(200);
    }
    expect(reaper.snapshot().map((entry) => entry.directory).sort()).toEqual([activeRoot, idleRoot].sort());

    // Not yet stale: nothing is evicted.
    expect(await reaper.sweep()).toBe(0);
    expect(disposesFor(engine.requests, idleRoot)).toHaveLength(0);

    // A live background run holds the instance past the TTL.
    engine.setBusySessions(idleRoot, ["ses_live_run"]);
    await Bun.sleep(300);
    expect(await reaper.sweep()).toBe(0);
    expect(disposesFor(engine.requests, idleRoot)).toHaveLength(0);

    // Idle past the TTL: only the background instance is disposed.
    engine.setBusySessions(idleRoot, []);
    await Bun.sleep(300);
    expect(await reaper.sweep()).toBe(1);
    expect(disposesFor(engine.requests, idleRoot)).toHaveLength(1);
    expect(disposesFor(engine.requests, activeRoot)).toHaveLength(0);
    expect(reaper.snapshot().map((entry) => entry.directory)).toEqual([activeRoot]);

    // Returning to the evicted workspace re-attaches its runtime-DB MCPs.
    engine.requests.length = 0;
    const returned = await fetch(`${openwork.base}/workspace/ws_idle/opencode/session`, {
      headers: auth(openwork.token),
    });
    expect(returned.status).toBe(200);
    const restore = await waitForRequest(
      engine.requests,
      (entry) =>
        entry.method === "POST"
        && entry.pathname === "/mcp"
        && entry.search.includes(`directory=${encodeURIComponent(idleRoot)}`)
        && (entry.body as { name?: string } | null)?.name === "posthog",
      "the post-eviction runtime MCP re-push",
    );
    expect(restore).toBeDefined();

    // The active workspace was never disposed, and repeated sweeps stay quiet
    // for the freshly returned instance.
    expect(disposesFor(engine.requests, activeRoot)).toHaveLength(0);
    expect(await reaper.sweep()).toBe(0);
  }, 30_000);

  test("an open engine event stream keeps a stale background instance alive until the client disconnects", async () => {
    setEnv("OPENWORK_ENGINE_INSTANCE_IDLE_TTL_MS", "250");
    const activeRoot = await createWorkspaceRoot("active");
    const idleRoot = await createWorkspaceRoot("watched");
    setEnv("OPENWORK_RUNTIME_DB", join(activeRoot, "runtime.sqlite"));
    const engine = startMockEngine();
    const openwork = await startPooledOpenworkServer({ activeRoot, idleRoot, engineUrl: engine.url });
    const reaper = engineInstanceReaperForConfig(openwork.config);
    if (!reaper) throw new Error("engine instance reaper was not registered");

    // A live proxied event stream is exactly what an open tab holds.
    const streamAbort = new AbortController();
    const streamResponse = await fetch(`${openwork.base}/workspace/ws_idle/opencode/event`, {
      headers: auth(openwork.token),
      signal: streamAbort.signal,
    });
    expect(streamResponse.ok).toBe(true);
    expect(streamResponse.headers.get("content-type") ?? "").toContain("text/event-stream");
    expect(reaper.snapshot().find((entry) => entry.directory === idleRoot)?.streamHolds).toBe(1);

    // Stale past the TTL, but watched: the instance stays.
    await Bun.sleep(300);
    expect(await reaper.sweep()).toBe(0);
    expect(disposesFor(engine.requests, idleRoot)).toHaveLength(0);

    // The watching client goes away; the idle clock restarts and the next
    // stale sweep evicts.
    streamAbort.abort();
    await streamResponse.body?.cancel().catch(() => undefined);
    const releasedAt = Date.now();
    while (Date.now() - releasedAt < 3_000) {
      const holds = reaper.snapshot().find((entry) => entry.directory === idleRoot)?.streamHolds ?? 0;
      if (holds === 0) break;
      await Bun.sleep(20);
    }
    expect(reaper.snapshot().find((entry) => entry.directory === idleRoot)?.streamHolds).toBe(0);
    await Bun.sleep(300);
    expect(await reaper.sweep()).toBe(1);
    expect(disposesFor(engine.requests, idleRoot)).toHaveLength(1);
    expect(disposesFor(engine.requests, activeRoot)).toHaveLength(0);
  }, 30_000);
});
