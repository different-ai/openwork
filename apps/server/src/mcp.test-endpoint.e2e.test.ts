import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";
import { opencodeConfigPath } from "./workspace-files.js";

type Served = { port: number; stop: (closeActiveConnections?: boolean) => void | Promise<void> };

// Reuse the mock opencode harness pattern from mcp.engine-sync.e2e.test.ts:
// a fake engine whose /mcp GET returns a per-name status map.

function startMockOpencode(options?: {
  liveMcpStatusByName?: () => Record<string, unknown>;
  mcpGetResponse?: (request: Request) => Response;
}) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request: Request) {
      const url = new URL(request.url);
      if (url.pathname === "/mcp" && request.method === "GET") {
        if (options?.mcpGetResponse) return options.mcpGetResponse(request);
        return Response.json(options?.liveMcpStatusByName?.() ?? {});
      }
      if (url.pathname === "/mcp" && request.method === "POST") {
        const body = ({} as Record<string, unknown>);
        const name = body.name as string | undefined;
        const status = Object.hasOwn(options?.liveMcpStatusByName?.() ?? {}, name ?? "")
          ? options?.liveMcpStatusByName?.()[name ?? ""]
          : "connected";
        const key = name ?? "";
        return Response.json({ [key]: { status } });
      }
      if (url.pathname === "/session/status") return Response.json({});
      return Response.json({ code: "not_found", message: "Not found" }, { status: 404 });
    },
  }) as Served;
  return server;
}

async function startOpenworkServer(workspaceRoot: string, opencodeBaseUrl: string) {
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: "owt_test_token",
    hostToken: "owt_host_token",
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [
      {
        id: "ws_1",
        name: "Workspace",
        path: workspaceRoot,
        preset: "starter",
        workspaceType: "local",
        baseUrl: opencodeBaseUrl,
      },
    ],
    authorizedRoots: [workspaceRoot],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "json",
    logRequests: false,
  };
  const server = await startServer(config) as Served;
  return { base: `http://127.0.0.1:${server.port}`, token: config.token, config, server };
}

async function writeMcpConfig(workspaceRoot: string, mcp: Record<string, Record<string, unknown>>) {
  const path = opencodeConfigPath(workspaceRoot);
  await mkdir(join(workspaceRoot, ".opencode"), { recursive: true });
  await writeFile(path, JSON.stringify({ mcp }, null, 2), "utf8");
}

async function createWorkspaceRoot() {
  const root = await mkdtemp(join(tmpdir(), "openwork-mcp-test-ep-"));
  roots.push(root);
  isolateGlobalConfig(root);
  return root;
}

// Isolate global opencode config + runtime DB so desktop-managed-policy state
// (persisted managedPolicy from a prior org sign-in) cannot 403 the requests.
// Pattern follows mcp-app-host.test.ts.
const stops: Array<() => void | Promise<void>> = [];
const roots: string[] = [];
let savedEnv: Record<string, string | undefined> = {};

function isolateGlobalConfig(workspaceRoot: string) {
  savedEnv = {
    OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,
    OPENWORK_RUNTIME_DB: process.env.OPENWORK_RUNTIME_DB,
  };
  process.env.OPENCODE_CONFIG_DIR = join(workspaceRoot, "isolated-opencode");
  process.env.OPENWORK_RUNTIME_DB = join(workspaceRoot, "runtime.sqlite");
}

function restoreGlobalConfig() {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv = {};
}

afterEach(async () => {
  while (stops.length) await stops.pop()?.();
  // Windows: the reload watcher can hold handles briefly after server.stop.
  // Best-effort cleanup — a leftover temp dir is harmless; never fail the test
  // on EBUSY.
  while (roots.length) {
    const root = roots.pop()!;
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  }
  restoreGlobalConfig();
});

// The mock stdio MCP server ships with the test as a co-located fixture.
const MOCK_MCP_FIXTURE = join(import.meta.dir, "mcp-test-endpoint.mock-mcp.mjs");
// Use the `node` executable so the MCP subprocess is real Node (the mock is
// a plain .mjs ESM file). process.execPath under bun would be bun.exe.
const NODE_BIN = process.platform === "win32" ? "node.exe" : "node";

function mockMcpConfig() {
  return { type: "local" as const, command: [NODE_BIN, MOCK_MCP_FIXTURE], enabled: true };
}

describe("POST /workspace/:id/mcp/:name/test", () => {
  test("connected engine status returns real tool count via MCP SDK listTools", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    await writeMcpConfig(workspaceRoot, { mockprobe: mockMcpConfig() });

    const mock = startMockOpencode({ liveMcpStatusByName: () => ({ mockprobe: { status: "connected" } }) });
    stops.push(() => mock.stop(true));

    const openwork = await startOpenworkServer(workspaceRoot, `http://127.0.0.1:${mock.port}`);
    stops.push(() => openwork.server.stop(true));

    const res = await fetch(`${openwork.base}/workspace/ws_1/mcp/mockprobe/test`, {
      method: "POST",
      headers: { Authorization: `Bearer ${openwork.token}`, "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, status: "connected", toolCount: 3 });
  });

  test("disabled MCP short-circuits to status=disabled without probing", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    await writeMcpConfig(workspaceRoot, { mockprobe: { ...mockMcpConfig(), enabled: false } });

    const mock = startMockOpencode({ liveMcpStatusByName: () => ({}) });
    stops.push(() => mock.stop(true));

    const openwork = await startOpenworkServer(workspaceRoot, `http://127.0.0.1:${mock.port}`);
    stops.push(() => openwork.server.stop(true));

    const res = await fetch(`${openwork.base}/workspace/ws_1/mcp/mockprobe/test`, {
      method: "POST",
      headers: { Authorization: `Bearer ${openwork.token}`, "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: false, status: "disabled", reason: "mcp disabled in config" });
  });

  test("needs_auth engine status maps to needs_auth", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    await writeMcpConfig(workspaceRoot, { mockprobe: mockMcpConfig() });

    const mock = startMockOpencode({ liveMcpStatusByName: () => ({ mockprobe: { status: "needs_auth" } }) });
    stops.push(() => mock.stop(true));

    const openwork = await startOpenworkServer(workspaceRoot, `http://127.0.0.1:${mock.port}`);
    stops.push(() => openwork.server.stop(true));

    const res = await fetch(`${openwork.base}/workspace/ws_1/mcp/mockprobe/test`, {
      method: "POST",
      headers: { Authorization: `Bearer ${openwork.token}`, "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: false, status: "needs_auth", reason: "requires sign-in" });
  });

  test("engine unknown status maps to unknown", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    await writeMcpConfig(workspaceRoot, { mockprobe: mockMcpConfig() });

    const mock = startMockOpencode({ liveMcpStatusByName: () => ({ mockprobe: { status: "weird_state" } }) });
    stops.push(() => mock.stop(true));

    const openwork = await startOpenworkServer(workspaceRoot, `http://127.0.0.1:${mock.port}`);
    stops.push(() => openwork.server.stop(true));

    const res = await fetch(`${openwork.base}/workspace/ws_1/mcp/mockprobe/test`, {
      method: "POST",
      headers: { Authorization: `Bearer ${openwork.token}`, "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: false, status: "unknown", reason: "unrecognized engine status" });
  });

  test("engine without status for this MCP returns not_registered", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    await writeMcpConfig(workspaceRoot, { mockprobe: mockMcpConfig() });

    // Engine knows nothing about "mockprobe" — no entry in /mcp response.
    const mock = startMockOpencode({ liveMcpStatusByName: () => ({}) });
    stops.push(() => mock.stop(true));

    const openwork = await startOpenworkServer(workspaceRoot, `http://127.0.0.1:${mock.port}`);
    stops.push(() => openwork.server.stop(true));

    const res = await fetch(`${openwork.base}/workspace/ws_1/mcp/mockprobe/test`, {
      method: "POST",
      headers: { Authorization: `Bearer ${openwork.token}`, "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: false, status: "not_registered", reason: "engine has no status for this MCP" });
  });

  test("failed engine /mcp status probe reports unavailable, not not_registered", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    await writeMcpConfig(workspaceRoot, { mockprobe: mockMcpConfig() });

    // Simulate the engine's /mcp status probe failing (a 500 stands in for a
    // probe that times out, e.g. during engine cold-start). A failed probe must
    // be reported as "unavailable", never conflated with "engine has no entry
    // for this MCP".
    const mock = startMockOpencode({ mcpGetResponse: () => new Response("boom", { status: 500 }) });
    stops.push(() => mock.stop(true));

    const openwork = await startOpenworkServer(workspaceRoot, `http://127.0.0.1:${mock.port}`);
    stops.push(() => openwork.server.stop(true));

    const res = await fetch(`${openwork.base}/workspace/ws_1/mcp/mockprobe/test`, {
      method: "POST",
      headers: { Authorization: `Bearer ${openwork.token}`, "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: false, status: "unavailable", reason: "engine /mcp status probe did not complete" });
  });

  test("unknown MCP name returns 404", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    await writeMcpConfig(workspaceRoot, { mockprobe: mockMcpConfig() });

    const mock = startMockOpencode({ liveMcpStatusByName: () => ({ mockprobe: { status: "connected" } }) });
    stops.push(() => mock.stop(true));

    const openwork = await startOpenworkServer(workspaceRoot, `http://127.0.0.1:${mock.port}`);
    stops.push(() => openwork.server.stop(true));

    const res = await fetch(`${openwork.base}/workspace/ws_1/mcp/does_not_exist/test`, {
      method: "POST",
      headers: { Authorization: `Bearer ${openwork.token}`, "Content-Type": "application/json" },
    });
    expect(res.status).toBe(404);
  });

  test("probe that cannot connect to the MCP binary returns connected with toolCount=0 (graceful degradation)", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    // Point at a non-existent command: probeMcpToolCount's stdio spawn will
    // fail → caught → toolCount degrades to 0. Engine still reports connected.
    await writeMcpConfig(workspaceRoot, {
      mockprobe: { type: "local", command: [join(workspaceRoot, "no-such-binary-exe")], enabled: true },
    });

    const mock = startMockOpencode({ liveMcpStatusByName: () => ({ mockprobe: { status: "connected" } }) });
    stops.push(() => mock.stop(true));

    const openwork = await startOpenworkServer(workspaceRoot, `http://127.0.0.1:${mock.port}`);
    stops.push(() => openwork.server.stop(true));

    const res = await fetch(`${openwork.base}/workspace/ws_1/mcp/mockprobe/test`, {
      method: "POST",
      headers: { Authorization: `Bearer ${openwork.token}`, "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, status: "connected", toolCount: 0 });
  });

  test("unauthenticated request is rejected", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    await writeMcpConfig(workspaceRoot, { mockprobe: mockMcpConfig() });

    const mock = startMockOpencode({ liveMcpStatusByName: () => ({ mockprobe: { status: "connected" } }) });
    stops.push(() => mock.stop(true));

    const openwork = await startOpenworkServer(workspaceRoot, `http://127.0.0.1:${mock.port}`);
    stops.push(() => openwork.server.stop(true));

    const res = await fetch(`${openwork.base}/workspace/ws_1/mcp/mockprobe/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(401);
  });
});
