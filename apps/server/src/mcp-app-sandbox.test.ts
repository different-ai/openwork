import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { buildMcpAppSandboxCsp, MCP_APP_SANDBOX_PROXY_SCRIPT, parseMcpAppSandboxCsp } from "./mcp-app-sandbox.js";
import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

const stops: Array<() => void | Promise<void>> = [];
const roots: string[] = [];

function sandboxProxy(hostOrigin: string) {
  type Message = { source: object | null; origin: string; data: unknown };
  const upstream: Array<{ data: unknown; target: string }> = [];
  const downstream: Array<{ data: unknown; target: string }> = [];
  const parent = { postMessage: (data: unknown, target: string) => upstream.push({ data, target }) };
  const child = { postMessage: (data: unknown, target: string) => downstream.push({ data, target }) };
  const listeners = new Map<string, () => void>();
  const attributes = new Map<string, string>();
  let messageListener: (event: Message) => void = () => { throw new Error("Proxy did not install its listener"); };
  const inner = {
    title: "", style: { cssText: "" }, srcdoc: "", contentWindow: child,
    get contentDocument() { throw new Error("Opaque document must not be inspected"); },
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    addEventListener: (name: string, listener: () => void) => listeners.set(name, listener),
  };
  runInNewContext(MCP_APP_SANDBOX_PROXY_SCRIPT, {
    URL,
    window: {
      self: {}, top: parent, parent,
      location: { href: `https://sandbox.example/mcp-apps/sandbox.html?hostOrigin=${encodeURIComponent(hostOrigin)}`, origin: "https://sandbox.example" },
      addEventListener(name: string, listener: (event: Message) => void) {
        expect(name).toBe("message");
        messageListener = listener;
      },
    },
    document: { referrer: "", createElement: () => inner, body: { appendChild() {} } },
  });
  return { parent, child, inner, attributes, upstream, downstream, listeners, message: (event: Message) => messageListener(event) };
}

afterEach(async () => {
  while (stops.length) await stops.pop()?.();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

describe("MCP Apps sandbox proxy policy", () => {
  test.each(["https://host.example", "null"])("relays only the assigned opaque child for host %s", (hostOrigin) => {
    const app = sandboxProxy(hostOrigin);
    const sibling = sandboxProxy(hostOrigin);
    const target = hostOrigin === "null" ? "*" : hostOrigin;
    const helper = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read_detail", arguments: { marker: "own-app" } } };
    expect(app.attributes.get("sandbox")).toBe("allow-scripts");
    expect(app.upstream).toEqual([{ data: { jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready", params: {} }, target }]);
    app.upstream.length = 0;

    app.message({ source: app.child, origin: "null", data: helper });
    const resource = (html: unknown, sandbox: string) => ({ method: "ui/notifications/sandbox-resource-ready", params: { html, sandbox } });
    app.message({ source: app.parent, origin: "https://wrong-host.example", data: resource("wrong host", "allow-scripts") });
    app.message({ source: sibling.child, origin: hostOrigin, data: resource("wrong window", "allow-scripts") });
    expect(app.inner.srcdoc).toBe("");
    expect(app.upstream).toEqual([]);
    expect(app.downstream).toEqual([]);

    app.message({ source: app.parent, origin: hostOrigin, data: resource(null, "allow-same-origin") });
    expect(app.upstream.pop()).toMatchObject({ data: { method: "ui/notifications/sandbox-diagnostic", params: { code: "MCP_APP_SANDBOX_RESOURCE_INVALID" } } });
    app.message({ source: app.child, origin: "null", data: helper });
    expect(app.upstream).toEqual([]);

    for (const sandbox of ["allow-scripts allow-same-origin", "allow-same-origin", "", "allow-scripts allow-popups"]) {
      app.message({ source: app.parent, origin: hostOrigin, data: resource("<p>Own App</p>", sandbox) });
      expect(app.inner.srcdoc).toBe("<p>Own App</p>");
      expect(app.attributes.get("sandbox")).toBe("allow-scripts");
      expect(app.upstream.pop()).toEqual({ data: { method: "ui/notifications/sandbox-resource-accepted", params: {} }, target });
    }

    for (const event of [
      { source: sibling.child, origin: "null" },
      { source: sibling.child, origin: "https://sandbox.example" },
      { source: null, origin: "null" },
      { source: app.child, origin: "https://sandbox.example" },
      { source: app.child, origin: "https://other.example" },
      { source: app.parent, origin: "https://wrong-host.example" },
    ]) app.message({ ...event, data: helper });
    expect(app.upstream).toEqual([]);
    expect(app.downstream).toEqual([]);

    const requests = [
      { jsonrpc: "2.0", id: 1, method: "ui/initialize", params: {} },
      { jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} },
      helper,
      { jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 240 } },
      { jsonrpc: "2.0", id: 3, result: {} },
    ];
    for (const data of requests) app.message({ source: app.child, origin: "null", data });
    expect(app.upstream).toEqual(requests.map(data => ({ data, target })));
    const responses = [
      { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2026-01-26" } },
      { jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: { marker: "own-app" } } },
      { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { content: [] } },
      { jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "detail" }] } },
      { jsonrpc: "2.0", id: 3, method: "ui/resource-teardown", params: {} },
    ];
    for (const data of responses) app.message({ source: app.parent, origin: hostOrigin, data });
    expect(app.downstream).toEqual(responses.map(data => ({ data, target: "*" })));
    app.listeners.get("load")?.();
    expect(app.upstream.at(-1)).toEqual({ data: { method: "ui/notifications/sandbox-resource-loaded", params: { readyState: null, hasHtmlRoot: null, scriptCount: null } }, target });
    expect(sibling.inner.srcdoc).toBe("");
    expect(sibling.downstream).toEqual([]);
  });

  test("reports resource acceptance, document load, and safe sandbox failures", () => {
    expect(MCP_APP_SANDBOX_PROXY_SCRIPT).toContain("ui/notifications/sandbox-resource-accepted");
    expect(MCP_APP_SANDBOX_PROXY_SCRIPT).toContain("ui/notifications/sandbox-resource-loaded");
    expect(MCP_APP_SANDBOX_PROXY_SCRIPT).toContain("ui/notifications/sandbox-diagnostic");
    expect(MCP_APP_SANDBOX_PROXY_SCRIPT).toContain("postMessage({ method, params }, hostTargetOrigin)");
    expect(MCP_APP_SANDBOX_PROXY_SCRIPT).toContain('jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready"');
    expect(MCP_APP_SANDBOX_PROXY_SCRIPT).not.toContain('postMessage({ jsonrpc: "2.0", method, params }');
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
