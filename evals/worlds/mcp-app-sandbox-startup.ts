import { createServer, type Server } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { chrome, createLocalHost } from "@openwork/hosts";
import { addInitScript, callFunctionOnSurface, evaluateOnSurface, type Surface } from "@openwork/cdp";
import type { HostedSandboxResource } from "./fixtures/mcp-app-sandbox-hosted";
export { acquireHostedSandboxResources } from "./fixtures/mcp-app-sandbox-hosted";
import {
  MCP_APP_SANDBOX_PROXY_HTML,
  MCP_APP_SANDBOX_PROXY_SCRIPT,
  MCP_APP_SANDBOX_PROXY_CSS,
  buildMcpAppSandboxCsp,
  parseMcpAppSandboxCsp,
} from "../../apps/server/src/mcp-app-sandbox";

export type StartupEvent = { at: number; tile: string; kind: string; detail: unknown };
export type StartupRequest = { at: number; path: string; phase: string; delayMs: number };
async function readStartup(browser: Surface) {
  return evaluateOnSurface(browser, () => {
    const parsed: unknown = JSON.parse(document.getElementById("sandbox-trace")?.textContent ?? "[]");
    const events = Array.isArray(parsed) ? parsed.filter((entry): entry is { at: number; tile: string; kind: string; detail: unknown } =>
      typeof entry === "object" && entry !== null && typeof entry.at === "number" && typeof entry.tile === "string" && typeof entry.kind === "string") : [];
    const hosted = document.documentElement.dataset.hosted === "true";
    const bootstrap = document.querySelector("vite-error-overlay")?.shadowRoot?.textContent ?? document.getElementById("bootstrap-error")?.textContent ?? "";
    return {
      events,
      bootstrap: hosted && bootstrap ? "fixture-bootstrap-error" : bootstrap,
      statuses: Array.from(document.querySelectorAll('[role="status"]')).map((node) => hosted ? "sandbox-error" : node.textContent ?? ""),
      initialized: events.filter((entry) => entry.kind === "ui/notifications/initialized").length,
      delivered: events.filter((entry) => entry.kind === "fixture/result-received" || entry.kind === "hosted-result-received").length,
      errors: events.filter((entry) => entry.kind === "view-error").length,
      retryTiles: Array.from(document.querySelectorAll("button")).filter((button) => button.textContent === "Retry").map((button) => button.closest("[data-tile]")?.getAttribute("data-tile") ?? "unknown"),
    };
  }, { reattachAttempts: 0 });
}

export type StartupLoad = {
  name: string;
  tiles: number;
  elapsedMs: number;
  events: StartupEvent[];
  requests: StartupRequest[];
  statuses: string[];
  initialized: number;
  delivered: number;
  errors: number;
  retryTiles: string[];
};

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Loopback server address missing");
  return `http://127.0.0.1:${address.port}`;
}

export async function sandboxStartupFixture(hostedResources?: HostedSandboxResource[]) {
  const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
  const resultsDir = resolve(repoRoot, "evals/results/mcp-app-sandbox-startup", `${Date.now()}-${process.pid}`);
  await mkdir(resultsDir, { recursive: true });
  await using resources = new AsyncDisposableStack();
  let cssDelayMs = 0;
  let scriptDelayMs = 0;
  let documentDelayMs = 0;
  let delayedDocumentNumber: number | undefined;
  let documentNumber = 0;
  let requests: StartupRequest[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const proxy = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    if (path.endsWith(".html")) documentNumber += 1;
    const htmlDelay = delayedDocumentNumber === undefined || documentNumber === delayedDocumentNumber ? documentDelayMs : 0;
    const wait = path.endsWith(".css") ? cssDelayMs : path.endsWith(".js") ? scriptDelayMs : htmlDelay;
    const log = requests;
    log.push({ at: Date.now(), path, phase: "request", delayMs: wait });
    response.on("finish", () => log.push({ at: Date.now(), path, phase: "finish", delayMs: wait }));
    response.on("close", () => {
      if (!response.writableFinished) log.push({ at: Date.now(), path, phase: "aborted", delayMs: wait });
    });
    const send = () => {
      if (response.destroyed) return;
      response.setHeader("Cache-Control", "no-store");
      if (path === "/mcp-apps/sandbox.html") {
        response.setHeader("Content-Type", "text/html");
        response.setHeader("Content-Security-Policy", buildMcpAppSandboxCsp(parseMcpAppSandboxCsp(url.searchParams.get("csp"))));
        response.end(MCP_APP_SANDBOX_PROXY_HTML);
      } else if (path === "/mcp-apps/sandbox.js") {
        response.setHeader("Content-Type", "text/javascript");
        response.end(MCP_APP_SANDBOX_PROXY_SCRIPT);
      } else if (path === "/mcp-apps/sandbox.css") {
        response.setHeader("Content-Type", "text/css");
        response.end(MCP_APP_SANDBOX_PROXY_CSS);
      } else {
        response.writeHead(404).end();
      }
    };
    if (wait === 0) send();
    else {
      const timer = setTimeout(() => { timers.delete(timer); send(); }, wait);
      timers.add(timer);
    }
  });
  resources.defer(async () => {
    for (const timer of timers) clearTimeout(timer);
    proxy.closeAllConnections();
    if (proxy.listening) await new Promise<void>((resolve, reject) => proxy.close((error) => error ? reject(error) : resolve()));
  });
  const proxyOrigin = await listen(proxy);
  const host = resources.use(createLocalHost({ repoRoot, rootDir: resolve(resultsDir, "browser"), log: console.log }));
  const vite = await createViteServer({
    configFile: false,
    root: resolve(repoRoot, "apps/app"),
    cacheDir: resolve(resultsDir, "vite-cache"),
    resolve: { alias: { "@": resolve(repoRoot, "apps/app/src") }, dedupe: ["react", "react-dom"] },
    esbuild: { jsx: "automatic" },
    optimizeDeps: { noDiscovery: true, include: ["react", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime", "@modelcontextprotocol/ext-apps/app-bridge"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, fs: { allow: [repoRoot] } },
    plugins: [{
      name: "isolated-sandbox-fixture",
      enforce: "pre",
      resolveId(source: string, importer: string | undefined) {
        if (!importer?.endsWith("/components/chat/mcp-app-frame.tsx")) return;
        const unrelated = new Map([
          ["./connector-catalog", ["ConnectorCatalogCard"]],
          ["./connection-card", ["ConnectionCard"]],
          ["./message-list-provider", ["useMessageList"]],
          ["@/react-app/domains/apps/app-chat-artifact", ["AppChatArtifact"]],
          ["@/components/tools/error-attribution", ["connectionCardPayloadFromChatToolResult", "reconnectActionFromChatToolResult"]],
        ]);
        const normalized = source.startsWith(resolve(repoRoot, "apps/app/src")) ? source.replace(resolve(repoRoot, "apps/app/src"), "@") : source;
        const names = unrelated.get(normalized);
        return names ? `\0fixture-unused:${names.join(",")}` : undefined;
      },
      load(id: string) {
        if (!id.startsWith("\0fixture-unused:")) return;
        return id.slice("\0fixture-unused:".length).split(",").map((name) => `export function ${name}() { throw new Error("Unrelated chat surface called by component fixture"); }`).join("\n");
      },
      configureServer(server: ViteDevServer) {
        server.middlewares.use((request, response, next) => {
          if (request.url === "/fixture-hosted-resources" && hostedResources) {
            response.setHeader("Content-Type", "application/json");
            response.setHeader("Cache-Control", "no-store");
            response.end(JSON.stringify(hostedResources));
            return;
          }
          if (request.url?.split("?")[0] !== "/") return next();
          response.setHeader("Content-Type", "text/html");
          response.end(`<!doctype html><html><head><title>Sandbox component integration</title></head><body><pre id="bootstrap-error"></pre><script>addEventListener('error', (event) => { document.getElementById('bootstrap-error').textContent += event.message || 'Resource failed: ' + event.target.src; }, true);</script><div id="root"></div><script type="module" src="/@fs/${resolve(repoRoot, "evals/worlds/fixtures/mcp-app-sandbox-startup.tsx")}"></script></body></html>`);
        });
      },
    }],
  });
  resources.defer(() => vite.close());
  await vite.listen();
  const address = vite.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("Vite loopback address missing");
  const hostOrigin = `http://127.0.0.1:${address.port}`;
  const browser = resources.use(await chrome({ name: "sandbox-component", host, startUrl: "about:blank", headless: true }));
  await browser.client.send("Network.enable");
  await browser.client.send("Network.setCacheDisabled", { cacheDisabled: true });
  if (!hostedResources) await browser.client.send("Network.setBlockedURLs", { urls: ["https://*"] });
  if (hostedResources) resources.use(await addInitScript(browser.client, () => {
      if (location.href !== "about:srcdoc" || window.parent === window.top) return;
      for (const method of ["log", "info", "warn", "error", "debug"]) Reflect.set(console, method, () => undefined);
      window.addEventListener("message", (event) => {
        if (event.source !== window.parent) return;
        const data: unknown = event.data;
        if (typeof data !== "object" || data === null || !("method" in data) || !("params" in data)) return;
        if (data.method !== "ui/notifications/tool-input" && data.method !== "ui/notifications/tool-result") return;
        window.parent.postMessage({ method: "fixture/hosted-received", params: { kind: data.method === "ui/notifications/tool-input" ? "input" : "result", payload: data.params } }, "*");
      });
  }));
  console.log(`Sandbox component integration: host=${hostOrigin}, proxy=${proxyOrigin}, traces=${resultsDir}`);
  const loads: StartupLoad[] = [];
  resources.defer(async () => {
    await writeFile(resolve(resultsDir, "summary.json"), JSON.stringify({
      scope: hostedResources ? "Hosted read-only demo component integration, not full dashboard or installed Electron" : "Component integration, not a full dashboard or provider test",
      realModules: ["McpAppSandboxView", "AppBridge", "createOpenworkServerClient", "mcp-app-sandbox proxy exports"],
      excludedChatSurfaces: ["ConnectorCatalogCard", "ConnectionCard", "useMessageList", "AppChatArtifact", "chat result attribution"],
      loads,
    }, null, 2));
  });
  const retained = resources.move();
  return {
    resultsDir,
    async load(options: { name: string; tiles: number; cssDelayMs?: number; scriptDelayMs?: number; documentDelayMs?: number; delayedDocumentNumber?: number; providerOffset?: number }): Promise<StartupLoad> {
      await browser.client.send("Page.navigate", { url: "about:blank" });
      cssDelayMs = options.cssDelayMs ?? 0;
      scriptDelayMs = options.scriptDelayMs ?? 0;
      documentDelayMs = options.documentDelayMs ?? 0;
      delayedDocumentNumber = options.delayedDocumentNumber;
      documentNumber = 0;
      requests = [];
      const startedAt = Date.now();
      await browser.client.send("Page.navigate", { url: `${hostOrigin}/?${new URLSearchParams({ proxy: proxyOrigin, tiles: String(options.tiles), ...(hostedResources ? { hosted: "true", providerOffset: String(options.providerOffset ?? 0) } : {}) })}` });
      let snapshot = await readStartup(browser);
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        snapshot = await readStartup(browser);
        if (snapshot.delivered + snapshot.errors >= options.tiles || snapshot.bootstrap || (snapshot.events.length === 0 && Date.now() - startedAt > 30_000)) break;
        await delay(100);
      }
      const load = { name: options.name, tiles: options.tiles, elapsedMs: Date.now() - startedAt, ...snapshot, requests: [...requests] };
      loads.push(load);
      await writeFile(resolve(resultsDir, `${options.name}.json`), JSON.stringify(load, null, 2));
      console.log(JSON.stringify({ name: load.name, tiles: load.tiles, initialized: load.initialized, delivered: load.delivered, errors: load.errors, elapsedMs: load.elapsedMs }));
      if (snapshot.bootstrap || snapshot.events.length === 0) throw new Error(`Fixture did not mount: ${snapshot.bootstrap || "no browser events"}; trace: ${resultsDir}`);
      return load;
    },
    async retry(options: { name: string; tile: string; tiles: number }): Promise<StartupLoad> {
      if (!/^\d+$/.test(options.tile)) throw new Error("Invalid fixture tile");
      const point = await callFunctionOnSurface(browser, (tile: string) => {
        const buttons = Array.from(document.querySelectorAll(`[data-tile="${tile}"] button`)).filter((button) => button.textContent === "Retry");
        if (buttons.length !== 1 || !(buttons[0] instanceof HTMLButtonElement)) throw new Error("Expected one real Retry button");
        buttons[0].scrollIntoView({ block: "center" });
        const rect = buttons[0].getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0 || buttons[0].disabled) throw new Error("Retry button unavailable");
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      }, [options.tile], { reattachAttempts: 0 });
      documentDelayMs = 0;
      cssDelayMs = 0;
      scriptDelayMs = 0;
      const startedAt = Date.now();
      await browser.client.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
      await browser.client.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
      let snapshot = await readStartup(browser);
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && (snapshot.delivered < options.tiles || snapshot.statuses.length > 0)) {
        await delay(100);
        snapshot = await readStartup(browser);
      }
      await delay(2_000);
      snapshot = await readStartup(browser);
      const load = { name: options.name, tiles: options.tiles, elapsedMs: Date.now() - startedAt, ...snapshot, requests: [...requests] };
      loads.push(load);
      await writeFile(resolve(resultsDir, `${options.name}.json`), JSON.stringify(load, null, 2));
      return load;
    },
    async [Symbol.asyncDispose]() {
      await retained.disposeAsync();
    },
  };
}
