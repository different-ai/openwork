import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ServerConfig } from "../src/types.js";

const RESOURCE_URI = "ui://board/app.html";
const readOnly = { readOnlyHint: true, destructiveHint: false };

/** A stateless MCP App server on loopback, like Den's App servers, that records every JSON-RPC method. */
function startAppServer() {
  const methods: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
      const body = await request.json() as { id?: number; method: string; params?: Record<string, unknown> };
      methods.push(body.method);
      const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: body.id, result });
      switch (body.method) {
        case "initialize":
          return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {}, resources: {} }, serverInfo: { name: "board", version: "1.0.0" } });
        case "notifications/initialized":
          return new Response(null, { status: 202 });
        case "tools/list":
          return reply({ tools: [
            { name: "open_app", inputSchema: { type: "object" }, annotations: readOnly, _meta: { ui: { resourceUri: RESOURCE_URI, visibility: ["model", "app"] } } },
            { name: "list_items", inputSchema: { type: "object" }, annotations: readOnly, _meta: { ui: { visibility: ["model", "app"] } } },
          ] });
        case "resources/read":
          return reply({ contents: [{ uri: RESOURCE_URI, mimeType: "text/html;profile=mcp-app", text: "<!doctype html><p>Board</p>" }] });
        case "tools/call":
          return reply({ content: [{ type: "text", text: "3 items" }] });
        default:
          return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } });
      }
    },
  });
  return { methods, url: `http://127.0.0.1:${server.port}/mcp`, stop: () => server.stop(true) };
}

describe("MCP App launch sessions", () => {
  let dir: string;
  let workspaceRoot: string;
  let config: ServerConfig;
  let app: ReturnType<typeof startAppServer>;
  const previous = { ...process.env };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "openwork-mcp-app-launch-"));
    workspaceRoot = join(dir, "workspace");
    app = startAppServer();
    process.env.OPENWORK_RUNTIME_DB = join(dir, "runtime.sqlite");
    process.env.OPENCODE_CONFIG_DIR = join(dir, "opencode-global");
    process.env.XDG_CONFIG_HOME = join(dir, "xdg");
    process.env.OPENWORK_ALLOW_PRIVATE_MCP_URLS = "1";
    mkdirSync(workspaceRoot);
    writeFileSync(join(workspaceRoot, "opencode.json"), JSON.stringify({ mcp: { board: { type: "remote", url: app.url } } }));
    config = {
      host: "127.0.0.1", port: 0, token: "test", hostToken: "host-test", configPath: join(dir, "server.json"),
      approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [], readOnly: false,
      startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false,
    };
  });

  afterAll(() => {
    app.stop();
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    rmSync(dir, { recursive: true, force: true });
  });

  test("an App's first calls reuse the connection that opened it", async () => {
    const { callMcpAppTool, releaseMcpAppLaunch, resolveMcpAppResource } = await import("../src/mcp-app-host.js");
    const base = { serverConfig: config, workspaceId: "ws_launch_session", workspaceRoot };
    const opened = await resolveMcpAppResource({ ...base, context: { sessionId: null, readOnly: false }, projectedToolName: "board_open_app" });
    expect(opened?.launchId).toBeString();
    const call = { ...base, launchId: opened!.launchId, sessionId: null, serverName: "board", name: "list_items", resourceUri: RESOURCE_URI, arguments: {} };

    // A cached-result peek, then the call itself.
    await callMcpAppTool({ ...call, checkOnly: true });
    const result = await callMcpAppTool(call);
    expect(result.content).toEqual([{ type: "text", text: "3 items" }]);

    const count = (method: string) => app.methods.filter((entry) => entry === method).length;
    expect(count("initialize")).toBe(1);
    // Tools are still listed fresh for the open, the peek and the call.
    expect(count("tools/list")).toBe(3);
    expect(count("tools/call")).toBe(1);

    // Releasing the launch closes its connection; a later call is refused, not reconnected.
    expect(releaseMcpAppLaunch(config, base.workspaceId, opened!.launchId!)).toBe(true);
    await expect(callMcpAppTool(call)).rejects.toMatchObject({ code: "stale_launch_context" });
    expect(count("initialize")).toBe(1);
  });

  test("a read-only open still resolves, without a launch", async () => {
    const { resolveMcpAppResource } = await import("../src/mcp-app-host.js");
    const before = app.methods.length;
    const opened = await resolveMcpAppResource({
      serverConfig: config, workspaceId: "ws_launch_session", workspaceRoot,
      context: { sessionId: null, readOnly: true }, projectedToolName: "board_open_app",
    });
    expect(opened?.launchId).toBeUndefined();
    expect(app.methods.slice(before).filter((method) => method === "initialize")).toHaveLength(1);
  });
});
