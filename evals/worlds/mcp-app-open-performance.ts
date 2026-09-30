import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";
import { chrome } from "@openwork/hosts";
import { connect, debuggerUrlFor, evaluate, listTargets, type CdpClient, type CdpTarget } from "@openwork/cdp";
import type { Seed, Place } from "@openwork/env";
import { readHeadlessRuntimeManifest, resolveHeadlessWorldRuntimePaths } from "../../packages/world/src/headless-web.ts";
import { mcpAppServersChat } from "./mcp-app-servers.ts";
import { connectMcpAppHostName } from "../../apps/server/src/connect-mcp-server-catalog.ts";

export type AppOpenSample = { surface: "chat" | "dashboard"; temperature: "cold" | "warm"; paintMs: number; errors: number;
  stages: Array<{ stage: string; durationMs: number }> };

export async function mcpAppOpenPerformance(seed: Seed, context: { place: Place }) {
  const world = await mcpAppServersChat(seed, true);
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const paths = resolveHeadlessWorldRuntimePaths(root, world.app.handle.name);
  const runtime = await readHeadlessRuntimeManifest(paths.runtimeManifestPath);
  if (!runtime) throw new Error("Test-owned App host missing");
  const fixture = resolve(root, "evals/worlds/fixtures/mcp-app-open-performance.tsx");
  await using resources = new AsyncDisposableStack();
  const vite = await createViteServer({
    configFile: false, root: resolve(root, "apps/app"), cacheDir: resolve(paths.directory, "performance-vite"),
    resolve: { alias: { "@": resolve(root, "apps/app/src") }, dedupe: ["react", "react-dom"] },
    esbuild: { jsx: "automatic" },
    optimizeDeps: { noDiscovery: false, entries: [fixture], include: ["react", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime", "@modelcontextprotocol/ext-apps/app-bridge"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, fs: { allow: [root] } },
    plugins: [{ name: "app-open-measurement", enforce: "pre",
      resolveId(source, importer) {
        const normalized = source.replace(resolve(root, "apps/app/src"), "@");
        if (normalized === "@/react-app/shell/workspace-provider") return "\0performance-workspace";
        const names = new Map([
          ["./connector-catalog", "ConnectorCatalogCard"], ["./connection-card", "ConnectionCard"],
          ["./message-list-provider", "useMessageList"], ["@/react-app/domains/apps/app-chat-artifact", "AppChatArtifact"],
          ["@/components/tools/error-attribution", "connectionCardPayloadFromChatToolResult,reconnectActionFromChatToolResult,isConnectionDiscoveryTool"],
          ["./dashboard-connection-card", "DashboardConnectionCard"],
        ]);
        const unused = names.get(normalized);
        if (unused && (importer?.includes("/components/chat/mcp-app-frame") || importer?.includes("/domains/dashboard/"))) return `\0performance-unused:${unused}`;
      },
      load(id) {
        if (id === "\0performance-workspace") return `import { benchmarkWorkspace } from ${JSON.stringify(fixture)}; export const useWorkspace = benchmarkWorkspace;`;
        if (id === "\0performance-unused:useMessageList") return `import { benchmarkChatContext } from ${JSON.stringify(fixture)}; export const useMessageList = benchmarkChatContext;`;
        if (id.startsWith("\0performance-unused:")) return id.split(":")[1].split(",").map(name => `export function ${name}() { return null; }`).join("\n");
      },
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (request.url?.startsWith("/host/")) {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const result = await fetch(`${runtime.openworkUrl}${request.url.slice(5)}`, {
              method: request.method, headers: { "content-type": "application/json", authorization: `Bearer ${runtime.token}` },
              ...(request.method !== "GET" && request.method !== "HEAD" ? { body: Buffer.concat(chunks) } : {}),
              signal: AbortSignal.timeout(30_000),
            });
            response.statusCode = result.status;
            response.setHeader("Content-Type", result.headers.get("content-type") ?? "application/json");
            response.end(Buffer.from(await result.arrayBuffer()));
            return;
          }
          response.setHeader("Cache-Control", "no-store");
          if (request.url === "/fixture-config") {
            response.setHeader("Content-Type", "application/json");
            response.end(JSON.stringify({ baseUrl: "/host", directBaseUrl: runtime.openworkUrl, token: runtime.token,
              workspaceId: world.workspace.workspaceId, sessionId: world.session.sessionId,
              disablePresentationCache: process.env.OPENWORK_MCP_APP_BASELINE === "1",
              apps: world.performanceApps.map(app => ({ ...app, serverName: connectMcpAppHostName(app.appId) })) }));
            return;
          }
          if (request.url !== "/") return next();
          response.setHeader("Content-Type", "text/html");
          response.end(`<!doctype html><title>App open performance</title><pre id="bootstrap-error"></pre><script>addEventListener("error", e => {document.getElementById("bootstrap-error").textContent += e.message});</script><div id="root"></div><script type="module" src="/@fs/${fixture}"></script>`);
        });
      },
    }],
  });
  resources.defer(() => vite.close());
  await vite.listen();
  const address = vite.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("Measurement port missing");
  const app = resources.use(await chrome({ name: "mcp-app-performance", host: context.place.host(), startUrl: "about:blank", headless: true }));
  await app.client.send("Runtime.enable");
  await app.client.send("Page.navigate", { url: `http://127.0.0.1:${address.port}/` });
  const retained = resources.move();
  const samples: AppOpenSample[] = [];
  let beforeApi = "";
  let beforeHost = "";
  const timings = (log: string) => log.split("\n").flatMap(line => {
    const marker = line.indexOf("MCP_APP_TIMING ");
    if (marker < 0) return [];
    const value: unknown = JSON.parse(line.slice(marker + 15));
    return typeof value === "object" && value !== null && "stage" in value && typeof value.stage === "string"
      && "durationMs" in value && typeof value.durationMs === "number" ? [{ stage: value.stage, durationMs: value.durationMs }] : [];
  });
  const indexSamples = [];
  for (let i = 0; i < 5; i++) {
    const before = await world.den.apiLog();
    const start = performance.now();
    await world.profileIndex();
    const durationMs = performance.now() - start;
    await new Promise(resolve => setTimeout(resolve, 50));
    indexSamples.push({ durationMs, stages: timings((await world.den.apiLog()).slice(before.length)) });
  }
  const output = resolve(root, "evals/results/mcp-app-open-performance");
  await mkdir(output, { recursive: true });
  await writeFile(resolve(output, `index-${process.env.OPENWORK_MCP_APP_BASELINE === "1" ? "before" : "after"}.json`), JSON.stringify(indexSamples, null, 2));
  return {
    app, samples,
    async begin() {
      beforeApi = await world.den.apiLog();
      beforeHost = await readFile(runtime.headlessLogPath, "utf8");
    },
    async capture(surface: AppOpenSample["surface"], temperature: AppOpenSample["temperature"]) {
      await using observers = new AsyncDisposableStack();
      // Read-only fixture observation; user controls every open/close button.
      const startedAt = await evaluate(app.client, () => Number(document.documentElement.dataset.appOpenStartedAt));
      let paintedAt = 0;
      let guestErrors = 0;
      const guests = new Map<string, CdpClient>();
      const observeGuest = async (target: CdpTarget) => {
        let guest = guests.get(target.id);
        if (!guest) {
          const url = debuggerUrlFor(app.handle.cdpUrl, target);
          guest = await connect(url);
          observers.defer(() => guest?.close());
          guests.set(target.id, guest);
          const socket = new WebSocket(url);
          observers.defer(() => socket.close());
          socket.addEventListener("message", event => {
            const value: unknown = JSON.parse(String(event.data));
            if (typeof value !== "object" || value === null || !("method" in value) || value.method !== "Runtime.consoleAPICalled"
              || !("params" in value) || typeof value.params !== "object" || value.params === null || !("args" in value.params)
              || !Array.isArray(value.params.args)) return;
            const first: unknown = value.params.args[0];
            if (typeof first === "object" && first !== null && "value" in first && first.value === "__MCP_APP_VISIBLE_ERROR__") guestErrors++;
          });
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("App error observer did not attach")), 5_000);
            socket.addEventListener("open", () => { clearTimeout(timer); socket.send(JSON.stringify({ id: 1, method: "Runtime.enable" })); resolve(); }, { once: true });
            socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("App error observer disconnected")); }, { once: true });
          });
        }
        await evaluate(guest, () => {
          if (document.documentElement.dataset.mcpAppErrorObserver) return;
          document.documentElement.dataset.mcpAppErrorObserver = "1";
          const check = () => {
            if (Array.from(document.querySelectorAll('[role="alert"], [role="status"]'))
              .some(node => /unavailable|can't run app tools|not available/i.test(node.textContent ?? ""))) console.debug("__MCP_APP_VISIBLE_ERROR__");
          };
          new MutationObserver(check).observe(document.body, { childList: true, subtree: true, characterData: true });
          check();
        }).catch(() => undefined);
        return guest;
      };
      const paintDeadline = Date.now() + 10_000;
      while (!paintedAt && Date.now() < paintDeadline) {
        for (const target of (await listTargets(app.handle.cdpUrl)).filter(target => target.type === "iframe" && target.url === "about:srcdoc")) {
          const guest = await observeGuest(target);
          const observed = await evaluate(guest, async () => {
            if (!document.querySelector("h1")) return null;
            await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
            return { paintedAt: performance.timeOrigin + performance.now(), errors: Array.from(document.querySelectorAll('[role="alert"], [role="status"]'))
              .filter(node => /unavailable|can't run app tools|not available/i.test(node.textContent ?? "")).length };
          }).catch(() => null);
          if (observed) { paintedAt = observed.paintedAt; guestErrors += observed.errors; break; }
        }
        if (!paintedAt) await new Promise(resolve => setTimeout(resolve, 10));
      }
      if (!paintedAt) throw new Error("The App heading did not paint");
      let host = await readFile(runtime.headlessLogPath, "utf8");
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && timings(host.slice(beforeHost.length)).filter(row => row.stage.endsWith("desktop.tools-call")).length < (surface === "chat" ? 2 : 3)) {
        for (const target of (await listTargets(app.handle.cdpUrl)).filter(target => target.type === "iframe" && target.url === "about:srcdoc")) await observeGuest(target);
        await new Promise(resolve => setTimeout(resolve, 50));
        host = await readFile(runtime.headlessLogPath, "utf8");
      }
      await new Promise(resolve => setTimeout(resolve, 50));
      const api = await world.den.apiLog();
      const sample: Omit<AppOpenSample, "surface" | "temperature"> = await evaluate(app.client, () => ({
        ...JSON.parse(document.getElementById("measurement")?.textContent ?? "{}"),
        errors: Number(document.documentElement.dataset.appObservedErrorCount ?? 0),
        stages: performance.getEntriesByType("measure").filter(entry => entry.name.startsWith("openwork.mcp-app."))
          .map(entry => ({ stage: entry.name, durationMs: entry.duration })),
      }));
      const row = { ...sample, paintMs: paintedAt - startedAt, errors: sample.errors + guestErrors,
        surface, temperature, stages: [...sample.stages, ...timings(api.slice(beforeApi.length)), ...timings(host.slice(beforeHost.length))] };
      samples.push(row);
      const output = resolve(root, "evals/results/mcp-app-open-performance");
      await mkdir(output, { recursive: true });
      await writeFile(resolve(output, `${process.env.OPENWORK_MCP_APP_BASELINE === "1" ? "before" : "after"}.json`), JSON.stringify(samples, null, 2));
      console.log("MCP_APP_SAMPLE", JSON.stringify({ surface, temperature, paintMs: row.paintMs, errors: row.errors }));
      return row;
    },
    async save() {
      const output = resolve(root, "evals/results/mcp-app-open-performance");
      await mkdir(output, { recursive: true });
      await writeFile(resolve(output, `${process.env.OPENWORK_MCP_APP_BASELINE === "1" ? "before" : "after"}.json`), JSON.stringify(samples, null, 2));
    },
    async [Symbol.asyncDispose]() { await retained.disposeAsync(); },
  };
}
