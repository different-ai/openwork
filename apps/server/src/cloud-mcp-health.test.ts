import { afterEach, describe, expect, test } from "bun:test";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cloudMcpDeliveryState,
  CloudMcpDeliveryStateStore,
  calculateCloudMcpDesiredRevision,
  OPENWORK_CLOUD_EXPECTED_TOOLS,
  OPENWORK_CLOUD_PLUGIN_CANARIES,
  readOpenworkCloudMcpHealth,
} from "./cloud-mcp-health.js";
import { sanitizeDiagnosticValue } from "./diagnostic-sanitizer.js";
import { diagnoseMcpToolDeniesFromConfigs } from "./mcp.js";
import { writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

const workspace: WorkspaceInfo = {
  id: "ws_1",
  name: "Workspace",
  path: "/tmp/workspace",
  preset: "starter",
  workspaceType: "local",
};

const previousRuntimeDb = process.env.OPENWORK_RUNTIME_DB;
const previousFetch = globalThis.fetch;
const roots: string[] = [];
const runtimeDbRoots: string[] = [];
const stops: Array<() => void> = [];

type DirectProbeMode = "ok" | "missing" | "unauthorized";
type ReadHealthOptions = {
  probe?: boolean;
  beforeRead?: (directUrl: string) => void;
};

afterEach(async () => {
  globalThis.fetch = previousFetch;
  cloudMcpDeliveryState.clear();
  while (stops.length) stops.pop()?.();
  while (roots.length) await rm(roots.pop() ?? "", { recursive: true, force: true });
  if (process.platform === "win32") {
    // Bun keeps runtime-opencode-config-store SQLite handles open for the process lifetime on Windows.
    // Skip only those DB temp dirs; workspace roots and mock servers are still cleaned every test.
    runtimeDbRoots.length = 0;
  } else {
    while (runtimeDbRoots.length) await rm(runtimeDbRoots.pop() ?? "", { recursive: true, force: true });
  }
  if (previousRuntimeDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
  else process.env.OPENWORK_RUNTIME_DB = previousRuntimeDb;
});

async function createRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function createRuntimeDbPath(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  runtimeDbRoots.push(root);
  return join(root, "runtime.sqlite");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function startMockOpencode(mode: DirectProbeMode) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/global/health") return Response.json({ healthy: true, version: "1.17.11" });
      if (url.pathname === "/mcp" && request.method === "GET") {
        return Response.json({
          "openwork-cloud": { status: "connected" },
          "sibling-remote": { status: "failed", error: "fetch failed" },
        });
      }
      if (url.pathname === "/experimental/tool/ids") return Response.json([...OPENWORK_CLOUD_EXPECTED_TOOLS, ...OPENWORK_CLOUD_PLUGIN_CANARIES]);
      if (url.pathname === "/cloud-mcp/mcp/agent" && request.method === "POST") {
        if (mode === "unauthorized") return Response.json({ error: "invalid token" }, { status: 401 });
        const body: unknown = await request.json();
        const id = isRecord(body) && (typeof body.id === "string" || typeof body.id === "number" || body.id === null) ? body.id : 1;
        if (isRecord(body) && body.method === "notifications/initialized") return new Response(null, { status: 202 });
        if (isRecord(body) && body.method === "initialize") {
          return Response.json({
            id,
            jsonrpc: "2.0",
            result: {
              capabilities: { tools: {} },
              protocolVersion: "2025-06-18",
              serverInfo: { name: "openwork-cloud-test", version: "1.0.0" },
            },
          });
        }
        if (isRecord(body) && body.method === "tools/list") {
          const tools = mode === "missing"
            ? [{ name: "search_capabilities", inputSchema: {} }]
            : [
                { name: "search_capabilities", inputSchema: {} },
                { name: "execute_capability", inputSchema: {} },
              ];
          return Response.json({ id, jsonrpc: "2.0", result: { tools } });
        }
        return Response.json({ id, jsonrpc: "2.0", result: {} });
      }
      return Response.json({ code: "not_found" }, { status: 404 });
    },
  });
  stops.push(() => server.stop(true));
  return server;
}

function serverConfig(root: string, testWorkspace: WorkspaceInfo): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    token: "owt_health_client",
    hostToken: "owt_health_host",
    configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [testWorkspace],
    authorizedRoots: [testWorkspace.path],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  } satisfies ServerConfig;
}

async function readHealthForDirectProbe(mode: DirectProbeMode, options: ReadHealthOptions = {}) {
  const root = await createRoot("openwork-cloud-health-");
  const engine = startMockOpencode(mode);
  const baseUrl = `http://127.0.0.1:${engine.port}`;
  const directUrl = `${baseUrl}/cloud-mcp/mcp/agent`;
  const testWorkspace: WorkspaceInfo = {
    id: `ws_${mode}`,
    name: `Workspace ${mode}`,
    path: root,
    preset: "starter",
    workspaceType: "local",
    baseUrl,
  };
  const config = serverConfig(root, testWorkspace);
  process.env.OPENWORK_RUNTIME_DB = await createRuntimeDbPath("openwork-cloud-health-runtime-");
  await writeRuntimeOpencodeConfig(config, testWorkspace.id, (current) => ({
    ...current,
    mcp: {
      ...current.mcp,
      "openwork-cloud": {
        type: "remote",
        url: directUrl,
        enabled: true,
        headers: { Authorization: "Bearer owt_health_cloud_token" },
        oauth: false,
      },
    },
  }));
  options.beforeRead?.(directUrl);
  const health = await readOpenworkCloudMcpHealth({
    config,
    workspace: testWorkspace,
    directory: root,
    probe: options.probe,
    createWorkspaceOpencodeClient: () => createOpencodeClient({ baseUrl }),
  });
  return { health, directUrl };
}

function watchDirectFetches(directUrl: string, onFetch: () => void): void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === directUrl) onFetch();
      return originalFetch(input, init);
    },
    { preconnect: originalFetch.preconnect },
  );
}

function makeDirectProbeThrow(directUrl: string): void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === directUrl) return Promise.reject(new Error("fetch failed"));
      return originalFetch(input, init);
    },
    { preconnect: originalFetch.preconnect },
  );
}

describe("cloud MCP health foundation", () => {
  test("sanitizes nested diagnostics and never returns raw authorization tokens", () => {
    const sanitized = sanitizeDiagnosticValue({
      Authorization: "Bearer owt_secret_client_token",
      nested: {
        token: "eyJhbGciOiJub25lIn0.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123456789",
        message: "failed with Bearer abc.def.ghi and request_id=req_123 reference_id=ref_456",
      },
      cookie: "session=secret",
    });

    const text = JSON.stringify(sanitized);
    expect(text).not.toContain("owt_secret_client_token");
    expect(text).not.toContain("eyJhbGci");
    expect(text).not.toContain("abc.def.ghi");
    expect(text).not.toContain("session=secret");
    expect(text).toContain("[REDACTED]");
  });

  test("desired revisions detect token metadata change without embedding raw tokens", () => {
    const config = {
      type: "remote",
      url: "https://api.openworklabs.com/mcp/agent",
      headers: { Authorization: "Bearer owt_super_secret" },
      oauth: false,
    };
    const first = calculateCloudMcpDesiredRevision(config, {
      token: { present: true, metadata: { expiresAt: "2026-07-13T00:00:00.000Z" } },
      connectCatalogEnabled: true,
      updatedAt: 1,
    });
    const second = calculateCloudMcpDesiredRevision(config, {
      token: { present: true, metadata: { expiresAt: "2026-07-14T00:00:00.000Z" } },
      connectCatalogEnabled: true,
      updatedAt: 1,
    });

    expect(first).not.toBe(second);
    expect(first).not.toContain("owt_super_secret");
  });

  test("delivery state does not claim applied after revision changes", () => {
    const store = new CloudMcpDeliveryStateStore();
    const metadata = {
      token: { present: true, metadata: { authorizationHash: "hash_1" } },
      connectCatalogEnabled: true,
      updatedAt: 1,
    };

    store.markDesired(workspace, workspace.path, "rev_1", metadata);
    store.markReady(workspace, workspace.path, "rev_1");

    expect(store.snapshot(workspace, workspace.path, "rev_1").appliedRevision).toBe("rev_1");
    const changed = store.snapshot(workspace, workspace.path, "rev_2");
    expect(changed.state).toBe("pending");
    expect(changed.appliedRevision).toBeNull();
  });

  test("diagnoses project and global OpenCode tool denies for exact Cloud IDs", () => {
    const denies = diagnoseMcpToolDeniesFromConfigs({
      name: "openwork-cloud",
      toolIds: [...OPENWORK_CLOUD_EXPECTED_TOOLS],
      projectConfig: {
        tools: {
          "openwork-cloud_search_capabilities": false,
        },
      },
      globalConfig: {
        permission: [
          { permission: "tool", pattern: "openwork-cloud_execute_capability", action: "deny" },
        ],
      },
    });

    expect(denies.map((deny) => deny.source).sort()).toEqual(["config.global", "config.project"]);
    expect(denies.map((deny) => deny.matched).sort()).toEqual([
      "openwork-cloud_execute_capability",
      "openwork-cloud_search_capabilities",
    ]);
  });

  test("project tool allows override global denies for matching Cloud tool IDs", () => {
    const denies = diagnoseMcpToolDeniesFromConfigs({
      name: "openwork-cloud",
      toolIds: [...OPENWORK_CLOUD_EXPECTED_TOOLS],
      projectConfig: {
        tools: {
          "openwork-cloud_search_capabilities": true,
        },
      },
      globalConfig: {
        tools: { deny: ["openwork-cloud_*"] },
      },
    });

    expect(denies).toHaveLength(1);
    expect(denies[0]).toMatchObject({
      source: "config.global",
      pattern: "openwork-cloud_*",
      matched: "openwork-cloud_execute_capability",
    });
  });

  test("plugin canary denies are not reported as Cloud tool denies", () => {
    const denies = diagnoseMcpToolDeniesFromConfigs({
      name: "openwork-cloud",
      toolIds: [...OPENWORK_CLOUD_EXPECTED_TOOLS],
      projectConfig: {
        tools: {
          openwork_extension_list_actions: false,
        },
      },
      globalConfig: {},
    });

    expect(denies).toEqual([]);
  });

  test("uses engine-attested tools by default without direct Cloud endpoint fetch", async () => {
    let directFetchCount = 0;
    const { health } = await readHealthForDirectProbe("ok", {
      beforeRead: (directUrl) => watchDirectFetches(directUrl, () => {
        directFetchCount += 1;
      }),
    });

    expect(health.usable).toBe(true);
    expect(health.phase).toBe("ready");
    expect(health.tools.present.sort()).toEqual([...OPENWORK_CLOUD_EXPECTED_TOOLS].sort());
    expect(health.tools.missing).toEqual([]);
    expect(health.tools.direct.checked).toBe(false);
    expect(directFetchCount).toBe(0);
  });

  test("default engine-attested health marks delivery applied", async () => {
    const { health } = await readHealthForDirectProbe("ok");

    expect(health.delivery.state).toBe("ready");
    expect(health.delivery.appliedRevision).toBe(health.desired.revision);
  });

  test("keeps Cloud usable when only the direct probe transport is unreachable", async () => {
    const { health } = await readHealthForDirectProbe("ok", { probe: true, beforeRead: makeDirectProbeThrow });

    expect(health.usable).toBe(true);
    expect(health.phase).toBe("ready");
    expect(health.firstFailure).toBeNull();
    expect(health.tools.missing).toEqual([]);
    expect(health.tools.direct.checked).toBe(false);
    expect(health.tools.direct.missing).toEqual([]);
    expect(health.tools.direct.failure?.code).toBe("probe_unreachable");
    expect(health.delivery.appliedRevision).toBe(health.desired.revision);
  });

  test("still fails closed when the direct probe receives HTTP 401", async () => {
    const { health } = await readHealthForDirectProbe("unauthorized", { probe: true });

    expect(health.usable).toBe(false);
    expect(health.firstFailure?.code).toBe("invalid_mcp_token");
  });

  test("still reports missing Cloud tools when tools/list completes without required tools", async () => {
    const { health } = await readHealthForDirectProbe("missing", { probe: true });

    expect(health.usable).toBe(false);
    expect(health.firstFailure?.code).toBe("cloud_tools_missing");
    expect(health.tools.direct.checked).toBe(true);
    expect(health.tools.direct.missing).toEqual(["execute_capability"]);
  });

  test("reports the engine's full MCP server map with per-server errors", async () => {
    const { health } = await readHealthForDirectProbe("ok");

    expect(health.engineInspection.checked).toBe(true);
    expect(health.engineInspection.cloudPresent).toBe(true);
    expect(health.engineInspection.serverCount).toBe(2);
    expect(health.engineInspection.servers).toEqual([
      { name: "openwork-cloud", status: "connected" },
      { name: "sibling-remote", status: "failed", error: "fetch failed" },
    ]);
  });

  test("records a probe step trace with latencies and endpoint server info", async () => {
    const { health, directUrl } = await readHealthForDirectProbe("ok", { probe: true });

    const trace = health.tools.direct.trace;
    expect(trace?.endpoint).toBe(directUrl);
    expect(trace?.steps.map((step) => step.step)).toEqual(["initialize", "initialized_notice", "tools_list"]);
    for (const step of trace?.steps ?? []) {
      expect(step.ok).toBe(true);
      expect(step.latencyMs).toBeGreaterThanOrEqual(0);
    }
    expect(trace?.steps[0]?.httpStatus).toBe(200);
    expect(trace?.serverInfo).toEqual({ name: "openwork-cloud-test", version: "1.0.0" });
    expect(trace?.protocolVersion).toBe("2025-06-18");
    expect(health.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("captures the rejected initialize step in the probe trace on HTTP 401", async () => {
    const { health } = await readHealthForDirectProbe("unauthorized", { probe: true });

    const steps = health.tools.direct.trace?.steps ?? [];
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ step: "initialize", ok: false, httpStatus: 401 });
  });

  test("preserves the transport error cause chain when the probe cannot connect", async () => {
    const { health } = await readHealthForDirectProbe("ok", {
      probe: true,
      beforeRead: (directUrl) => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = Object.assign(
          (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
            const url = input instanceof Request ? input.url : String(input);
            if (url === directUrl) {
              const cause = Object.assign(new Error("self signed certificate in certificate chain"), {
                code: "SELF_SIGNED_CERT_IN_CHAIN",
              });
              return Promise.reject(new Error("fetch failed", { cause }));
            }
            return originalFetch(input, init);
          },
          { preconnect: originalFetch.preconnect },
        );
      },
    });

    // The engine stays authoritative, but the probe failure must carry the
    // cause that OpenCode itself collapses to a bare "fetch failed".
    expect(health.tools.direct.failure?.code).toBe("probe_unreachable");
    const details = JSON.stringify(health.tools.direct.failure?.details);
    expect(details).toContain("SELF_SIGNED_CERT_IN_CHAIN");
    expect(details).toContain("self signed certificate in certificate chain");
    const initializeStep = health.tools.direct.trace?.steps.find((step) => step.step === "initialize");
    expect(initializeStep?.ok).toBe(false);
  });
});
