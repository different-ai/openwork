import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMcpAppSandboxCsp, MCP_APP_SANDBOX_PROXY_SCRIPT, parseMcpAppSandboxCsp } from "./mcp-app-sandbox.js";
import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

const stops: Array<() => void | Promise<void>> = [];
const roots: string[] = [];

afterEach(async () => {
  while (stops.length) await stops.pop()?.();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

describe("MCP Apps sandbox proxy policy", () => {
  test("reports resource acceptance, document load, and safe sandbox failures", () => {
    expect(MCP_APP_SANDBOX_PROXY_SCRIPT).toContain("ui/notifications/sandbox-resource-accepted");
    expect(MCP_APP_SANDBOX_PROXY_SCRIPT).toContain("ui/notifications/sandbox-resource-loaded");
    expect(MCP_APP_SANDBOX_PROXY_SCRIPT).toContain("ui/notifications/sandbox-diagnostic");
    expect(MCP_APP_SANDBOX_PROXY_SCRIPT).not.toContain("params.html");
  });

  test("defaults external capabilities closed", () => {
    const csp = buildMcpAppSandboxCsp(parseMcpAppSandboxCsp(null));
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).not.toContain("unsafe-eval");
  });

  test("keeps only validated declared origins", () => {
    const csp = buildMcpAppSandboxCsp(parseMcpAppSandboxCsp(JSON.stringify({
      connectDomains: ["https://api.example.com", "https://bad.example; script-src *"],
      resourceDomains: ["https://static.example.com"],
      frameDomains: [],
      baseUriDomains: [],
    })));
    expect(csp).toContain("connect-src https://api.example.com");
    expect(csp).toContain("img-src 'self' data: blob: https://static.example.com");
    expect(csp).not.toContain("bad.example");
  });

  test("serves the proxy unauthenticated with an HTTP CSP header", async () => {
    const root = await mkdtemp(join(tmpdir(), "openwork-mcp-app-sandbox-"));
    roots.push(root);
    const config: ServerConfig = {
      host: "127.0.0.1",
      port: 0,
      token: "client-token",
      hostToken: "host-token",
      configPath: join(root, "server.json"),
      approval: { mode: "auto", timeoutMs: 0 },
      corsOrigins: ["*"],
      workspaces: [{ id: "ws_sandbox", name: "Sandbox", path: root, preset: "starter", workspaceType: "local" }],
      authorizedRoots: [root],
      readOnly: false,
      startedAt: Date.now(),
      tokenSource: "generated",
      hostTokenSource: "generated",
      logFormat: "pretty",
      logRequests: false,
    };
    const server = await startServer(config);
    stops.push(() => server.stop());
    const base = `http://127.0.0.1:${server.port}`;
    const response = await fetch(`${base}/mcp-apps/sandbox.html?csp=${encodeURIComponent(JSON.stringify({ connectDomains: ["https://api.example.com"] }))}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("connect-src https://api.example.com");
    expect(await response.text()).toContain("/mcp-apps/sandbox.js");
    expect((await fetch(`${base}/mcp-apps/sandbox.js`)).headers.get("content-type")).toContain("text/javascript");
  });
});
