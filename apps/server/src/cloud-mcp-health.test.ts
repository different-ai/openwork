import { afterEach, describe, expect, test } from "bun:test";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cloudMcpDeliveryState,
  CloudMcpDeliveryStateStore,
  calculateCloudMcpDesiredRevision,
  clearOpenworkCloudMcpProbeFlights,
  cloudMcpTokenHealthFromConfig,
  OPENWORK_CLOUD_EXPECTED_TOOLS,
  OPENWORK_CLOUD_PLUGIN_CANARIES,
  migrateOpenworkCloudMcpRuntimeConfig,
  readOpenworkCloudMcpHealth,
} from "./cloud-mcp-health.js";
import { sanitizeDiagnosticValue } from "./diagnostic-sanitizer.js";
import { diagnoseMcpToolDeniesFromConfigs } from "./mcp.js";
import {
  readEffectiveRuntimeOpencodeConfig,
  readGlobalRuntimeOpencodeConfig,
  readRuntimeOpencodeConfig,
  writeGlobalRuntimeOpencodeConfig,
  writeRuntimeOpencodeConfig,
} from "./runtime-opencode-config-store.js";
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

type DirectProbeMode = "ok" | "missing" | "unauthorized" | "status_missing_token" | "bad_gateway";
type ReadHealthOptions = {
  probe?: boolean;
  beforeRead?: (directUrl: string) => void;
};

afterEach(async () => {
  globalThis.fetch = previousFetch;
  cloudMcpDeliveryState.clear();
  clearOpenworkCloudMcpProbeFlights();
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

function requestBarrier() {
  let entries = 0;
  let releaseRequests: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    releaseRequests = resolve;
  });
  const waiters: Array<{ target: number; resolve: () => void }> = [];
  return {
    async enter(): Promise<void> {
      entries += 1;
      for (let index = waiters.length - 1; index >= 0; index -= 1) {
        const waiter = waiters[index];
        if (waiter && entries >= waiter.target) {
          waiters.splice(index, 1);
          waiter.resolve();
        }
      }
      await released;
    },
    waitForEntries(target: number): Promise<void> {
      if (entries >= target) return Promise.resolve();
      return new Promise((resolve) => waiters.push({ target, resolve }));
    },
    release(): void {
      releaseRequests();
    },
  };
}

function startMockOpencode(initialMode: DirectProbeMode) {
  let mode = initialMode;
  let toolIdsBarrier: ReturnType<typeof requestBarrier> | null = null;
  let initializeBarrier: ReturnType<typeof requestBarrier> | null = null;
  const directOperations: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/global/health") return Response.json({ healthy: true, version: "1.17.11" });
      if (url.pathname === "/mcp" && request.method === "GET") {
        if (mode === "status_missing_token") {
          return Response.json({
            "openwork-cloud": {
              status: "failed",
              error: "Streamable HTTP error: Error POSTing to endpoint: {\"error\":\"missing_mcp_token\",\"message\":\"Provide a Bearer token with MCP scope to access this resource.\",\"referenceId\":\"req_missing\"}",
            },
          });
        }
        return Response.json({
          "openwork-cloud": { status: "connected" },
          "sibling-remote": { status: "failed", error: "fetch failed" },
        });
      }
      if (url.pathname === "/experimental/tool/ids") {
        if (toolIdsBarrier) await toolIdsBarrier.enter();
        return Response.json([...OPENWORK_CLOUD_EXPECTED_TOOLS, ...OPENWORK_CLOUD_PLUGIN_CANARIES]);
      }
      if (url.pathname === "/cloud-mcp/mcp/agent" && request.method === "POST") {
        const body: unknown = await request.json();
        const method = isRecord(body) && typeof body.method === "string" ? body.method : "unknown";
        directOperations.push(method);
        if (method === "initialize" && initializeBarrier) await initializeBarrier.enter();
        if (mode === "unauthorized") return Response.json({ error: "invalid token" }, { status: 401 });
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
          if (mode === "bad_gateway") return Response.json({ error: "upstream unavailable" }, { status: 502 });
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
  return {
    server,
    directOperations,
    setMode(nextMode: DirectProbeMode): void {
      mode = nextMode;
    },
    blockToolIds() {
      const barrier = requestBarrier();
      toolIdsBarrier = barrier;
      return {
        waitForEntries: barrier.waitForEntries,
        release(): void {
          if (toolIdsBarrier === barrier) toolIdsBarrier = null;
          barrier.release();
        },
      };
    },
    blockInitialize() {
      const barrier = requestBarrier();
      initializeBarrier = barrier;
      return {
        waitForEntries: barrier.waitForEntries,
        release(): void {
          if (initializeBarrier === barrier) initializeBarrier = null;
          barrier.release();
        },
      };
    },
  };
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

async function setupDirectProbeHarness(mode: DirectProbeMode, workspaceIds = ["ws_probe"]) {
  const engine = startMockOpencode(mode);
  const baseUrl = `http://127.0.0.1:${engine.server.port}`;
  const workspaces: WorkspaceInfo[] = [];
  for (const id of workspaceIds) {
    const root = await createRoot(`openwork-cloud-health-${id}-`);
    workspaces.push({
      id,
      name: `Workspace ${id}`,
      path: root,
      preset: "starter",
      workspaceType: "local",
      baseUrl,
    });
  }
  const primary = workspaces[0];
  if (!primary) throw new Error("At least one direct-probe workspace is required");
  const config = serverConfig(primary.path, primary);
  config.workspaces = workspaces;
  config.authorizedRoots = workspaces.map((entry) => entry.path);
  process.env.OPENWORK_RUNTIME_DB = await createRuntimeDbPath("openwork-cloud-health-runtime-");
  const directUrl = `${baseUrl}/cloud-mcp/mcp/agent`;
  const desiredConfig = {
    type: "remote",
    url: directUrl,
    enabled: true,
    headers: { Authorization: "Bearer owt_health_cloud_token" },
    oauth: false,
  };
  await writeGlobalRuntimeOpencodeConfig(config, (current) => ({
    ...current,
    mcp: { ...current.mcp, "openwork-cloud": desiredConfig },
  }));
  const read = async (workspaceId = primary.id, providerModel?: { provider: string; model: string }) => {
    const testWorkspace = workspaces.find((entry) => entry.id === workspaceId);
    if (!testWorkspace) throw new Error(`Unknown direct-probe workspace ${workspaceId}`);
    return readOpenworkCloudMcpHealth({
      config,
      workspace: testWorkspace,
      directory: testWorkspace.path,
      providerModel,
      probe: true,
      createWorkspaceOpencodeClient: () => createOpencodeClient({ baseUrl }),
    });
  };
  return { ...engine, config, desiredConfig, directUrl, primary, read, workspaces };
}

async function readHealthForDirectProbe(mode: DirectProbeMode, options: ReadHealthOptions = {}) {
  const harness = await setupDirectProbeHarness(mode, [`ws_${mode}`]);
  options.beforeRead?.(harness.directUrl);
  const health = options.probe ? await harness.read() : await readOpenworkCloudMcpHealth({
    config: harness.config,
    workspace: harness.primary,
    directory: harness.primary.path,
    createWorkspaceOpencodeClient: () => createOpencodeClient({ baseUrl: `http://127.0.0.1:${harness.server.port}` }),
  });
  return { health, directUrl: harness.directUrl };
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

  test("desired revisions detect token changes without exposing reusable auth fingerprints", async () => {
    const config = {
      type: "remote",
      url: "https://api.openworklabs.com/mcp/agent",
      headers: { Authorization: "Bearer owt_super_secret" },
      oauth: false,
    };
    const first = await calculateCloudMcpDesiredRevision(config, {
      token: { present: true, metadata: { expiresAt: "2026-07-13T00:00:00.000Z" } },
      connectCatalogEnabled: true,
      updatedAt: 1,
    });
    const second = await calculateCloudMcpDesiredRevision(config, {
      token: { present: true, metadata: { expiresAt: "2026-07-14T00:00:00.000Z" } },
      connectCatalogEnabled: true,
      updatedAt: 1,
    });
    const changedToken = await calculateCloudMcpDesiredRevision({
      ...config,
      headers: { Authorization: "Bearer owt_different_secret" },
    }, {
      token: { present: true, metadata: { expiresAt: "2026-07-13T00:00:00.000Z" } },
      connectCatalogEnabled: true,
      updatedAt: 1,
    });

    expect(first).not.toBe(second);
    expect(first).not.toBe(changedToken);
    expect(first).not.toContain("owt_super_secret");
  });

  test("token health does not expose an authorization fingerprint", () => {
    const token = cloudMcpTokenHealthFromConfig({
      headers: { Authorization: "Bearer owt_super_secret" },
    }, {
      expiresAt: "2026-07-13T00:00:00.000Z",
    });

    expect(token).toEqual({
      present: true,
      metadata: { expiresAt: "2026-07-13T00:00:00.000Z" },
    });
    expect(JSON.stringify(token)).not.toContain("owt_super_secret");
  });

  test("delivery state does not claim applied after revision changes", () => {
    const store = new CloudMcpDeliveryStateStore();
    const metadata = {
      token: { present: true, metadata: { expiresAt: "2026-07-13T00:00:00.000Z" } },
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

  test("migrates the newest valid workspace config globally and preserves workspace state", async () => {
    const root = await createRoot("openwork-cloud-migration-");
    const workspaceA = { ...workspace, id: "ws_a", path: join(root, "a") };
    const workspaceB = { ...workspace, id: "ws_b", path: join(root, "b") };
    const workspaceC = { ...workspace, id: "ws_c", path: join(root, "c") };
    const config = serverConfig(root, workspaceA);
    config.workspaces = [workspaceA, workspaceB, workspaceC];
    process.env.OPENWORK_RUNTIME_DB = await createRuntimeDbPath("openwork-cloud-migration-runtime-");
    // Trusted origins: promotion to account-global scope refuses anything else.
    const older = { type: "remote", url: "http://127.0.0.1:4801/mcp/agent", enabled: true, headers: { Authorization: "Bearer older" }, oauth: false };
    const newer = { ...older, url: "https://api.openworklabs.com/mcp/agent", headers: { Authorization: "Bearer newer" } };
    await writeRuntimeOpencodeConfig(config, workspaceA.id, () => ({
      plugin: ["keep-a"],
      mcp: { "openwork-cloud": older, posthog: { type: "remote", url: "https://posthog.example/mcp" } },
    }));
    await Bun.sleep(2);
    await writeRuntimeOpencodeConfig(config, workspaceB.id, () => ({
      disabled_providers: ["keep-b"],
      mcp: { "openwork-cloud": newer, stripe: { type: "remote", url: "https://stripe.example/mcp" } },
    }));
    await Bun.sleep(2);
    await writeRuntimeOpencodeConfig(config, workspaceC.id, () => ({
      mcp: {
        "openwork-cloud": { ...newer, headers: {} },
        linear: { type: "remote", url: "https://linear.example/mcp" },
      },
    }));

    expect(await migrateOpenworkCloudMcpRuntimeConfig(config)).toMatchObject({ config: newer, changed: true });
    expect((await readGlobalRuntimeOpencodeConfig(config)).mcp?.["openwork-cloud"]).toEqual(newer);
    expect(await readRuntimeOpencodeConfig(config, workspaceA.id)).toEqual({
      plugin: ["keep-a"],
      mcp: { posthog: { type: "remote", url: "https://posthog.example/mcp" } },
    });
    expect(await readRuntimeOpencodeConfig(config, workspaceB.id)).toEqual({
      disabled_providers: ["keep-b"],
      mcp: { stripe: { type: "remote", url: "https://stripe.example/mcp" } },
    });
    expect((await readRuntimeOpencodeConfig(config, workspaceC.id)).mcp).toEqual({
      linear: { type: "remote", url: "https://linear.example/mcp" },
    });
    expect((await readEffectiveRuntimeOpencodeConfig(config, workspaceA.id)).mcp?.["openwork-cloud"]).toEqual(newer);
    expect((await readEffectiveRuntimeOpencodeConfig(config, workspaceB.id)).mcp?.["openwork-cloud"]).toEqual(newer);
    expect(await migrateOpenworkCloudMcpRuntimeConfig(config)).toEqual({ config: newer, changed: false });
  });

  test("does not promote an untrusted legacy endpoint to account-global scope", async () => {
    const root = await createRoot("openwork-cloud-migration-untrusted-");
    const workspaceA = { ...workspace, id: "ws_a", path: join(root, "a") };
    const config = serverConfig(root, workspaceA);
    config.workspaces = [workspaceA];
    process.env.OPENWORK_RUNTIME_DB = await createRuntimeDbPath("openwork-cloud-migration-untrusted-runtime-");
    // Valid shape, untrusted origin: a planted or stale workspace row must stay
    // workspace-scoped instead of silently reconfiguring every workspace.
    const untrusted = { type: "remote", url: "https://evil.example/mcp/agent", enabled: true, headers: { Authorization: "Bearer planted" }, oauth: false };
    await writeRuntimeOpencodeConfig(config, workspaceA.id, () => ({ mcp: { "openwork-cloud": untrusted } }));

    const result = await migrateOpenworkCloudMcpRuntimeConfig(config);

    expect(result).toEqual({ config: null, changed: false });
    expect((await readGlobalRuntimeOpencodeConfig(config)).mcp?.["openwork-cloud"]).toBeUndefined();
    // Not promoted and not destroyed: the entry keeps its pre-migration
    // workspace-scoped blast radius.
    expect((await readRuntimeOpencodeConfig(config, workspaceA.id)).mcp?.["openwork-cloud"]).toEqual(untrusted);
  });

  test("does not mutate legacy rows while the server is read-only", async () => {
    const root = await createRoot("openwork-cloud-readonly-migration-");
    const config = serverConfig(root, workspace);
    process.env.OPENWORK_RUNTIME_DB = await createRuntimeDbPath("openwork-cloud-readonly-migration-runtime-");
    const desired = { type: "remote", url: "http://127.0.0.1:4802/mcp/agent", enabled: true, headers: { Authorization: "Bearer token" }, oauth: false };
    await writeRuntimeOpencodeConfig(config, workspace.id, () => ({ mcp: { "openwork-cloud": desired } }));
    config.readOnly = true;

    expect(await migrateOpenworkCloudMcpRuntimeConfig(config)).toEqual({ config: desired, changed: false });
    expect((await readGlobalRuntimeOpencodeConfig(config)).mcp?.["openwork-cloud"]).toBeUndefined();
    expect((await readRuntimeOpencodeConfig(config, workspace.id)).mcp?.["openwork-cloud"]).toEqual(desired);
  });

  test("keeps delivery state independent for two directories sharing global desired state", () => {
    const store = new CloudMcpDeliveryStateStore();
    const workspaceB = { ...workspace, id: "ws_b", path: "/workspace-b" };
    const metadata = {
      token: { present: true, metadata: {} },
      connectCatalogEnabled: true,
      updatedAt: 1,
    };
    store.markDesired(workspace, workspace.path, "global-revision", metadata);
    store.markDesired(workspaceB, workspaceB.path, "global-revision", metadata);
    store.markReady(workspace, workspace.path, "global-revision");

    expect(store.snapshot(workspace, workspace.path, "global-revision").state).toBe("ready");
    expect(store.snapshot(workspaceB, workspaceB.path, "global-revision").state).toBe("pending");
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
          openwork_query: false,
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

  test("direct Cloud probe budget single-flights blocked concurrent checks but keeps sequential probes fresh", async () => {
    const harness = await setupDirectProbeHarness("ok");
    const checkCount = 6;
    const toolIds = harness.blockToolIds();
    const initialize = harness.blockInitialize();
    const checks = Array.from({ length: checkCount }, () => harness.read());

    await toolIds.waitForEntries(checkCount);
    toolIds.release();
    await initialize.waitForEntries(1);
    expect(harness.directOperations).toEqual(["initialize"]);
    initialize.release();

    const concurrent = await Promise.all(checks);
    const concurrentOperations = harness.directOperations.length;
    expect(concurrent.every((health) => health.usable)).toBe(true);
    expect(concurrentOperations).toBe(3);

    expect((await harness.read()).usable).toBe(true);
    expect(harness.directOperations).toHaveLength(6);
    console.info(`cloud-mcp-probe-operation-benchmark concurrent=${checkCount} pre=${checkCount * 3} post=${concurrentOperations} sequential_explicit=3`);
  });

  test("direct Cloud probe budget evicts an upstream 502 flight and retries the full handshake", async () => {
    const harness = await setupDirectProbeHarness("bad_gateway");

    const failed = await harness.read();
    expect(failed.firstFailure).toMatchObject({ code: "cloud_tools_missing", retryable: true });
    expect(failed.tools.direct.trace?.steps.at(-1)).toMatchObject({ step: "tools_list", ok: false, httpStatus: 502 });

    harness.setMode("ok");
    const recovered = await harness.read();

    expect(recovered.usable).toBe(true);
    expect(harness.directOperations).toEqual([
      "initialize", "notifications/initialized", "tools/list",
      "initialize", "notifications/initialized", "tools/list",
    ]);
  });

  test("direct Cloud probe budget keys flights by workspace and revision without provider or model fragmentation", async () => {
    const harness = await setupDirectProbeHarness("ok", ["ws_a", "ws_b"]);
    const workspaceA = harness.workspaces.find((entry) => entry.id === "ws_a");
    if (!workspaceA) throw new Error("ws_a missing from direct-probe harness");

    const providerToolIds = harness.blockToolIds();
    const providerInitialize = harness.blockInitialize();
    const providerChecks = [
      harness.read("ws_a", { provider: "anthropic", model: "claude" }),
      harness.read("ws_a", { provider: "openwork", model: "gpt-5" }),
    ];
    await providerToolIds.waitForEntries(2);
    providerToolIds.release();
    await providerInitialize.waitForEntries(1);
    expect(harness.directOperations).toEqual(["initialize"]);
    providerInitialize.release();
    await Promise.all(providerChecks);
    expect(harness.directOperations).toHaveLength(3);

    harness.directOperations.length = 0;
    const workspaceToolIds = harness.blockToolIds();
    const workspaceInitialize = harness.blockInitialize();
    const workspaceChecks = [harness.read("ws_a"), harness.read("ws_b")];
    await workspaceToolIds.waitForEntries(2);
    workspaceToolIds.release();
    await workspaceInitialize.waitForEntries(2);
    expect(harness.directOperations).toEqual(["initialize", "initialize"]);
    workspaceInitialize.release();
    await Promise.all(workspaceChecks);
    expect(harness.directOperations).toHaveLength(6);

    harness.directOperations.length = 0;
    const authToolIds = harness.blockToolIds();
    const authInitialize = harness.blockInitialize();
    const originalAuthCheck = harness.read("ws_a");
    await authToolIds.waitForEntries(1);
    authToolIds.release();
    await authInitialize.waitForEntries(1);
    const changedConfig = {
      ...harness.desiredConfig,
      headers: { Authorization: "Bearer owt_health_cloud_token_changed" },
    };
    await writeGlobalRuntimeOpencodeConfig(harness.config, (current) => ({
      ...current,
      mcp: { ...current.mcp, "openwork-cloud": changedConfig },
    }));
    const changedAuthToolIds = harness.blockToolIds();
    const changedAuthCheck = harness.read("ws_a");
    await changedAuthToolIds.waitForEntries(1);
    changedAuthToolIds.release();
    await authInitialize.waitForEntries(2);
    authInitialize.release();
    await Promise.all([originalAuthCheck, changedAuthCheck]);
    expect(harness.directOperations.filter((method) => method === "tools/list")).toHaveLength(2);

    harness.directOperations.length = 0;
    const orgAMetadata = {
      token: { present: true, metadata: { organizationId: "org_a" } },
      org: { id: "org_a" },
      connectCatalogEnabled: true,
      updatedAt: Date.now(),
    };
    const orgARevision = await calculateCloudMcpDesiredRevision(changedConfig, orgAMetadata);
    cloudMcpDeliveryState.markDesired(workspaceA, workspaceA.path, orgARevision, orgAMetadata);
    const orgAToolIds = harness.blockToolIds();
    const orgInitialize = harness.blockInitialize();
    const orgACheck = harness.read("ws_a");
    await orgAToolIds.waitForEntries(1);
    orgAToolIds.release();
    await orgInitialize.waitForEntries(1);
    const orgBMetadata = {
      token: { present: true, metadata: { organizationId: "org_b" } },
      org: { id: "org_b" },
      connectCatalogEnabled: true,
      updatedAt: Date.now(),
    };
    const orgBRevision = await calculateCloudMcpDesiredRevision(changedConfig, orgBMetadata);
    cloudMcpDeliveryState.markDesired(workspaceA, workspaceA.path, orgBRevision, orgBMetadata);
    const orgBToolIds = harness.blockToolIds();
    const orgBCheck = harness.read("ws_a");
    await orgBToolIds.waitForEntries(1);
    orgBToolIds.release();
    await orgInitialize.waitForEntries(2);
    orgInitialize.release();
    await Promise.all([orgACheck, orgBCheck]);
    expect(harness.directOperations.filter((method) => method === "tools/list")).toHaveLength(2);
  });

  test("direct Cloud probe budget heals a healthy same-revision delivery state", async () => {
    const harness = await setupDirectProbeHarness("ok");
    const first = await harness.read();
    const revision = first.desired.revision;
    if (!revision) throw new Error("direct-probe desired revision missing");
    cloudMcpDeliveryState.markRegistering(harness.primary, harness.primary.path, revision);

    const healed = await harness.read();

    expect(healed.delivery.state).toBe("ready");
    expect(healed.delivery.appliedRevision).toBe(revision);
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

  test("classifies missing MCP bearer status as remintable auth failure", async () => {
    const harness = await setupDirectProbeHarness("status_missing_token");
    const health = await harness.read();

    expect(health.usable).toBe(false);
    expect(health.firstFailure?.code).toBe("missing_mcp_token");
    expect(health.firstFailure?.aliases).toContain("openwork_cloud_auth_required");
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
