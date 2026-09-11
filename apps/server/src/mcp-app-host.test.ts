import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createCipheriv, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { addMcp, listMcp } from "./mcp.js";
import {
  CONNECT_MCP_SERVER_INDEX_URI,
  connectMcpAppHostName,
  readOpenWorkConnectMcpAppHostCatalog,
  writeOpenWorkConnectMcpAppHostAuthorization,
  writeOpenWorkConnectMcpAppHostCatalog,
} from "./connect-mcp-server-catalog.js";
import { ENGINE_GLOBAL_RUNTIME_CONFIG_ID, readRuntimeOpencodeConfig, runtimeMcpMap, writeRuntimeOpencodeConfig, writeGlobalRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import {
  callMcpAppTool,
  listMcpAppCatalog,
  listMcpServerTools,
  searchWorkspaceCapabilities,
  McpAppHostError,
  projectedMcpToolName,
  resolveConnectMcpAppResource,
  resolveMcpAppResource,
  resolveSameServerMcpAppResource,
  releaseMcpAppLaunch,
  toolUiResourceUri,
} from "./mcp-app-host.js";
import type { ServerConfig } from "./types.js";
import { localManagedMcpAppIdentity } from "./local-managed-mcp.js";

const WORKSPACE_ID = "ws_mcp_apps_host";
const RESOURCE_URI = "ui://fixture/v1/view.html";
const UPDATED_RESOURCE_URI = "ui://fixture/v2/view.html";
const RESOURCE_HTML = "<!doctype html><html><head></head><body>Fixture</body></html>";
const UPDATED_RESOURCE_HTML = "<!doctype html><html><head></head><body>Updated fixture</body></html>";
const stops: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (stops.length) await stops.pop()?.();
});

function serverConfig(root: string): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    token: "token",
    hostToken: "host-token",
    configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 0 },
    corsOrigins: [],
    workspaces: [{ id: WORKSPACE_ID, name: "Test", path: root, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "generated",
    hostTokenSource: "generated",
    logFormat: "pretty",
    logRequests: false,
  };
}

async function startFixtureMcp(
  resourceContent: { text?: string; blob?: string } = { text: RESOURCE_HTML },
  connectionId?: string,
) {
  let activeResourceUri = RESOURCE_URI;
  let catalogReads = 0;
  const calls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
  let launchVisible = true;
  let launchPresent = true;
  const mcp = new Server(
    { name: "mcp-app-fixture", version: "1.0.0" },
    {
      capabilities: {
        tools: {},
        resources: {},
        extensions: {
          "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] },
        },
      },
    },
  );
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "search_capabilities",
        inputSchema: { type: "object", properties: { query: { type: "string" } } },
        annotations: { readOnlyHint: true, destructiveHint: false },
      },
      {
        name: "render_fixture",
        description: "Render the fixture",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true, destructiveHint: false },
        _meta: { ui: { resourceUri: activeResourceUri, visibility: launchVisible ? ["model", "app"] : ["model"] } },
      },
      {
        name: "render_missing",
        description: "Render a missing fixture resource",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true, destructiveHint: false },
        _meta: { ui: { resourceUri: "ui://fixture/missing/view.html", visibility: ["model", "app"] } },
      },
      {
        name: "save_artifact_view",
        description: "Save fixture state without rendering it",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: false, destructiveHint: false },
      },
      {
        name: "render_report",
        description: "Render a report for one fixture id",
        inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        annotations: { readOnlyHint: true, destructiveHint: false },
        _meta: { ui: { resourceUri: activeResourceUri, visibility: ["model", "app"] } },
      },
      {
        name: "render_editor",
        description: "Render an editor that writes fixture state",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: false, destructiveHint: false },
        _meta: { ui: { resourceUri: activeResourceUri, visibility: ["model", "app"] } },
      },
      {
        name: "read_detail",
        description: "Read fixture detail",
        inputSchema: { type: "object", properties: { id: { type: "string" } } },
        annotations: { readOnlyHint: true, destructiveHint: false },
        _meta: { ui: { visibility: ["app"] } },
      },
      {
        name: "read_bound_detail",
        description: "Read detail for the exact fixture resource",
        inputSchema: { type: "object", properties: { id: { type: "string" } } },
        annotations: { readOnlyHint: true, destructiveHint: false },
        _meta: { ui: { resourceUri: RESOURCE_URI, visibility: ["app"] } },
      },
      {
        name: "model_only_fixture",
        description: "A model-only fixture tool",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true, destructiveHint: false },
        _meta: { ui: { visibility: ["model"] } },
      },
      {
        name: "write_detail",
        description: "Write fixture detail",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: false, destructiveHint: true },
      },
    ].filter(tool => launchPresent || tool.name !== "render_fixture"),
  }));
  mcp.setRequestHandler(ReadResourceRequestSchema, async ({ params }) => {
    if (params.uri !== RESOURCE_URI && params.uri !== UPDATED_RESOURCE_URI) throw new Error("not found");
    const content = params.uri === UPDATED_RESOURCE_URI ? { text: UPDATED_RESOURCE_HTML } : resourceContent;
    return {
      contents: [{
        uri: params.uri,
        mimeType: "text/html;profile=mcp-app",
        ...content,
        _meta: {
          ui: {
            csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
            prefersBorder: true,
          },
        },
      }],
    };
  });
  mcp.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    calls.push(params);
    if (params.name === "render_report" && typeof params.arguments?.id !== "string") {
      // A control character and an oversized tail model a hostile provider;
      // the host must relay neither verbatim.
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid arguments for tool render_report: [{"path":["id"],"message":"Required"}]\u0007 ${"x".repeat(2_000)}`,
      );
    }
    return {
      content: [{ type: "text", text: `detail:${String(params.arguments?.id ?? "")}` }],
      structuredContent: { id: params.arguments?.id ?? null },
    };
  });

  let transport: WebStandardStreamableHTTPServerTransport;
  let serverOrigin = "";
  const http = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request): Promise<Response> => {
      if (new URL(request.url).pathname !== "/catalog" || !connectionId) {
        if (request.method === "POST") {
          const body = await request.clone().json();
          if (body.method === "initialize") await reconnect();
        }
        return await transport.handleRequest(request);
      }
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const body: unknown = await request.json();
      const method = body && typeof body === "object" ? Reflect.get(body, "method") : null;
      const id = body && typeof body === "object" ? Reflect.get(body, "id") : null;
      if (method === "initialize") {
        return Response.json({
          jsonrpc: "2.0",
          id,
          result: { protocolVersion: "2025-06-18", capabilities: { resources: {} } },
        });
      }
      if (method === "notifications/initialized") return new Response(null, { status: 202 });
      if (method === "resources/read") {
        catalogReads += 1;
        return Response.json({
          jsonrpc: "2.0",
          id,
          result: {
            contents: [{
              uri: CONNECT_MCP_SERVER_INDEX_URI,
              mimeType: "application/json",
              text: JSON.stringify({
                schemaVersion: "openwork.connect/mcp-servers/1",
                servers: [{
                  connectionId,
                  name: "Fixture provider",
                  description: null,
                  url: `${serverOrigin}/provider`,
                }],
              }),
            }],
          },
        });
      }
      return new Response(null, { status: 404 });
    },
  });
  serverOrigin = `http://127.0.0.1:${http.port}`;
  const reconnect = async () => {
    await mcp.close();
    transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      enableJsonResponse: true,
      enableDnsRebindingProtection: true,
      allowedHosts: [`127.0.0.1:${http.port}`, `localhost:${http.port}`],
    });
    await mcp.connect(transport);
  };
  await reconnect();
  stops.push(async () => {
    await mcp.close();
    http.stop(true);
  });
  return {
    url: `${serverOrigin}/provider`,
    catalogUrl: `${serverOrigin}/catalog`,
    catalogReads: () => catalogReads,
    calls,
    hideLaunch: () => { launchVisible = false; },
    removeLaunch: () => { launchPresent = false; },
    activateUpdatedResource: async () => {
      activeResourceUri = UPDATED_RESOURCE_URI;
      // A stateful SDK server transport owns one initialized MCP session. The
      // host deliberately creates a fresh client for each exact resolution,
      // so reset the fixture transport before exercising the second lookup.
      await reconnect();
    },
  };
}

async function configuredFixture(
  prefix: string,
  resourceContent?: { text?: string; blob?: string },
  mcpName = "fixture",
  connectionId?: string,
): Promise<{
  config: ServerConfig;
  root: string;
  activateUpdatedResource: () => Promise<void>;
  catalogReads: () => number;
  calls: Array<{ name: string; arguments?: Record<string, unknown> }>;
  hideLaunch: () => void;
  removeLaunch: () => void;
}> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const previousRuntimeDb = process.env.OPENWORK_RUNTIME_DB;
  const previousDevMode = process.env.OPENWORK_DEV_MODE;
  const previousConfigDir = process.env.OPENCODE_CONFIG_DIR;
  process.env.OPENCODE_CONFIG_DIR = join(root, "isolated-opencode");
  process.env.OPENWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  process.env.OPENWORK_DEV_MODE = "1";
  stops.push(async () => {
    if (previousRuntimeDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
    else process.env.OPENWORK_RUNTIME_DB = previousRuntimeDb;
    if (previousDevMode === undefined) delete process.env.OPENWORK_DEV_MODE;
    else process.env.OPENWORK_DEV_MODE = previousDevMode;
    if (previousConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = previousConfigDir;
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, ".git"), { recursive: true });
  const config = serverConfig(root);
  const fixture = await startFixtureMcp(resourceContent, connectionId);
  const mcpConfig = {
    type: "remote",
    url: fixture.url,
    enabled: true,
  };
  if (connectionId) {
    if (connectMcpAppHostName(connectionId) !== mcpName) throw new Error("invalid private App-host fixture");
    await writeRuntimeOpencodeConfig(config, WORKSPACE_ID, (current) => ({
      ...current,
      mcp: {
        ...runtimeMcpMap(current),
        "openwork-cloud": {
          ...mcpConfig,
          url: fixture.catalogUrl,
          headers: { Authorization: "Bearer member-token" },
        },
      },
    }));
    await writeOpenWorkConnectMcpAppHostCatalog(config, WORKSPACE_ID, {
      schemaVersion: "openwork.connect/mcp-servers/1",
      servers: [{ connectionId, name: "Fixture provider", description: null, url: fixture.url }],
    });
    await writeOpenWorkConnectMcpAppHostAuthorization(
      config,
      WORKSPACE_ID,
      "Bearer app-host-token",
      fixture.catalogUrl,
    );
  } else if (mcpName === "openwork-cloud") {
    await writeRuntimeOpencodeConfig(config, WORKSPACE_ID, (current) => ({ ...current, mcp: { ...runtimeMcpMap(current), [mcpName]: mcpConfig } }));
  } else {
    await addMcp(config, WORKSPACE_ID, mcpName, mcpConfig);
  }
  return {
    config,
    root,
    activateUpdatedResource: fixture.activateUpdatedResource,
    catalogReads: fixture.catalogReads,
    calls: fixture.calls,
    hideLaunch: fixture.hideLaunch,
    removeLaunch: fixture.removeLaunch,
  };
}

async function fixtureLaunch(config: ServerConfig, root: string) {
  const app = await resolveMcpAppResource({
    serverConfig: config, workspaceId: WORKSPACE_ID, workspaceRoot: root,
    projectedToolName: "fixture_render_fixture", context: { sessionId: "session-a", readOnly: false },
  });
  if (!app?.launchId) throw new Error("Fixture launch missing");
  return { launchId: app.launchId, sessionId: "session-a", resourceUri: app.resourceUri, assertSessionActive: async () => {} };
}

describe("MCP Apps host transport", () => {
  test("uses OpenCode's exact projected MCP tool naming", () => {
    expect(projectedMcpToolName("sales force", "render.pipeline")).toBe("sales_force_render_pipeline");
    expect(toolUiResourceUri({ _meta: { ui: { resourceUri: RESOURCE_URI } } })).toBe(RESOURCE_URI);
  });

  test("negotiates and resolves one fixed remote MCP App fixture", async () => {
    const { config, root } = await configuredFixture("openwork-mcp-app-host-");

    const app = await resolveMcpAppResource({
      serverConfig: config,
      workspaceId: WORKSPACE_ID,
      workspaceRoot: root,
      projectedToolName: "fixture_render_fixture",
    });
    expect(app).toEqual({
      serverName: "fixture",
      toolName: "render_fixture",
      resourceUri: RESOURCE_URI,
      html: RESOURCE_HTML,
      csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
      prefersBorder: true,
    });

  });

  test("lists cold-launchable MCP Apps with their input requirements", async () => {
    const { config, root } = await configuredFixture("openwork-mcp-app-catalog-");

    const servers = await listMcpAppCatalog({
      serverConfig: config,
      workspaceId: WORKSPACE_ID,
      workspaceRoot: root,
    });
    expect(servers).toHaveLength(1);
    const fixture = servers[0];
    expect(fixture?.serverName).toBe("fixture");
    expect(fixture?.reachable).toBe(true);
    const names = fixture?.apps.map((app) => app.toolName) ?? [];
    expect(names).toContain("render_fixture");
    expect(names).toContain("render_report");
    // App-only tools cannot resolve cold and unbound tools are not Apps.
    expect(names).not.toContain("read_bound_detail");
    expect(names).not.toContain("save_artifact_view");
    expect(names).not.toContain("model_only_fixture");
    const renderFixture = fixture?.apps.find((app) => app.toolName === "render_fixture");
    expect(renderFixture?.projectedToolName).toBe("fixture_render_fixture");
    expect(renderFixture?.resourceUri).toBe(RESOURCE_URI);
    expect(renderFixture?.requiresInput).toBe(false);
    expect(renderFixture?.requiresApproval).toBe(false);
    const renderReport = fixture?.apps.find((app) => app.toolName === "render_report");
    expect(renderReport?.requiresInput).toBe(true);
    // Non-read-only launch tools need the same approval `callMcpAppTool` enforces.
    const renderEditor = fixture?.apps.find((app) => app.toolName === "render_editor");
    expect(renderEditor?.requiresInput).toBe(false);
    expect(renderEditor?.requiresApproval).toBe(true);
  });

  test("capability discovery uses a fixed non-App tool and still honors disabled and denied configuration", async () => {
    const { config, root, calls } = await configuredFixture("openwork-capability-discovery-", undefined, "openwork-cloud");
    const input = { serverConfig: config, workspaceId: WORKSPACE_ID, workspaceRoot: root, query: "calendar" };
    await searchWorkspaceCapabilities(input);
    expect(calls).toEqual([{ name: "search_capabilities", arguments: { query: "calendar", limit: 20, intent: "discover" } }]);
    await Bun.write(join(root, "opencode.json"), JSON.stringify({ tools: { "openwork-cloud_search_capabilities": false } }));
    await expect(searchWorkspaceCapabilities(input)).rejects.toMatchObject({ code: "tool_denied" });
    expect(calls).toHaveLength(1);
    await writeRuntimeOpencodeConfig(config, WORKSPACE_ID, (current) => ({ ...current, mcp: { ...runtimeMcpMap(current), "openwork-cloud": { type: "remote", url: "http://127.0.0.1:1/mcp", enabled: false } } }));
    await expect(searchWorkspaceCapabilities(input)).rejects.toMatchObject({ code: "server_unavailable" });
    expect(calls).toHaveLength(1);
  });

  test("lists everything one server offers, with its App binding noted and denied tools left out", async () => {
    const { config, root } = await configuredFixture("openwork-mcp-server-tools-");

    const tools = await listMcpServerTools({
      serverConfig: config,
      workspaceId: WORKSPACE_ID,
      workspaceRoot: root,
      serverName: "fixture",
    });
    const names = tools.map((tool) => tool.name);
    // Every advertised tool, not only the Apps: plain tools and app-only tools included.
    expect(names).toContain("render_fixture");
    expect(names).toContain("save_artifact_view");
    expect(names).toContain("read_detail");
    expect(names).toContain("model_only_fixture");
    const renderFixture = tools.find((tool) => tool.name === "render_fixture");
    expect(renderFixture?.description).toBe("Render the fixture");
    expect(renderFixture?.resourceUri).toBe(RESOURCE_URI);
    expect(tools.find((tool) => tool.name === "save_artifact_view")?.resourceUri).toBeNull();

    await expect(listMcpServerTools({
      serverConfig: config,
      workspaceId: WORKSPACE_ID,
      workspaceRoot: root,
      serverName: "missing",
    })).rejects.toMatchObject({ code: "server_unavailable" });
  });

  test("lists Connect app-host apps with their connection references", async () => {
    const connectionId = "emc_01mcpappcatalogfixture";
    const serverName = connectMcpAppHostName(connectionId);
    const { config, root } = await configuredFixture(
      "openwork-mcp-app-catalog-connect-",
      undefined,
      serverName,
      connectionId,
    );

    const servers = await listMcpAppCatalog({
      serverConfig: config,
      workspaceId: WORKSPACE_ID,
      workspaceRoot: root,
    });
    // The gateway's own workspace entry may appear alongside the Connect
    // provider section; the provider section is the one carrying references.
    const connect = servers.find((server) => server.connectionId === connectionId);
    expect(connect?.serverName).toBe(serverName);
    expect(connect?.displayName).toBe("Fixture provider");
    expect(connect?.reachable).toBe(true);
    const names = connect?.apps.map((app) => app.toolName) ?? [];
    expect(names).toContain("render_fixture");
    // Connect launches resolve by connection reference, so app-only tools qualify.
    expect(names).toContain("read_bound_detail");
    expect(names).not.toContain("save_artifact_view");
    const renderFixture = connect?.apps.find((app) => app.toolName === "render_fixture");
    expect(renderFixture?.connectionId).toBe(connectionId);
    expect(renderFixture?.requiresInput).toBe(false);
    const renderReport = connect?.apps.find((app) => app.toolName === "render_report");
    expect(renderReport?.requiresInput).toBe(true);
  });

  test("reports an unreachable server in the MCP App catalog instead of failing it", async () => {
    const { config, root } = await configuredFixture("openwork-mcp-app-catalog-ghost-");
    await addMcp(config, WORKSPACE_ID, "ghost", { type: "remote", url: "http://127.0.0.1:9/", enabled: true });

    const servers = await listMcpAppCatalog({
      serverConfig: config,
      workspaceId: WORKSPACE_ID,
      workspaceRoot: root,
    });
    const ghost = servers.find((server) => server.serverName === "ghost");
    expect(ghost?.reachable).toBe(false);
    expect(ghost?.apps).toHaveLength(0);
    const fixture = servers.find((server) => server.serverName === "fixture");
    expect(fixture?.reachable).toBe(true);
    expect(fixture?.apps.map((app) => app.toolName)).toContain("render_fixture");
  });

  test("resolves a capability gateway launch through its exact native Connect tool", async () => {
    const connectionId = "emc_01mcpappgatewayfixture";
    const serverName = connectMcpAppHostName(connectionId);
    const { config, root, catalogReads } = await configuredFixture(
      "openwork-mcp-app-host-gateway-",
      undefined,
      serverName,
      connectionId,
    );

    const app = await resolveConnectMcpAppResource({
      serverConfig: config,
      workspaceId: WORKSPACE_ID,
      workspaceRoot: root,
      launch: {
        connectionId,
        toolName: "render_fixture",
        resourceUri: RESOURCE_URI,
      },
    });

    expect(app).toMatchObject({
      serverName,
      toolName: "render_fixture",
      resourceUri: RESOURCE_URI,
      html: RESOURCE_HTML,
    });
    expect(Object.keys(runtimeMcpMap(await readRuntimeOpencodeConfig(config, WORKSPACE_ID)))).toEqual(["openwork-cloud"]);
    expect(catalogReads()).toBe(0);
  });

  test("refreshes a missing private catalog entry when a capability gateway launch arrives", async () => {
    const connectionId = "emc_01mcpappgatewayrefresh";
    const serverName = connectMcpAppHostName(connectionId);
    const { config, root, catalogReads } = await configuredFixture(
      "openwork-mcp-app-host-gateway-refresh-",
      undefined,
      serverName,
      connectionId,
    );
    await writeOpenWorkConnectMcpAppHostCatalog(config, WORKSPACE_ID, {
      schemaVersion: "openwork.connect/mcp-servers/1",
      servers: [],
    });

    const app = await resolveConnectMcpAppResource({
      serverConfig: config,
      workspaceId: WORKSPACE_ID,
      workspaceRoot: root,
      launch: {
        connectionId,
        toolName: "render_fixture",
        resourceUri: RESOURCE_URI,
      },
    });

    expect(app).toMatchObject({
      serverName,
      toolName: "render_fixture",
      resourceUri: RESOURCE_URI,
      html: RESOURCE_HTML,
    });
    expect((await readOpenWorkConnectMcpAppHostCatalog(config, WORKSPACE_ID)).servers[0]?.connectionId).toBe(connectionId);
    expect(catalogReads()).toBe(1);
  });

  test("rejects a stale private catalog endpoint outside the credential's trusted origin", async () => {
    const connectionId = "emc_01mcpappcrossorigin";
    const { config, root } = await configuredFixture(
      "openwork-mcp-app-host-cross-origin-",
      undefined,
      connectMcpAppHostName(connectionId),
      connectionId,
    );
    await writeOpenWorkConnectMcpAppHostCatalog(config, WORKSPACE_ID, {
      schemaVersion: "openwork.connect/mcp-servers/1",
      servers: [{
        connectionId,
        name: "Untrusted provider",
        description: null,
        url: "https://attacker.example/mcp/agent/connections/emc_01mcpappcrossorigin",
      }],
    });

    await expect(resolveConnectMcpAppResource({
      serverConfig: config,
      workspaceId: WORKSPACE_ID,
      workspaceRoot: root,
      launch: {
        connectionId,
        toolName: "render_fixture",
        resourceUri: RESOURCE_URI,
      },
    })).rejects.toMatchObject({ code: "connect_catalog_missing_app_host_auth" });
  });

  test("resolves a same-server MCP App through its capability gateway", async () => {
    const { config, root } = await configuredFixture("openwork-mcp-app-host-same-server-");
    const app = await resolveSameServerMcpAppResource({
      serverConfig: config,
      workspaceId: WORKSPACE_ID,
      workspaceRoot: root,
      projectedToolName: "fixture_model_only_fixture",
      launch: {
        toolName: "read_bound_detail",
        resourceUri: RESOURCE_URI,
      },
    });
    expect(app).toMatchObject({
      serverName: "fixture",
      toolName: "read_bound_detail",
      resourceUri: RESOURCE_URI,
      html: RESOURCE_HTML,
    });
  });

  test("resolves and calls account-scoped gateway Apps from the effective runtime configuration", async () => {
    const { config, root, activateUpdatedResource } = await configuredFixture("openwork-mcp-app-global-gateway-");
    const fixture = (await listMcp(config, WORKSPACE_ID, root)).find(item => item.name === "fixture");
    if (!fixture) throw new Error("Fixture server missing");
    await writeGlobalRuntimeOpencodeConfig(config, () => ({ mcp: { "openwork-cloud": fixture.config } }));
    const app = await resolveSameServerMcpAppResource({
      serverConfig: config, workspaceId: WORKSPACE_ID, workspaceRoot: root,
      projectedToolName: "openwork-cloud_model_only_fixture",
      context: { sessionId: null, readOnly: false },
      launch: { toolName: "read_bound_detail", resourceUri: RESOURCE_URI },
    });
    expect(app).toMatchObject({ serverName: "openwork-cloud", html: RESOURCE_HTML });
    await activateUpdatedResource();
    expect(await callMcpAppTool({
      serverConfig: config, workspaceId: WORKSPACE_ID, workspaceRoot: root,
      serverName: app.serverName, name: app.toolName, resourceUri: app.resourceUri,
      launchId: app.launchId, sessionId: null,
      arguments: { id: "account" },
    })).toMatchObject({ structuredContent: { id: "account" } });
    await writeGlobalRuntimeOpencodeConfig(config, () => ({}));
    await expect(callMcpAppTool({
      serverConfig: config, workspaceId: WORKSPACE_ID, workspaceRoot: root,
      serverName: app.serverName, name: app.toolName, resourceUri: app.resourceUri,
      launchId: app.launchId, sessionId: null,
    })).rejects.toMatchObject({ code: "server_unavailable" });
  });

  test("rejects a stale gateway launch when the native tool changes its resource binding", async () => {
    const connectionId = "emc_01mcpappgatewaystale";
    const { config, root, activateUpdatedResource } = await configuredFixture(
      "openwork-mcp-app-host-gateway-stale-",
      undefined,
      connectMcpAppHostName(connectionId),
      connectionId,
    );
    await activateUpdatedResource();

    await expect(resolveConnectMcpAppResource({
      serverConfig: config,
      workspaceId: WORKSPACE_ID,
      workspaceRoot: root,
      launch: {
        connectionId,
        toolName: "render_fixture",
        resourceUri: RESOURCE_URI,
      },
    })).rejects.toMatchObject({ code: "tool_resource_mismatch" });
  });

  test("treats a management tool without a UI resource as a normal result", async () => {
    const { config, root } = await configuredFixture("openwork-mcp-app-host-management-");

    expect(await resolveMcpAppResource({
      serverConfig: config,
      workspaceId: WORKSPACE_ID,
      workspaceRoot: root,
      projectedToolName: "fixture_save_artifact_view",
    })).toBeNull();
  });

  test("refreshes the current tool definition before reading its exact resource", async () => {
    const { config, root, activateUpdatedResource } = await configuredFixture("openwork-mcp-app-host-refresh-");

    const first = await resolveMcpAppResource({
      serverConfig: config,
      workspaceId: WORKSPACE_ID,
      workspaceRoot: root,
      projectedToolName: "fixture_render_fixture",
    });
    await activateUpdatedResource();
    const updated = await resolveMcpAppResource({
      serverConfig: config,
      workspaceId: WORKSPACE_ID,
      workspaceRoot: root,
      projectedToolName: "fixture_render_fixture",
    });

    expect(first?.resourceUri).toBe(RESOURCE_URI);
    expect(updated).toMatchObject({ resourceUri: UPDATED_RESOURCE_URI, html: UPDATED_RESOURCE_HTML });
  });

  test("reports an advertised resource that resources/read cannot load", async () => {
    const { config, root } = await configuredFixture("openwork-mcp-app-host-missing-");

    await expect(resolveMcpAppResource({
      serverConfig: config,
      workspaceId: WORKSPACE_ID,
      workspaceRoot: root,
      projectedToolName: "fixture_render_missing",
    })).rejects.toMatchObject({ code: "resource_read_failed" });
  });

  test("decodes a stable-spec blob-backed HTML resource", async () => {
    const { config, root } = await configuredFixture("openwork-mcp-app-host-blob-", {
      blob: Buffer.from(RESOURCE_HTML, "utf8").toString("base64"),
    });

    const app = await resolveMcpAppResource({
      serverConfig: config,
      workspaceId: WORKSPACE_ID,
      workspaceRoot: root,
      projectedToolName: "fixture_render_fixture",
    });
    expect(app?.html).toBe(RESOURCE_HTML);
  });

  test("rejects non-UTF-8 blob-backed HTML", async () => {
    const invalidUtf8 = await configuredFixture("openwork-mcp-app-host-bad-utf8-", {
      blob: Buffer.from([0xff]).toString("base64"),
    });
    await expect(resolveMcpAppResource({
      serverConfig: invalidUtf8.config,
      workspaceId: WORKSPACE_ID,
      workspaceRoot: invalidUtf8.root,
      projectedToolName: "fixture_render_fixture",
    })).rejects.toMatchObject({ code: "invalid_resource" });
  });

  test("preserves an unreachable provider error for host diagnostics", async () => {
    const { config, root } = await configuredFixture("openwork-mcp-app-host-unreachable-");
    await stops.pop()?.();

    await expect(resolveMcpAppResource({
      serverConfig: config,
      workspaceId: WORKSPACE_ID,
      workspaceRoot: root,
      projectedToolName: "fixture_render_fixture",
    })).rejects.toMatchObject({ code: "mcp_unreachable" });
  });

  test("mediates explicitly read-only same-server tool calls", async () => {
    const { config, root } = await configuredFixture("openwork-mcp-app-call-");

    const result = await callMcpAppTool({
      ...await fixtureLaunch(config, root),
      serverConfig: config,
      workspaceId: WORKSPACE_ID,
      workspaceRoot: root,
      serverName: "fixture",
      name: "read_detail",
      arguments: { id: "42" },
    });
    expect(result).toMatchObject({
      content: [{ type: "text", text: "detail:42" }],
      structuredContent: { id: "42" },
    });
  });

  test("surfaces a provider argument rejection as a typed host error, not an unhandled failure", async () => {
    const { config, root } = await configuredFixture("openwork-mcp-app-call-rejected-");

    // A dashboard tile launched with input that omits a required argument must
    // show the provider's rejection, which names the missing key, instead of
    // the generic 500 "Unexpected server error" an untyped throw produces.
    let failure: unknown = null;
    try {
      await callMcpAppTool({
        ...await fixtureLaunch(config, root),
        serverConfig: config,
        workspaceId: WORKSPACE_ID,
        workspaceRoot: root,
        serverName: "fixture",
        name: "render_report",
        resourceUri: RESOURCE_URI,
        arguments: {},
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(McpAppHostError);
    if (!(failure instanceof McpAppHostError)) throw new Error("unreachable");
    expect(failure.code).toBe("tool_call_failed");
    // Provider text is relayed, but bounded: no control characters, capped length.
    expect(failure.message).toContain('"path":["id"],"message":"Required"');
    expect(failure.message).not.toContain("\u0007");
    expect(failure.message.length).toBeLessThanOrEqual(512 + 1);
    expect(failure.message.endsWith("…")).toBe(true);
  });

  test("mediates a resource-bound same-server tool for its exact MCP App", async () => {
    const { config, root } = await configuredFixture("openwork-mcp-app-bound-call-");

    const result = await callMcpAppTool({
      ...await fixtureLaunch(config, root),
      serverConfig: config,
      workspaceId: WORKSPACE_ID,
      workspaceRoot: root,
      serverName: "fixture",
      name: "read_bound_detail",
      resourceUri: RESOURCE_URI,
      arguments: { id: "bound" },
    });
    expect(result).toMatchObject({
      content: [{ type: "text", text: "detail:bound" }],
      structuredContent: { id: "bound" },
    });
  });

  test("rejects a resource-bound tool call from a different MCP App", async () => {
    const { config, root } = await configuredFixture("openwork-mcp-app-cross-resource-");

    await expect(callMcpAppTool({
      ...await fixtureLaunch(config, root),
      serverConfig: config,
      workspaceId: WORKSPACE_ID,
      workspaceRoot: root,
      serverName: "fixture",
      name: "read_bound_detail",
      resourceUri: UPDATED_RESOURCE_URI,
    })).rejects.toMatchObject({ code: "stale_launch_context" });
  });

  test("prevents sandboxed Apps from calling model-only tools", async () => {
    const { config, root } = await configuredFixture("openwork-mcp-app-model-only-");
    await expect(callMcpAppTool({
      ...await fixtureLaunch(config, root),
      serverConfig: config,
      workspaceId: WORKSPACE_ID,
      workspaceRoot: root,
      serverName: "fixture",
      name: "model_only_fixture",
    })).rejects.toMatchObject({ code: "tool_not_visible" });
  });

  test("rejects same-server tools that require approval", async () => {
    const { config, root } = await configuredFixture("openwork-mcp-app-write-");
    await expect(callMcpAppTool({
      ...await fixtureLaunch(config, root),
      serverConfig: config,
      workspaceId: WORKSPACE_ID,
      workspaceRoot: root,
      serverName: "fixture",
      name: "write_detail",
    })).rejects.toMatchObject({ code: "tool_requires_approval" });
  });

  test("calls an approved write tool on the exact originating server", async () => {
    const { config, root } = await configuredFixture("openwork-mcp-app-approved-write-");
    const result = await callMcpAppTool({
      ...await fixtureLaunch(config, root),
      serverConfig: config,
      workspaceId: WORKSPACE_ID,
      workspaceRoot: root,
      serverName: "fixture",
      name: "write_detail",
      arguments: { id: "approved" },
      approved: true,
    });
    expect(result).toMatchObject({
      content: [{ type: "text", text: "detail:approved" }],
      structuredContent: { id: "approved" },
    });
  });

  test("rejects private MCP egress outside explicit development mode", async () => {
    const { config, root } = await configuredFixture("openwork-mcp-app-private-");
    delete process.env.OPENWORK_DEV_MODE;

    await expect(resolveMcpAppResource({
      serverConfig: config,
      workspaceId: WORKSPACE_ID,
      workspaceRoot: root,
      projectedToolName: "fixture_render_fixture",
    })).rejects.toMatchObject({ code: "unsafe_server_url" });
  });

  test("rejects missing, cross-workspace, cross-session, cross-host and released launch contexts without dispatch", async () => {
    const { config, root, calls } = await configuredFixture("openwork-app-origin-");
    const launch = await fixtureLaunch(config, root);
    const request = { serverConfig: config, workspaceId: WORKSPACE_ID, workspaceRoot: root, serverName: "fixture", name: "read_detail", ...launch };
    await expect(callMcpAppTool({ ...request, launchId: undefined })).rejects.toMatchObject({ code: "missing_launch_context" });
    for (const override of [{ workspaceId: "workspace-b" }, { sessionId: "session-b" }, { engine: "v2" as const }, { serverConfig: { ...config } }, { serverName: "other" }]) {
      await expect(callMcpAppTool({ ...request, ...override })).rejects.toMatchObject({ code: "stale_launch_context" });
    }
    expect(releaseMcpAppLaunch(config, "workspace-b", launch.launchId)).toBe(false);
    expect(releaseMcpAppLaunch(config, WORKSPACE_ID, launch.launchId)).toBe(true);
    await expect(callMcpAppTool(request)).rejects.toMatchObject({ code: "stale_launch_context" });
    expect(calls).toEqual([]);
  });

  test("read-only and old-client resolutions render HTML but issue no actionable lease", async () => {
    const { config, root, calls } = await configuredFixture("openwork-app-readonly-");
    for (const context of [undefined, { sessionId: "archived", readOnly: true }]) {
      const app = await resolveMcpAppResource({ serverConfig: config, workspaceId: WORKSPACE_ID, workspaceRoot: root, projectedToolName: "fixture_render_fixture", context });
      expect(app?.html).toBe(RESOURCE_HTML);
      expect(app?.launchId).toBeUndefined();
    }
    expect(calls).toEqual([]);
  });

  test("unbound helpers cannot outlive the original launch tool or resource binding", async () => {
    for (const change of ["hideLaunch", "removeLaunch", "activateUpdatedResource"] as const) {
      const current = await configuredFixture("openwork-app-original-binding-");
      const launch = await fixtureLaunch(current.config, current.root);
      await current[change]();
      await expect(callMcpAppTool({ serverConfig: current.config, workspaceId: WORKSPACE_ID, workspaceRoot: current.root,
        serverName: "fixture", name: "read_detail", ...launch })).rejects.toMatchObject({ code: "stale_launch_context" });
      expect(current.calls).toEqual([]);
    }
  });

  test("unrelated provider, plugin and other MCP runtime edits preserve a live App lease", async () => {
    const { config, root, calls } = await configuredFixture("openwork-app-unrelated-runtime-");
    const launch = await fixtureLaunch(config, root);
    const original = (await readRuntimeOpencodeConfig(config, WORKSPACE_ID)).mcp?.fixture;
    if (!original) throw new Error("Missing fixture config");
    for (const workspaceId of [WORKSPACE_ID, ENGINE_GLOBAL_RUNTIME_CONFIG_ID]) {
      await writeRuntimeOpencodeConfig(config, workspaceId, current => ({
        ...current,
        provider: { ...current.provider, unrelated: { options: { apiKey: "synthetic-provider-key" } } },
        plugin: ["unrelated-fixture-plugin"],
        mcp: { ...current.mcp, unrelated: original },
      }));
    }
    expect(await callMcpAppTool({ serverConfig: config, workspaceId: WORKSPACE_ID, workspaceRoot: root,
      serverName: "fixture", name: "read_detail", arguments: { id: "same-lease" }, ...launch })).toMatchObject({
      structuredContent: { id: "same-lease" },
    });
    expect(calls).toEqual([{ name: "read_detail", arguments: { id: "same-lease" } }]);
  });

  test.each([WORKSPACE_ID, ENGINE_GLOBAL_RUNTIME_CONFIG_ID])("target MCP replacement/removal and restoration in %s invalidate its lease", async (scope) => {
    const { config, root, calls } = await configuredFixture("openwork-app-config-replaced-");
    const original = (await readRuntimeOpencodeConfig(config, WORKSPACE_ID)).mcp?.fixture;
    if (!original) throw new Error("Missing fixture config");
    if (scope === ENGINE_GLOBAL_RUNTIME_CONFIG_ID) {
      await writeGlobalRuntimeOpencodeConfig(config, () => ({ mcp: { fixture: original } }));
      await writeRuntimeOpencodeConfig(config, WORKSPACE_ID, () => ({}));
    }
    for (const remove of [false, true]) {
      const launch = await fixtureLaunch(config, root);
      await writeRuntimeOpencodeConfig(config, scope, current => {
        if (!current.mcp) throw new Error("Missing runtime MCP map");
        if (remove) delete current.mcp.fixture;
        else current.mcp.fixture = { ...original, headers: { Authorization: "Bearer replacement-fixture" } };
        return current;
      });
      await writeRuntimeOpencodeConfig(config, scope, () => ({ mcp: { fixture: original } }));
      await expect(callMcpAppTool({ serverConfig: config, workspaceId: WORKSPACE_ID, workspaceRoot: root,
        serverName: "fixture", name: "read_detail", ...launch })).rejects.toMatchObject({ code: "stale_launch_context" });
    }
    expect(calls).toEqual([]);
  });

  test("private App-host authorization rotation invalidates the old launch", async () => {
    const connectionId = "emc_fixture_rotation";
    const serverName = connectMcpAppHostName(connectionId);
    const { config, root, calls } = await configuredFixture("openwork-app-private-rotation-", undefined, serverName, connectionId);
    const app = await resolveConnectMcpAppResource({ serverConfig: config, workspaceId: WORKSPACE_ID, workspaceRoot: root,
      context: { sessionId: "session-a", readOnly: false }, launch: { connectionId, toolName: "render_fixture", resourceUri: RESOURCE_URI } });
    const runtime = await readRuntimeOpencodeConfig(config, WORKSPACE_ID);
    const url = runtime.mcp?.["openwork-cloud"]?.url;
    if (typeof url !== "string") throw new Error("Missing fixture URL");
    await writeOpenWorkConnectMcpAppHostAuthorization(config, WORKSPACE_ID, "Bearer replacement-fixture", url);
    await expect(callMcpAppTool({ serverConfig: config, workspaceId: WORKSPACE_ID, workspaceRoot: root,
      serverName, name: "read_detail", resourceUri: RESOURCE_URI, launchId: app.launchId, sessionId: "session-a" })).rejects.toMatchObject({ code: "stale_launch_context" });
    expect(calls).toEqual([]);
  });

  test("session validation and release during validation prevent the final provider dispatch", async () => {
    const { config, root, calls } = await configuredFixture("openwork-app-dispatch-gate-");
    const launch = await fixtureLaunch(config, root);
    const request = { serverConfig: config, workspaceId: WORKSPACE_ID, workspaceRoot: root, serverName: "fixture", name: "write_detail", approved: true, ...launch };
    await expect(callMcpAppTool({ ...request, assertSessionActive: undefined })).rejects.toMatchObject({ code: "inactive_session" });
    await expect(callMcpAppTool({ ...request, assertSessionActive: async () => { throw new McpAppHostError("inactive_session", "Archived"); } })).rejects.toMatchObject({ code: "inactive_session" });
    await expect(callMcpAppTool({ ...request, assertSessionActive: async () => { releaseMcpAppLaunch(config, WORKSPACE_ID, launch.launchId); } })).rejects.toMatchObject({ code: "stale_launch_context" });
    expect(calls).toEqual([]);
  });

  test("launch leases expire without allowing an approved dispatch", async () => {
    const { config, root, calls } = await configuredFixture("openwork-app-expired-");
    const launch = await fixtureLaunch(config, root);
    const now = Date.now();
    const clock = spyOn(Date, "now").mockReturnValue(now + 30 * 60_000 + 1);
    try {
      await expect(callMcpAppTool({ serverConfig: config, workspaceId: WORKSPACE_ID, workspaceRoot: root,
        serverName: "fixture", name: "write_detail", approved: true, ...launch })).rejects.toMatchObject({ code: "stale_launch_context" });
      expect(calls).toEqual([]);
    } finally { clock.mockRestore(); }
  });

  test("a stable local gateway name exposes changing private credential and connection generations only to the host", async () => {
    const { config, root } = await configuredFixture("openwork-app-managed-identity-");
    const key = randomBytes(32);
    config.localManagedMcpVaultKey = async () => key;
    const url = `http://127.0.0.1:${config.port}/mcp/managed/${WORKSPACE_ID}/fixture`;
    const identities = [];
    for (const [id, revision] of [["connection-a", "credential-a"], ["connection-a", "credential-b"], ["connection-b", "credential-b"]]) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from("openwork-local-managed-mcp-v1", "utf8"));
      const payload = JSON.stringify({ schemaVersion: 1, connections: {
        [`${WORKSPACE_ID.length}:${WORKSPACE_ID}fixture`]: {
          id, workspaceId: WORKSPACE_ID, name: "fixture", serverUrl: "https://fixture.invalid/mcp", enabled: true,
          oauth: { applicationType: "native" }, status: "connected", createdAt: 1, updatedAt: 1, authorizations: {},
          credential: { revision, accessToken: "synthetic-private-credential" },
        },
      } });
      const data = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
      await Bun.write(join(root, "local-managed-mcp-vault.json"), JSON.stringify({ schemaVersion: 1, algorithm: "aes-256-gcm",
        iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") }));
      identities.push(await localManagedMcpAppIdentity(config, WORKSPACE_ID, "fixture", url));
    }
    expect(identities[0]).not.toEqual(identities[1]);
    expect(identities[1]).not.toEqual(identities[2]);
    expect(JSON.stringify(identities)).not.toContain("synthetic-private-credential");
    expect(await localManagedMcpAppIdentity(config, WORKSPACE_ID, "fixture", "https://ordinary.invalid/mcp")).toBeNull();
  });
});
