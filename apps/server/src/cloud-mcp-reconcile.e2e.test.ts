import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OPENWORK_CLOUD_EXPECTED_TOOLS, OPENWORK_CLOUD_PLUGIN_CANARIES, cloudMcpDeliveryState } from "./cloud-mcp-health.js";
import { readRuntimeOpencodeConfig, writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import { startServer } from "./server.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

type EngineRequest = {
  method: string;
  pathname: string;
  search: string;
  body: unknown;
};

type MockOpencodeOptions = {
  toolIds?: string[];
  providerToolIds?: string[];
  cloudToolNames?: string[];
  cloudToolsAsSse?: boolean;
  providerToolCalling?: boolean;
  providerModelExists?: boolean;
  unsupportedToolIds?: boolean;
  initialConnected?: boolean;
  hangHealth?: boolean;
  delayMcpStatusMs?: number;
  postFailure?: { status: number; body: unknown };
};

type CloudConfig = {
  type: "remote";
  url: string;
  enabled: true;
  headers: { Authorization: string };
  oauth: false;
};

const CLIENT_TOKEN = "owt_cloud_mcp_client";
const HOST_TOKEN = "owt_cloud_mcp_host";
const previousRuntimeDb = process.env.OPENWORK_RUNTIME_DB;
const stops: Array<() => void | Promise<void>> = [];
const roots: string[] = [];
const runtimeDbRoots: string[] = [];
const cloudConfigsByOpenworkBase = new Map<string, CloudConfig>();

afterEach(async () => {
  cloudMcpDeliveryState.clear();
  while (stops.length) await stops.pop()?.();
  while (roots.length) await rm(roots.pop() ?? "", { recursive: true, force: true });
  if (process.platform === "win32") {
    // Bun keeps runtime-opencode-config-store SQLite handles open for the process lifetime on Windows.
    // Skip only those DB temp dirs; workspace roots and mock servers are still cleaned every test.
    runtimeDbRoots.length = 0;
  } else {
    while (runtimeDbRoots.length) await rm(runtimeDbRoots.pop() ?? "", { recursive: true, force: true });
  }
  cloudConfigsByOpenworkBase.clear();
  if (previousRuntimeDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
  else process.env.OPENWORK_RUNTIME_DB = previousRuntimeDb;
});

async function createRoot(prefix = "openwork-cloud-mcp-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function createRuntimeDbRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "openwork-cloud-mcp-runtime-"));
  runtimeDbRoots.push(root);
  return root;
}

function allReadyToolIds(): string[] {
  return [...OPENWORK_CLOUD_EXPECTED_TOOLS, ...OPENWORK_CLOUD_PLUGIN_CANARIES];
}

function startMockOpencode(options: MockOpencodeOptions = {}) {
  const requests: EngineRequest[] = [];
  let registerCount = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = request.method === "POST" ? await request.json().catch(() => null) : null;
      requests.push({ method: request.method, pathname: url.pathname, search: url.search, body });

      if (url.pathname === "/global/health") {
        if (options.hangHealth) return await new Promise<Response>(() => {});
        return Response.json({ healthy: true, version: "1.17.11" });
      }
      if (url.pathname === "/instance/dispose") return Response.json({ disposed: true });
      if (url.pathname === "/mcp" && request.method === "POST") {
        if (options.postFailure) return Response.json(options.postFailure.body, { status: options.postFailure.status });
        registerCount += 1;
        return Response.json({});
      }
      if (url.pathname === "/mcp" && request.method === "GET") {
        if (options.delayMcpStatusMs) await new Promise((resolve) => setTimeout(resolve, options.delayMcpStatusMs));
        return Response.json(registerCount > 0 || options.initialConnected ? { "openwork-cloud": { status: "connected" } } : {});
      }
      if (url.pathname === "/experimental/tool/ids") {
        if (options.unsupportedToolIds) return Response.json({ code: "not_found" }, { status: 404 });
        return Response.json(options.toolIds ?? allReadyToolIds());
      }
      if (url.pathname === "/experimental/tool") {
        const ids = options.providerToolIds ?? options.toolIds ?? allReadyToolIds();
        return Response.json(ids.map((id) => ({ id, description: id, parameters: {} })));
      }
      if (url.pathname === "/provider") {
        const toolcall = options.providerToolCalling ?? true;
        const models = options.providerModelExists === false
          ? {}
          : {
              "claude-sonnet-4": { id: "claude-sonnet-4", providerID: "anthropic", name: "Claude Sonnet", capabilities: { toolcall } },
              claude: { id: "claude", providerID: "anthropic", name: "Claude", capabilities: { toolcall } },
              "gpt-5": { id: "gpt-5", providerID: "openwork", name: "GPT-5", capabilities: { toolcall } },
            };
        return Response.json({
          all: [
            { id: "anthropic", name: "Anthropic", source: "config", env: [], options: {}, models },
            { id: "openwork", name: "OpenWork", source: "config", env: [], options: {}, models },
          ],
          default: {},
          connected: ["anthropic", "openwork"],
        });
      }
      if (url.pathname.endsWith("/mcp/agent") && request.method === "POST") {
        if (request.headers.get("authorization") !== "Bearer owt_secret_cloud_token") {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
        const rpc = isRecord(body) ? body : {};
        if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
        const id = rpc.id ?? 1;
        const result = rpc.method === "initialize"
          ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "openwork-cloud-test", version: "1.0.0" } }
          : rpc.method === "tools/list"
            ? { tools: (options.cloudToolNames ?? ["search_capabilities", "execute_capability"]).map((name) => ({ name, description: name, inputSchema: {} })) }
            : {};
        const payload = { jsonrpc: "2.0", id, result };
        if (options.cloudToolsAsSse && rpc.method === "tools/list") {
          return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
            headers: { "content-type": "text/event-stream" },
          });
        }
        return Response.json(payload, {
          headers: rpc.method === "initialize"
            ? { "mcp-session-id": "session_12345678901234567890", "mcp-protocol-version": "2025-06-18" }
            : {},
        });
      }
      return Response.json({ code: "not_found" }, { status: 404 });
    },
  });
  stops.push(() => server.stop(true));
  return { server, requests };
}

function workspace(id: string, path: string, baseUrl: string, extra?: Partial<WorkspaceInfo>): WorkspaceInfo {
  return {
    id,
    name: id,
    path,
    preset: "starter",
    workspaceType: "local",
    baseUrl,
    ...extra,
  };
}

async function startOpenwork(workspaces: WorkspaceInfo[]): Promise<{ base: string; config: ServerConfig }> {
  const runtimeRoot = await createRuntimeDbRoot();
  process.env.OPENWORK_RUNTIME_DB = join(runtimeRoot, "runtime.sqlite");
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: CLIENT_TOKEN,
    hostToken: HOST_TOKEN,
    configPath: join(runtimeRoot, "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces,
    authorizedRoots: workspaces.map((item) => item.path),
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  const server = await startServer(config);
  stops.push(() => server.stop());
  const base = `http://127.0.0.1:${server.port}`;
  cloudConfigsByOpenworkBase.set(base, cloudConfig(cloudUrlFromBase(workspaces[0]?.baseUrl)));
  return { base, config };
}

function headers(): Record<string, string> {
  return { Authorization: `Bearer ${CLIENT_TOKEN}`, "Content-Type": "application/json" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (isRecord(value)) return value;
  throw new Error(`${label} was not an object`);
}

function requireArray(value: unknown, label: string): unknown[] {
  if (Array.isArray(value)) return value;
  throw new Error(`${label} was not an array`);
}

async function responseRecord(response: Response): Promise<Record<string, unknown>> {
  return requireRecord(await response.json(), "response");
}

function expectDirectoryQuery(search: string | undefined, directory: string): void {
  if (search === undefined) throw new Error("request search was missing");
  expect(new URLSearchParams(search).getAll("directory")).toEqual([directory]);
}

function firstFailure(body: Record<string, unknown>): Record<string, unknown> {
  return requireRecord(body.firstFailure, "firstFailure");
}

function delivery(body: Record<string, unknown>): Record<string, unknown> {
  return requireRecord(body.delivery, "delivery");
}

const CLOUD_CONFIG: CloudConfig = {
  type: "remote",
  url: "https://api.openworklabs.com/mcp/agent",
  enabled: true,
  headers: { Authorization: "Bearer owt_secret_cloud_token" },
  oauth: false,
};

function cloudConfig(url: string): CloudConfig {
  return { ...CLOUD_CONFIG, url };
}

function cloudUrlFromBase(baseUrl: string | undefined): string {
  if (!baseUrl) return CLOUD_CONFIG.url;
  return new URL("/mcp/agent", baseUrl).toString();
}

function cloudConfigForOpenwork(base: string): CloudConfig {
  return cloudConfigsByOpenworkBase.get(base) ?? CLOUD_CONFIG;
}

async function reconcile(base: string, workspaceId = "ws_1", body: Record<string, unknown> = {}): Promise<Response> {
  const config = body.config ?? cloudConfigsByOpenworkBase.get(base) ?? CLOUD_CONFIG;
  return fetch(`${base}/workspace/${workspaceId}/mcp/openwork-cloud/reconcile`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ config, ...body }),
  });
}

async function getHealth(base: string, workspaceId = "ws_1", query = ""): Promise<Response> {
  return fetch(`${base}/workspace/${workspaceId}/mcp/openwork-cloud/health${query}`, { headers: headers() });
}

describe("openwork-cloud MCP strict reconcile", () => {
  test("clean ready persists desired config, verifies tools, and redacts the token", async () => {
    const root = await createRoot();
    const mock = startMockOpencode();
    const openwork = await startOpenwork([workspace("ws_1", root, `http://127.0.0.1:${mock.server.port}`)]);

    const response = await reconcile(openwork.base, "ws_1", {
      tokenMetadata: { expiresAt: "2026-07-13T00:00:00.000Z" },
      org: { id: "org_1", name: "Acme" },
      provider: "anthropic",
      model: "claude-sonnet-4",
      trigger: "test",
    });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).not.toContain("owt_secret_cloud_token");
    expect(text).not.toContain("Bearer owt_secret_cloud_token");

    const body = requireRecord(JSON.parse(text), "health");
    expect(body.phase).toBe("ready");
    expect(body.usable).toBe(true);
    expect(body.usableByCurrentModel).toBe(true);
    const tools = requireRecord(body.tools, "tools");
    expect(requireArray(tools.present, "tools.present").sort()).toEqual([...OPENWORK_CLOUD_EXPECTED_TOOLS].sort());
    expect(requireRecord(tools.direct, "tools.direct")).toMatchObject({
      checked: true,
      present: ["search_capabilities", "execute_capability"],
      missing: [],
    });
    expect(requireRecord(tools.providerProjection, "providerProjection")).toMatchObject({
      source: "experimental_tool",
      missing: [],
    });
    expect(delivery(body).appliedRevision).toBe(delivery(body).desiredRevision);
    expect(requireRecord(body.workspace, "workspace").directory).toBe(root);
    expect(requireRecord(requireRecord(body.compatibility, "compatibility").opencode, "opencode").actualVersion).toBe("1.17.11");
    expect(requireRecord(requireRecord(body.compatibility, "compatibility").opencode, "opencode").expectedVersion).toBeTruthy();
    expect(requireRecord(requireRecord(body.compatibility, "compatibility").experimentalToolIds, "experimentalToolIds")).toMatchObject({ includesMcpTools: true });
    expect(requireRecord(requireRecord(body.compatibility, "compatibility").experimentalProviderTools, "experimentalProviderTools")).toMatchObject({ includesMcpTools: true });
    expect((await readRuntimeOpencodeConfig(openwork.config, "ws_1")).mcp?.["openwork-cloud"]?.url).toBe(cloudConfigForOpenwork(openwork.base).url);

    const mcpPosts = mock.requests.filter((request) => request.method === "POST" && request.pathname === "/mcp");
    expect(mcpPosts.length).toBe(1);
    expectDirectoryQuery(mcpPosts[0]?.search, root);
  });

  test("rejects malformed desired config without persisting or registering it", async () => {
    const root = await createRoot();
    const mock = startMockOpencode();
    const openwork = await startOpenwork([workspace("ws_1", root, `http://127.0.0.1:${mock.server.port}`)]);

    const cases: Array<{ config: Record<string, unknown>; code: string }> = [
      { config: { ...CLOUD_CONFIG, url: "https://api.openworklabs.com/mcp" }, code: "cloud_endpoint_invalid" },
      { config: { ...CLOUD_CONFIG, enabled: false }, code: "cloud_mcp_disabled" },
      { config: { ...CLOUD_CONFIG, headers: {} }, code: "invalid_mcp_token" },
      { config: { ...CLOUD_CONFIG, oauth: {} }, code: "invalid_mcp_token" },
    ];

    for (const item of cases) {
      const body = await responseRecord(await reconcile(openwork.base, "ws_1", { config: item.config }));
      expect(firstFailure(body).code).toBe(item.code);
      expect(firstFailure(body).stage).toBe("desired_config");
    }

    const mismatch = await responseRecord(await reconcile(openwork.base, "ws_1", {
      tokenMetadata: { organizationId: "org_token" },
      org: { id: "org_active" },
    }));
    expect(firstFailure(mismatch).code).toBe("cloud_token_org_mismatch");
    expect(firstFailure(mismatch).stage).toBe("desired_config");

    expect((await readRuntimeOpencodeConfig(openwork.config, "ws_1")).mcp?.["openwork-cloud"]).toBeUndefined();
    expect(mock.requests.some((request) => request.method === "POST" && request.pathname === "/mcp")).toBe(false);
  });

  test("normalizes a harmless trailing slash on the Cloud MCP endpoint", async () => {
    const root = await createRoot();
    const mock = startMockOpencode();
    const openwork = await startOpenwork([workspace("ws_1", root, `http://127.0.0.1:${mock.server.port}`)]);
    const url = `http://127.0.0.1:${mock.server.port}/api/den/mcp/agent/`;

    const body = await responseRecord(await reconcile(openwork.base, "ws_1", {
      config: { ...CLOUD_CONFIG, url },
    }));
    expect(body.phase).toBe("ready");
    expect((await readRuntimeOpencodeConfig(openwork.config, "ws_1")).mcp?.["openwork-cloud"]?.url).toBe(url.slice(0, -1));
  });

  test("GET health reports persisted malformed desired config even when the engine looks live", async () => {
    const root = await createRoot();
    const mock = startMockOpencode({ initialConnected: true });
    const openwork = await startOpenwork([workspace("ws_1", root, `http://127.0.0.1:${mock.server.port}`)]);
    await writeRuntimeOpencodeConfig(openwork.config, "ws_1", (current) => ({
      ...current,
      mcp: { "openwork-cloud": { ...CLOUD_CONFIG, url: "https://api.openworklabs.com/mcp" } },
    }));

    const body = await responseRecord(await getHealth(openwork.base));
    expect(body.usable).toBe(false);
    expect(firstFailure(body).code).toBe("cloud_endpoint_invalid");
    expect(firstFailure(body).stage).toBe("desired_config");
  });

  test("GET health safely adopts a live exact match before reporting ready", async () => {
    const root = await createRoot();
    const mock = startMockOpencode({ initialConnected: true });
    const openwork = await startOpenwork([workspace("ws_1", root, `http://127.0.0.1:${mock.server.port}`)]);
    await writeRuntimeOpencodeConfig(openwork.config, "ws_1", (current) => ({
      ...current,
      mcp: { "openwork-cloud": cloudConfigForOpenwork(openwork.base) },
    }));

    const body = await responseRecord(await getHealth(openwork.base));
    expect(body.phase).toBe("ready");
    expect(body.usable).toBe(true);
    expect(delivery(body).appliedRevision).toBe(delivery(body).desiredRevision);
  });

  test("GET health runs the direct Cloud endpoint probe only when requested", async () => {
    const root = await createRoot();
    const mock = startMockOpencode({ initialConnected: true });
    const openwork = await startOpenwork([workspace("ws_1", root, `http://127.0.0.1:${mock.server.port}`)]);
    await writeRuntimeOpencodeConfig(openwork.config, "ws_1", (current) => ({
      ...current,
      mcp: { "openwork-cloud": cloudConfigForOpenwork(openwork.base) },
    }));

    const defaultBody = await responseRecord(await getHealth(openwork.base));
    expect(defaultBody.phase).toBe("ready");
    expect(mock.requests.filter((request) => request.pathname.endsWith("/mcp/agent")).length).toBe(0);

    const probedBody = await responseRecord(await getHealth(openwork.base, "ws_1", "?probe=1"));
    expect(probedBody.phase).toBe("ready");
    expect(mock.requests.filter((request) => request.pathname.endsWith("/mcp/agent")).length).toBeGreaterThan(0);
  });

  test("health probe timeout is bounded", async () => {
    const previousTimeout = process.env.OPENWORK_CLOUD_MCP_PROBE_TIMEOUT_MS;
    process.env.OPENWORK_CLOUD_MCP_PROBE_TIMEOUT_MS = "25";
    try {
      const root = await createRoot();
      const mock = startMockOpencode({ initialConnected: true, delayMcpStatusMs: 100 });
      const openwork = await startOpenwork([workspace("ws_1", root, `http://127.0.0.1:${mock.server.port}`)]);
      await writeRuntimeOpencodeConfig(openwork.config, "ws_1", (current) => ({
        ...current,
        mcp: { "openwork-cloud": cloudConfigForOpenwork(openwork.base) },
      }));

      const body = await responseRecord(await getHealth(openwork.base));
      expect(body.usable).toBe(false);
      expect(firstFailure(body).code).toBe("opencode_engine_unreachable");
    } finally {
      if (previousTimeout === undefined) delete process.env.OPENWORK_CLOUD_MCP_PROBE_TIMEOUT_MS;
      else process.env.OPENWORK_CLOUD_MCP_PROBE_TIMEOUT_MS = previousTimeout;
    }
  });

  test("unreachable engine leaves desired config persisted but not applied", async () => {
    const root = await createRoot();
    const openwork = await startOpenwork([workspace("ws_1", root, "http://127.0.0.1:9")]);

    const response = await reconcile(openwork.base);
    const body = await responseRecord(response);
    expect(response.status).toBe(200);
    expect(firstFailure(body).code).toBe("opencode_mcp_sync_failed");
    expect(delivery(body).appliedRevision).toBeNull();
    expect((await readRuntimeOpencodeConfig(openwork.config, "ws_1")).mcp?.["openwork-cloud"]?.url).toBe(cloudConfigForOpenwork(openwork.base).url);
  });

  test("uses the exact secondary workspace directory", async () => {
    const rootA = await createRoot("openwork-cloud-primary-");
    const rootB = await createRoot("openwork-cloud-secondary-");
    const mock = startMockOpencode();
    const baseUrl = `http://127.0.0.1:${mock.server.port}`;
    const openwork = await startOpenwork([
      workspace("ws_1", rootA, baseUrl),
      workspace("ws_2", rootB, baseUrl),
    ]);

    const response = await reconcile(openwork.base, "ws_2");
    const body = await responseRecord(response);
    expect(body.phase).toBe("ready");
    const post = mock.requests.find((request) => request.method === "POST" && request.pathname === "/mcp");
    expectDirectoryQuery(post?.search, rootB);
  });

  test("uses an explicit remote workspace directory and refuses ambiguous remotes", async () => {
    const root = await createRoot();
    const explicitDirectory = join(root, "remote-project");
    const mock = startMockOpencode();
    const baseUrl = `http://127.0.0.1:${mock.server.port}`;
    const openwork = await startOpenwork([
      workspace("ws_remote", root, baseUrl, { workspaceType: "remote", directory: explicitDirectory }),
      workspace("ws_ambiguous", root, baseUrl, { workspaceType: "remote" }),
    ]);

    const ready = await reconcile(openwork.base, "ws_remote");
    expect((await responseRecord(ready)).phase).toBe("ready");
    expectDirectoryQuery(mock.requests.find((request) => request.method === "POST" && request.pathname === "/mcp")?.search, explicitDirectory);

    const ambiguous = await reconcile(openwork.base, "ws_ambiguous");
    const body = await responseRecord(ambiguous);
    expect(firstFailure(body).code).toBe("workspace_directory_ambiguous");
    expect(delivery(body).appliedRevision).toBeNull();
  });

  test("connected engine with direct Cloud endpoint missing a tool reports cloud_tools_missing without re-registering", async () => {
    const root = await createRoot();
    const mock = startMockOpencode({ cloudToolNames: ["search_capabilities"] });
    const openwork = await startOpenwork([workspace("ws_1", root, `http://127.0.0.1:${mock.server.port}`)]);

    const body = await responseRecord(await reconcile(openwork.base));
    expect(firstFailure(body).code).toBe("cloud_tools_missing");
    expect(requireRecord(requireRecord(body.tools, "tools").direct, "direct").missing).toEqual(["execute_capability"]);
    expect(requireArray(requireRecord(body.tools, "tools").present, "tools.present")).toEqual([]);
    expect(mock.requests.filter((request) => request.method === "POST" && request.pathname === "/mcp").length).toBe(1);
  });

  test("current OpenCode engines that exclude MCP tool IDs use direct tools/list plus provider capability", async () => {
    const root = await createRoot();
    const mock = startMockOpencode({
      toolIds: [...OPENWORK_CLOUD_PLUGIN_CANARIES],
      providerToolIds: [...OPENWORK_CLOUD_PLUGIN_CANARIES],
      cloudToolsAsSse: true,
    });
    const openwork = await startOpenwork([workspace("ws_1", root, `http://127.0.0.1:${mock.server.port}`)]);

    const body = await responseRecord(await reconcile(openwork.base, "ws_1", { provider: "anthropic", model: "claude" }));
    expect(body.phase).toBe("ready");
    expect(body.usable).toBe(true);
    expect(body.usableByCurrentModel).toBe(true);
    expect(requireRecord(requireRecord(body.compatibility, "compatibility").experimentalToolIds, "experimentalToolIds")).toMatchObject({ includesMcpTools: false });
    expect(requireRecord(requireRecord(body.compatibility, "compatibility").experimentalProviderTools, "experimentalProviderTools")).toMatchObject({ includesMcpTools: false });
    expect(requireRecord(requireRecord(body.tools, "tools").providerProjection, "projection")).toMatchObject({
      source: "provider_capability",
      modelExists: true,
      toolCalling: true,
      missing: [...OPENWORK_CLOUD_EXPECTED_TOOLS],
    });
    expect(requireArray(requireRecord(body.tools, "tools").present, "tools.present").sort()).toEqual([...OPENWORK_CLOUD_EXPECTED_TOOLS].sort());
  });

  test("reports provider projection missing when fallback provider model lacks tool calling", async () => {
    const root = await createRoot();
    const mock = startMockOpencode({
      toolIds: [...OPENWORK_CLOUD_PLUGIN_CANARIES],
      providerToolIds: [...OPENWORK_CLOUD_PLUGIN_CANARIES],
      providerToolCalling: false,
    });
    const openwork = await startOpenwork([workspace("ws_1", root, `http://127.0.0.1:${mock.server.port}`)]);

    const body = await responseRecord(await reconcile(openwork.base, "ws_1", { provider: "anthropic", model: "claude" }));
    expect(firstFailure(body).code).toBe("provider_tool_projection_missing");
    expect(firstFailure(body).recommendedAction).toBe("Choose a model that can use OpenWork Cloud tools");
    expect(requireRecord(requireRecord(body.tools, "tools").providerProjection, "projection")).toMatchObject({
      source: "provider_capability",
      modelExists: true,
      toolCalling: false,
      missing: [...OPENWORK_CLOUD_EXPECTED_TOOLS],
    });
  });

  test("reports extension canary missing when docs canary is present but extension canary is absent", async () => {
    const root = await createRoot();
    const mock = startMockOpencode({ toolIds: [...OPENWORK_CLOUD_EXPECTED_TOOLS, "openwork_docs_search"] });
    const openwork = await startOpenwork([workspace("ws_1", root, `http://127.0.0.1:${mock.server.port}`)]);

    const body = await responseRecord(await reconcile(openwork.base));
    expect(firstFailure(body).code).toBe("extensions_plugin_missing");
    expect(requireArray(requireRecord(body.pluginCanaries, "pluginCanaries").missing, "missing")).toContain("openwork_extension_list_actions");
  });

  test("old engines without tool.ids return Update OpenWork guidance", async () => {
    const root = await createRoot();
    const mock = startMockOpencode({ unsupportedToolIds: true });
    const openwork = await startOpenwork([workspace("ws_1", root, `http://127.0.0.1:${mock.server.port}`)]);

    const body = await responseRecord(await reconcile(openwork.base));
    expect(firstFailure(body).code).toBe("opencode_tool_ids_unsupported");
    expect(firstFailure(body).recommendedAction).toBe("Update OpenWork");
  });

  test("health detects project tool denies while generic MCP add remains best-effort", async () => {
    const root = await createRoot();
    await writeFile(join(root, "opencode.jsonc"), JSON.stringify({ tools: { deny: ["openwork-cloud_*"] } }), "utf8");
    const mock = startMockOpencode();
    const openwork = await startOpenwork([workspace("ws_1", root, `http://127.0.0.1:${mock.server.port}`)]);

    const strictBody = await responseRecord(await reconcile(openwork.base));
    expect(firstFailure(strictBody).code).toBe("cloud_tools_denied");
    expect(requireArray(strictBody.toolDenies, "toolDenies").length).toBeGreaterThan(0);

    const generic = await fetch(`${openwork.base}/workspace/ws_1/mcp`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ name: "posthog", config: { type: "remote", url: "https://mcp.posthog.com/mcp", enabled: true } }),
    });
    expect(generic.status).toBe(200);
    const genericBody = await responseRecord(generic);
    expect(requireArray(genericBody.items, "items").some((item) => isRecord(item) && item.name === "posthog")).toBe(true);
  });
});
