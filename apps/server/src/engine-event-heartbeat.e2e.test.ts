import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clearEnginePoolForConfig, computeEngineConfigFingerprint, type EngineSpawnTemplate } from "./engine-pool.js";
import type { ManagedOpencodeServer } from "./managed-opencode.js";
import { createEnginePoolForConfig, registerTrustedOpencodeProcess, startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

/**
 * The merged engine event stream must keep quiet-but-healthy connections
 * attestable: SSE comments are invisible to SSE parsers (they only yield
 * frames with data lines), so the keepalive has to be a data-bearing
 * heartbeat event. Otherwise the renderer's stale-stream watchdog cannot
 * tell a healthy silent stream from a dead socket and churns reconnects.
 */

type Served = { port: number; stop: (closeActiveConnections?: boolean) => void | Promise<void> };

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

function startMockEngine() {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/event") {
        // Held open and silent like a real engine between task events; ends
        // when the proxy aborts it after its client disconnects.
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: {}\n\n"));
          },
        });
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      }
      if (url.pathname === "/session/status") return Response.json({});
      if (url.pathname === "/session") return Response.json([]);
      if (url.pathname === "/mcp") return Response.json({});
      if (url.pathname === "/instance/dispose") return Response.json({ disposed: true });
      return Response.json({ code: "not_found", message: "Not found" }, { status: 404 });
    },
  }) as Served & { port: number };
  stops.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}` };
}

function syntheticManagedHandle(url: string): ManagedOpencodeServer {
  return {
    url,
    username: "event-heartbeat-user",
    password: "event-heartbeat-pass",
    pid: null,
    execution: { command: "opencode", args: [], cwd: "/", env: [] },
    isAlive: () => true,
    close: async () => undefined,
  };
}

async function startPooledOpenworkServer(input: { root: string; engineUrl: string }) {
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: "owt_test_token",
    hostToken: "owt_host_token",
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [{
      id: "ws_heartbeat",
      name: "Heartbeat",
      path: input.root,
      preset: "starter",
      workspaceType: "local",
      baseUrl: input.engineUrl,
    }],
    authorizedRoots: [input.root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  registerTrustedOpencodeProcess(config, {
    baseUrl: input.engineUrl,
    identity: "test-event-heartbeat",
    isAlive: () => true,
  });
  const runtimeConfigPath = join(input.root, ".opencode", "runtime-config.json");
  await writeFile(runtimeConfigPath, "{}\n", "utf8");
  const template: EngineSpawnTemplate = {
    cwd: input.root,
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
  return { base: `http://127.0.0.1:${server.port}`, token: config.token };
}

describe("engine event stream heartbeat", () => {
  test("emits data-bearing heartbeats on a quiet stream instead of SSE comments", async () => {
    setEnv("OPENWORK_ENGINE_EVENT_HEARTBEAT_MS", "50");
    const root = await mkdtemp(join(tmpdir(), "openwork-event-heartbeat-"));
    roots.push(root);
    await mkdir(join(root, ".opencode"), { recursive: true });
    const engine = startMockEngine();
    const openwork = await startPooledOpenworkServer({ root, engineUrl: engine.url });

    const controller = new AbortController();
    const response = await fetch(`${openwork.base}/workspace/ws_heartbeat/opencode/event`, {
      headers: { Authorization: `Bearer ${openwork.token}`, Accept: "text/event-stream" },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    const deadline = Date.now() + 3_000;
    let heartbeats = 0;
    while (Date.now() < deadline && heartbeats < 2) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 250)),
      ]);
      if (chunk === null) continue;
      if (chunk.done) break;
      buffered += decoder.decode(chunk.value, { stream: true });
      heartbeats = (buffered.match(/data: \{"type":"server\.heartbeat"\}/g) ?? []).length;
    }
    controller.abort();
    await reader.cancel().catch(() => undefined);

    // Two heartbeats prove a periodic signal, not a one-shot frame. Comment
    // keepalives would be dropped by SSE parsers before any liveness
    // tracking, so none may remain.
    expect(heartbeats).toBeGreaterThanOrEqual(2);
    expect(buffered).not.toContain(": ping");
  }, 20_000);
});
