import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OPENWORK_CLOUD_EXPECTED_TOOLS, OPENWORK_CLOUD_PLUGIN_CANARIES } from "./cloud-mcp-health.js";
import { writeConnectCloudMcp } from "./connect-state.js";
import { writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import { startServer } from "./server.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

const CLIENT_TOKEN = "owt_connect_state_client";
const HOST_TOKEN = "owt_connect_state_host";
const previousRuntimeDb = process.env.OPENWORK_RUNTIME_DB;
const stops: Array<() => void | Promise<void>> = [];
const roots: string[] = [];

afterEach(async () => {
  while (stops.length) await stops.pop()?.();
  while (roots.length) await rm(roots.pop() ?? "", { recursive: true, force: true });
  if (previousRuntimeDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
  else process.env.OPENWORK_RUNTIME_DB = previousRuntimeDb;
});

async function createRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function startMockOpencode() {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/global/health") return Response.json({ healthy: true, version: "1.17.11" });
      if (url.pathname === "/mcp" && request.method === "GET") return Response.json({ "openwork-cloud": { status: "connected" } });
      if ((url.pathname === "/cloud-mcp" || url.pathname === "/cloud-mcp/mcp/agent") && request.method === "POST") {
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
          return Response.json({
            id,
            jsonrpc: "2.0",
            result: {
              tools: [
                { name: "search_capabilities", inputSchema: {} },
                { name: "execute_capability", inputSchema: {} },
              ],
            },
          });
        }
        if (isRecord(body) && body.method === "resources/read") {
          return Response.json({
            id,
            jsonrpc: "2.0",
            result: {
              contents: [{
                uri: "skill://index.json",
                mimeType: "application/json",
                text: JSON.stringify({
                  $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
                  skills: [{
                    name: "customer-briefing",
                    type: "skill-md",
                    description: "Prepare a customer briefing.",
                    url: "skill://customer-briefing/SKILL.md",
                    capability: "skill:skill_customer_briefing",
                  }],
                }),
              }],
            },
          });
        }
        return Response.json({ id, jsonrpc: "2.0", result: {} });
      }
      if (url.pathname === "/experimental/tool/ids") return Response.json([...OPENWORK_CLOUD_EXPECTED_TOOLS, ...OPENWORK_CLOUD_PLUGIN_CANARIES]);
      return Response.json({ code: "not_found" }, { status: 404 });
    },
  });
  stops.push(() => server.stop(true));
  return server;
}

function workspace(id: string, path: string, baseUrl: string): WorkspaceInfo {
  return { id, name: id, path, preset: "starter", workspaceType: "local", baseUrl };
}

async function startOpenwork(
  workspaces: WorkspaceInfo[],
  runtimeRoot: string,
  promptDebugEnv?: NodeJS.ProcessEnv,
): Promise<{ base: string; config: ServerConfig }> {
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
  const server = await startServer(config, { promptDebugEnv });
  stops.push(() => server.stop());
  return { base: `http://127.0.0.1:${server.port}`, config };
}

function clientHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${CLIENT_TOKEN}` };
}

function hostHeaders(): Record<string, string> {
  return { "X-OpenWork-Host-Token": HOST_TOKEN, "Content-Type": "application/json" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function responseRecord(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json();
  if (!isRecord(body)) throw new Error("Response body was not an object");
  return body;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} was not an object`);
  return value;
}

describe("connect state Cloud health scoping", () => {
  test("scopes desktop prompt logging to the server instance while explicit off wins", async () => {
    const enabledRoot = await createRoot("openwork-connect-context-debug-on-");
    const disabledRoot = await createRoot("openwork-connect-context-debug-off-");
    const engine = startMockOpencode();
    const baseUrl = `http://127.0.0.1:${engine.port}`;
    const enabled = await startOpenwork([
      workspace("ws_context_debug_on", enabledRoot, baseUrl),
    ], enabledRoot, {
      OPENWORK_PROMPT_LOG: "",
      OPENWORK_DESKTOP_DEV_MODE: "1",
      OPENWORK_DEV_MODE: "0",
    });
    const originalConsoleError = console.error;
    const records: string[] = [];
    console.error = (...values: unknown[]) => {
      records.push(values.map(String).join(" "));
    };

    try {
      const enabledResponse = await fetch(
        `${enabled.base}/experimental/connect/context?directory=${encodeURIComponent(enabledRoot)}`,
        {
          headers: {
            ...clientHeaders(),
            "x-openwork-prompt-trace": "pt_server01",
          },
        },
      );
      expect(enabledResponse.status).toBe(200);
      expect(records.some((record) =>
        record.startsWith("[openwork][connect-context]")
        && record.includes("trace=pt_server01")
      )).toBe(true);

      records.length = 0;
      const disabled = await startOpenwork([
        workspace("ws_context_debug_off", disabledRoot, baseUrl),
      ], disabledRoot, {
        OPENWORK_PROMPT_LOG: "0",
        OPENWORK_DESKTOP_DEV_MODE: "1",
        OPENWORK_DEV_MODE: "1",
      });
      const disabledResponse = await fetch(
        `${disabled.base}/experimental/connect/context?directory=${encodeURIComponent(disabledRoot)}`,
        { headers: clientHeaders() },
      );
      expect(disabledResponse.status).toBe(200);
      expect(records.some((record) => record.startsWith("[openwork][connect-context]"))).toBe(false);
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("serves one authenticated no-store context bundle while retaining the legacy routes", async () => {
    const root = await createRoot("openwork-connect-context-");
    const engine = startMockOpencode();
    const openwork = await startOpenwork([
      workspace("ws_context", root, `http://127.0.0.1:${engine.port}`),
    ], root);
    const scopedUrl = `${openwork.base}/experimental/connect/context?directory=${encodeURIComponent(root)}&provider=anthropic&model=claude-sonnet-4`;

    const unauthorized = await fetch(scopedUrl);
    expect(unauthorized.status).toBe(401);

    const response = await fetch(scopedUrl, { headers: clientHeaders() });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const bundle = await responseRecord(response);
    expect(bundle.ok).toBe(true);
    expect(bundle.schemaVersion).toBe(1);
    expect(typeof bundle.generatedAt).toBe("number");
    expect(requireRecord(bundle.skills, "skills")).toEqual({ instruction: "", count: 0 });
    expect(Array.isArray(bundle.diagnostics)).toBe(true);
    expect(requireRecord(bundle.steering, "steering")).toMatchObject({
      connectEnabled: false,
      connectCatalogEnabled: false,
      cloudMcpPresent: false,
      workspace: { resolution: "resolved", id: "ws_context", directory: root },
    });
    expect(typeof requireRecord(requireRecord(bundle.steering, "steering").googleWorkspace, "googleWorkspace").legacyConfigured).toBe("boolean");

    const promptBundle = await responseRecord(await fetch(`${scopedUrl}&steering=omit`, {
      headers: clientHeaders(),
    }));
    expect(promptBundle.steering).toBeNull();
    expect((promptBundle.diagnostics as unknown[]).some((message) =>
      typeof message === "string" && message.includes("steering omitted by caller")
    )).toBe(true);

    const passiveBundle = await responseRecord(await fetch(`${scopedUrl}&steering=passive`, {
      headers: clientHeaders(),
    }));
    expect(requireRecord(passiveBundle.steering, "steering")).toMatchObject({
      cloudHealth: null,
      workspace: { resolution: "resolved", id: "ws_context", directory: root },
    });
    expect((passiveBundle.diagnostics as unknown[]).some((message) =>
      typeof message === "string" && message.includes("assembled passively")
    )).toBe(true);

    expect((await fetch(`${openwork.base}/experimental/connect/state?directory=${encodeURIComponent(root)}`, { headers: clientHeaders() })).status).toBe(200);
    const legacySkills = await fetch(
      `${openwork.base}/experimental/connect/skills?directory=${encodeURIComponent(root)}`,
      { headers: clientHeaders() },
    );
    expect(legacySkills.status).toBe(200);
    expect(legacySkills.headers.get("cache-control")).toBe("no-store");
  });

  test("uses verified health for the exact requested directory without borrowing another workspace", async () => {
    const rootA = await createRoot("openwork-connect-state-a-");
    const rootB = await createRoot("openwork-connect-state-b-");
    const engine = startMockOpencode();
    const baseUrl = `http://127.0.0.1:${engine.port}`;
    const openwork = await startOpenwork([
      workspace("ws_a", rootA, baseUrl),
      workspace("ws_b", rootB, baseUrl),
    ], rootA);

    await fetch(`${openwork.base}/experimental/connect/state`, {
      method: "PUT",
      headers: hostHeaders(),
      body: JSON.stringify({ connectEnabled: true }),
    });
    await writeRuntimeOpencodeConfig(openwork.config, "ws_b", (current) => ({
      ...current,
      mcp: {
        ...current.mcp,
        "openwork-cloud": {
          type: "remote",
          url: `${baseUrl}/cloud-mcp/mcp/agent`,
          enabled: true,
          headers: { Authorization: "Bearer owt_connect_state_cloud_token" },
          oauth: false,
        },
      },
    }));

    const first = await responseRecord(await fetch(`${openwork.base}/experimental/connect/state?directory=${encodeURIComponent(rootA)}`, { headers: clientHeaders() }));
    expect(first.cloudMcpPresent).toBe(false);
    expect(requireRecord(first.workspace, "workspace").id).toBe("ws_a");
    expect(requireRecord(requireRecord(first.cloudHealth, "cloudHealth").desired, "desired").present).toBe(false);

    const second = await responseRecord(await fetch(`${openwork.base}/experimental/connect/state?directory=${encodeURIComponent(rootB)}`, { headers: clientHeaders() }));
    expect(second.cloudMcpPresent).toBe(true);
    expect(requireRecord(second.workspace, "workspace").id).toBe("ws_b");
    expect(requireRecord(second.cloudHealth, "cloudHealth").usable).toBe(true);

    const unknown = await responseRecord(await fetch(`${openwork.base}/experimental/connect/state?directory=${encodeURIComponent(join(rootA, "other"))}`, { headers: clientHeaders() }));
    expect(unknown.cloudMcpPresent).toBe(false);
    expect(unknown.cloudHealth).toBeNull();
    expect(requireRecord(unknown.workspace, "workspace").resolution).toBe("unknown");
  });

  test("keeps server-scoped Connect skills visible when steering workspace resolution is unknown", async () => {
    const root = await createRoot("openwork-connect-context-host-scope-");
    const engine = startMockOpencode();
    const baseUrl = `http://127.0.0.1:${engine.port}`;
    const openwork = await startOpenwork([
      workspace("ws_host_scope", root, baseUrl),
    ], root);
    await writeConnectCloudMcp(openwork.config, {
      type: "remote",
      url: `${baseUrl}/cloud-mcp/mcp/agent`,
      enabled: true,
      headers: { Authorization: "Bearer host-scope-token" },
    });

    const response = await fetch(
      `${openwork.base}/experimental/connect/context?directory=${encodeURIComponent(join(root, "not-a-workspace"))}`,
      { headers: clientHeaders() },
    );
    expect(response.status).toBe(200);
    const bundle = await responseRecord(response);
    expect(requireRecord(bundle.steering, "steering")).toMatchObject({
      workspace: { resolution: "unknown" },
    });
    expect(requireRecord(bundle.skills, "skills")).toMatchObject({ count: 1 });
    expect(String(requireRecord(bundle.skills, "skills").instruction)).toContain(
      "<name>customer-briefing</name>",
    );
    expect(Array.isArray(bundle.diagnostics)).toBe(true);
    expect((bundle.diagnostics as unknown[]).some((message) =>
      typeof message === "string"
      && message.includes("steering workspace not resolved (resolution=unknown)")
      && message.includes("continuing with the server-scoped skill catalog")
    )).toBe(true);
  });
});
