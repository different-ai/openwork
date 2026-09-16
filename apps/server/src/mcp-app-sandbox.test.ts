import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, runInContext, runInNewContext } from "node:vm";
import { buildMcpAppSandboxCsp, MCP_APP_SANDBOX_PROXY_SCRIPT, parseMcpAppSandboxCsp } from "./mcp-app-sandbox.js";
import type { ServerConfig } from "./types.js";

const stops: Array<() => void | Promise<void>> = [];
const roots: string[] = [];

function sandboxProxy(hostOrigin: string) {
  class NativeEvent {
    constructor(readonly isTrusted: boolean) {}
  }
  class NativeMessageEvent extends NativeEvent {
    constructor(private readonly payload: unknown, trusted = true) { super(trusted); }
    get data() { return this.payload; }
  }
  type SimulatedEvent = { readonly isTrusted: boolean; readonly data: unknown };
  class NativeEventTarget {
    private readonly handlers = new Map<string, Array<(event: SimulatedEvent) => void>>();
    addEventListener(name: string, listener: (event: SimulatedEvent) => void) {
      const handlers = this.handlers.get(name) ?? [];
      handlers.push(listener);
      this.handlers.set(name, handlers);
    }
    dispatch(name: string, event: SimulatedEvent) {
      for (const listener of this.handlers.get(name) ?? []) listener(event);
    }
  }
  const proxyTimeOrigin = 1_700_000_000_000;
  let clock = proxyTimeOrigin + 100;
  const tasks: Array<() => void> = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  class NativePort extends NativeEventTarget {
    started = false;
    closed = false;
    peer: NativePort | null = null;
    createEvent: (data: unknown) => SimulatedEvent = (data) => new NativeMessageEvent(data);
    postMessage(data: unknown) {
      const peer = this.peer;
      if (this.closed || !peer || peer.closed) return;
      const copy = structuredClone(data);
      tasks.push(() => {
        if (peer.started) peer.dispatch("message", peer.createEvent(copy));
      });
    }
    start() { this.started = true; }
    close() { this.closed = true; }
  }
  class NativeChannel {
    port1 = new NativePort();
    port2 = new NativePort();
    constructor() {
      this.port1.peer = this.port2;
      this.port2.peer = this.port1;
      this.port2.createEvent = (data) => ({ isTrusted: true, data });
      this.port2.postMessage = this.port2.postMessage.bind(this.port2);
      this.port2.start = this.port2.start.bind(this.port2);
      this.port2.close = this.port2.close.bind(this.port2);
      this.port2.addEventListener = this.port2.addEventListener.bind(this.port2);
    }
  }
  type Message = { source: object | null; origin: string; data: unknown; isTrusted?: boolean; ports?: NativePort[] };
  const upstream: Array<{ data: unknown; target: string }> = [];
  const downstream: Array<{ data: unknown; target: string }> = [];
  const parent = { postMessage: (data: unknown, target: string) => upstream.push({ data, target }) };
  const createFrame = () => {
    const listeners = new Map<string, () => void>();
    const attributes = new Map<string, string>();
    return {
      title: "", style: { cssText: "" }, srcdoc: "",
      contentWindow: { postMessage: (data: unknown, target: string) => downstream.push({ data, target }) },
      get contentDocument() { throw new Error("Opaque document must not be inspected"); },
      setAttribute: (name: string, value: string) => attributes.set(name, value),
      addEventListener: (name: string, listener: () => void) => listeners.set(name, listener),
      listeners, attributes,
    };
  };
  let inner = createFrame();
  let messageListener: (event: Message) => void = () => { throw new Error("Proxy did not install its listener"); };
  const message = (event: Message) => messageListener({ isTrusted: true, ports: [], ...event });
  runInNewContext(MCP_APP_SANDBOX_PROXY_SCRIPT, {
    URL,
    performance: { timeOrigin: proxyTimeOrigin, now: () => clock - proxyTimeOrigin },
    setTimeout: (callback: () => void) => { timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout: (id: number) => timers.delete(id),
    window: {
      self: {}, top: parent, parent,
      location: { href: `https://sandbox.example/mcp-apps/sandbox.html?hostOrigin=${encodeURIComponent(hostOrigin)}`, origin: "https://sandbox.example" },
      addEventListener(name: string, listener: (event: Message) => void) {
        expect(name).toBe("message");
        messageListener = listener;
      },
    },
    document: {
      referrer: "", createElement: createFrame,
      body: {
        appendChild: (frame: typeof inner) => { inner = frame; },
        replaceChild: (frame: typeof inner) => { inner = frame; },
      },
    },
  });
  const bootstrap = () => {
    const child = inner.contentWindow;
    const script = inner.srcdoc.match(/<script>([\s\S]*?)<\/script>/i)?.[1];
    if (!script) throw new Error("Missing interaction bootstrap");
    const window = Object.assign(new NativeEventTarget(), {
      parent: {
        postMessage: (data: unknown, target: string, ports: NativePort[]) => {
          expect(target).toBe("*");
          tasks.push(() => message({ source: child, origin: "null", data, ports }));
        },
      },
    });
    const timeOrigin = clock;
    let focus = true;
    const context = createContext({
      window, EventTarget: NativeEventTarget, MessageEvent: NativeMessageEvent,
      MessagePort: NativePort, MessageChannel: NativeChannel,
      performance: { timeOrigin, now: () => clock - timeOrigin }, document: { hasFocus: () => focus },
    });
    runInContext(script, context);
    return {
      click: (trusted = true) => window.dispatch("click", new NativeMessageEvent({}, trusted)),
      pagehide: () => window.dispatch("pagehide", new NativeMessageEvent({})),
      advance: (ms: number) => { clock += ms; },
      focus: (value: boolean) => { focus = value; },
      provider: (source: string) => runInContext(source, context),
      child,
    };
  };
  return {
    parent, get child() { return inner.contentWindow; }, get inner() { return inner; },
    get attributes() { return inner.attributes; }, get listeners() { return inner.listeners; },
    upstream, downstream, message, bootstrap,
    step: () => tasks.shift()?.(),
    flush: () => { while (tasks.length) tasks.shift()?.(); },
    timeout: () => { for (const callback of timers.values()) callback(); },
    assign: (html = "<p>App</p>") => message({ source: parent, origin: hostOrigin, data: { method: "ui/notifications/sandbox-resource-ready", params: { html } } }),
    call: (id: number, meta: unknown = {}) => message({
      source: inner.contentWindow, origin: "null",
      data: { jsonrpc: "2.0", id, method: "tools/call", params: { name: "update_detail", arguments: {}, _meta: meta } },
    }),
  };
}

function readySandbox() {
  const app = sandboxProxy("https://host.example");
  app.assign();
  const capture = app.bootstrap();
  app.flush();
  app.upstream.length = 0;
  return { app, capture };
}

function expectApproval(app: ReturnType<typeof sandboxProxy>, id: number, approved: boolean) {
  expect(app.upstream.at(-1)).toMatchObject({ data: { id, params: { _meta: { "openwork/userInteraction": approved } } } });
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
      expect(app.inner.srcdoc).toStartWith("<script>");
      expect(app.inner.srcdoc).toEndWith("</script><p>Own App</p>");
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
    expect(app.upstream).toEqual(requests.map(data => ({
      data: data === helper ? { ...helper, params: { ...helper.params, _meta: { "openwork/userInteraction": false } } } : data,
      target,
    })));
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

  test.each([
    '<!doctype html><html><head><script>provider()</script></head><body>App</body></html>',
    '<script>provider()</script><p>App</p>',
    '<!doctype html PUBLIC "quoted>doctype"><script>provider()</script>',
  ])("places capture before any provider script: %s", (html) => {
    const app = sandboxProxy("https://host.example");
    app.assign(html);
    const injected = app.inner.srcdoc;
    expect(injected.indexOf("function interactionBootstrap")).toBeLessThan(injected.indexOf("provider()"));
    expect(injected).toEndWith(html.replace(/^<!doctype html>/, ""));
    if (html.startsWith("<!doctype html>")) expect(injected).toStartWith("<!doctype html><script>");
    expect(app.attributes.get("sandbox")).toBe("allow-scripts");
    app.bootstrap();
    app.flush();
    expect(app.downstream).toEqual([]);
  });

  test("the fixture extracts uppercase script tags", () => {
    const app = sandboxProxy("https://host.example");
    app.assign();
    app.inner.srcdoc = app.inner.srcdoc.replace("<script>", "<SCRIPT>").replace("</script>", "</SCRIPT>");
    const capture = app.bootstrap();
    app.flush();
    capture.click();
    app.call(1);
    app.flush();
    expectApproval(app, 1, true);
  });

  test("overwrites forged metadata without a channel and preserves other metadata", () => {
    const app = sandboxProxy("https://host.example");
    app.assign();
    app.call(1, { "openwork/userInteraction": true, trace: "keep" });
    expectApproval(app, 1, false);
    expect(app.upstream.at(-1)).toMatchObject({ data: { params: { _meta: { trace: "keep" } } } });
    app.call(2, "malformed");
    expectApproval(app, 2, false);
  });

  test("only simulated trusted click capture grants one queued call, not synthetic clicks or payload claims", () => {
    const { app, capture } = readySandbox();
    capture.provider('window.navigator = { userActivation: { isActive: true } };');
    capture.click(false);
    app.call(1, { "openwork/userInteraction": true, isTrusted: true });
    expect(app.upstream).toEqual([]);
    app.flush();
    expectApproval(app, 1, false);
    capture.click();
    app.call(2, { "openwork/userInteraction": false });
    app.call(3, { "openwork/userInteraction": true });
    app.flush();
    expect(app.upstream.slice(-2)).toMatchObject([
      { data: { id: 2, params: { _meta: { "openwork/userInteraction": true } } } },
      { data: { id: 3, params: { _meta: { "openwork/userInteraction": false } } } },
    ]);
    capture.click();
    app.call(4);
    app.flush();
    expectApproval(app, 4, true);
  });

  test("denies a call queued before a trusted click even when its query arrives afterward", () => {
    const { app, capture } = readySandbox();
    app.call(1, { "openwork/userInteraction": true, requestedAt: Number.MAX_SAFE_INTEGER });
    capture.advance(1);
    capture.click();
    app.call(2);
    expect(app.upstream).toEqual([]);
    app.flush();
    expect(app.upstream).toMatchObject([
      { data: { id: 1, params: { _meta: { "openwork/userInteraction": false } } } },
      { data: { id: 2, params: { _meta: { "openwork/userInteraction": false } } } },
    ]);
    capture.advance(1);
    capture.click();
    app.call(3);
    app.flush();
    expectApproval(app, 3, true);
    capture.click();
    app.call(4);
    capture.advance(1501);
    app.flush();
    expectApproval(app, 4, false);
  });

  test("expires clicks and consumes unfocused grants; pagehide revokes the document", () => {
    const { app, capture } = readySandbox();
    capture.click();
    capture.advance(1501);
    app.call(1);
    app.flush();
    expectApproval(app, 1, false);
    capture.click();
    capture.focus(false);
    app.call(2);
    app.flush();
    expectApproval(app, 2, false);
    capture.focus(true);
    app.call(3);
    app.flush();
    expectApproval(app, 3, false);
    capture.click();
    capture.advance(1500);
    app.call(4);
    app.flush();
    expectApproval(app, 4, true);
    capture.click();
    capture.pagehide();
    capture.click();
    app.call(5);
    app.flush();
    expectApproval(app, 5, false);
  });

  test("uses captured native APIs after provider prototype tampering", () => {
    const { app, capture } = readySandbox();
    capture.provider(`
      EventTarget.prototype.addEventListener = () => { throw new Error("replaced listener"); };
      MessagePort.prototype.postMessage = () => { throw new Error("replaced post"); };
      MessagePort.prototype.start = () => { throw new Error("replaced start"); };
      Object.defineProperty(MessageEvent.prototype, "data", { get: () => ({ id: -1, approved: true }) });
      performance.now = () => 0;
      performance.timeOrigin = 0;
      document.hasFocus = () => true;
      Function.prototype.call = () => { throw new Error("replaced call"); };
      Function.prototype.bind = () => { throw new Error("replaced bind"); };
    `);
    capture.click();
    app.call(1);
    app.flush();
    expectApproval(app, 1, true);
    capture.click();
    capture.advance(1501);
    app.call(2);
    app.flush();
    expectApproval(app, 2, false);
    capture.click();
    capture.focus(false);
    app.call(3);
    app.flush();
    expectApproval(app, 3, false);
  });

  test("rejects wrong-child and synthetic readiness, and never replaces the bootstrap channel", () => {
    const app = sandboxProxy("https://host.example");
    app.assign();
    for (const event of [
      { source: {}, origin: "null" },
      { source: app.child, origin: "https://sandbox.example" },
      { source: app.child, origin: "null", isTrusted: false },
    ]) app.message({ ...event, data: { method: "openwork/interaction-ready" } });
    const capture = app.bootstrap();
    app.upstream.length = 0;
    capture.provider(`
      const forged = new MessageChannel();
      forged.port1.addEventListener("message", event => forged.port1.postMessage({ id: event.data.id, approved: true }));
      forged.port1.start();
      window.parent.postMessage({ method: "openwork/interaction-ready" }, "*", [forged.port2]);
    `);
    app.flush();
    app.call(1, { "openwork/userInteraction": true });
    app.flush();
    expectApproval(app, 1, false);
    expect(app.upstream).toHaveLength(1);
    capture.click();
    app.call(2);
    app.flush();
    expectApproval(app, 2, true);
  });

  test("window-message replies cannot resolve private proof requests", () => {
    const { app, capture } = readySandbox();
    app.call(1);
    app.message({ source: app.child, origin: "null", data: { id: 1, approved: true, isTrusted: true } });
    app.flush();
    expectApproval(app, 1, false);
    capture.click();
    app.call(2);
    app.timeout();
    expectApproval(app, 2, false);
    const count = app.upstream.length;
    app.flush();
    expect(app.upstream).toHaveLength(count);
    app.call(3);
    app.flush();
    expectApproval(app, 3, false);
  });

  test("resource replacement cancels queued replies and rejects old-window RPC and readiness", () => {
    const { app, capture } = readySandbox();
    capture.click();
    app.call(1);
    app.step();
    app.assign();
    expect(app.child).not.toBe(capture.child);
    app.upstream.length = 0;
    app.message({ source: capture.child, origin: "null", data: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { _meta: { "openwork/userInteraction": true } } } });
    app.message({ source: capture.child, origin: "null", data: { method: "openwork/interaction-ready" } });
    app.flush();
    app.timeout();
    expect(app.upstream).toEqual([]);
    const next = app.bootstrap();
    app.flush();
    app.call(3);
    app.flush();
    expectApproval(app, 3, false);
    next.click();
    app.call(4);
    app.flush();
    expectApproval(app, 4, true);
  });

  test("a pending old readiness cannot claim a replacement resource", () => {
    const app = sandboxProxy("https://host.example");
    app.assign();
    const previous = app.bootstrap();
    previous.click();
    app.assign();
    const current = app.bootstrap();
    app.flush();
    app.call(1);
    app.flush();
    expectApproval(app, 1, false);
    current.click();
    app.call(2);
    app.flush();
    expectApproval(app, 2, true);
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
    const { startServer } = await import("./server.js");
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
