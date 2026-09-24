import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chrome } from "@openwork/hosts";
import { connect, debuggerUrlFor, evaluate, listTargets, type Surface } from "@openwork/cdp";
import type { Place, Seed } from "@openwork/env";

export const appTitle = "Reference calculator";
export const toolName = "price_total";
export const procedureTitle = "Quantity times unit price";
export const launchInput = { quantity: 6, unitPrice: 7 };
export const indexUri = "openwork://connect/mcp-servers/index.json";
const fixturePaths = ["/owner/", "/member/", "/outsider/", "/host.js", "/owner/rpc", "/member/rpc", "/outsider/rpc"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected an object response");
  return value;
}

export function field(value: unknown, name: string): string {
  const result = record(value)[name];
  if (typeof result !== "string") throw new Error(`Expected ${name}`);
  return result;
}

export function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Expected response rows");
  return value.map(record);
}

export function payload(result: Record<string, unknown>): Record<string, unknown> {
  if (isRecord(result.structuredContent)) return result.structuredContent;
  const text = rows(result.content).find(part => part.type === "text");
  return record(JSON.parse(field(text, "text")));
}

function appSummary(result: Record<string, unknown>) {
  if (result.isError || result.rpcError) throw new Error(`App authoring failed: ${JSON.stringify(result)}`);
  const app = record(payload(result).app);
  return {
    appId: field(app, "appId"), pluginId: field(app, "pluginId"), revisionId: field(app, "revisionId"),
    title: field(app, "title"), toolName: field(app, "toolName"), resourceUri: field(app, "resourceUri"), serverPath: field(app, "serverPath"),
    mcpUrl: field(payload(result), "mcpUrl"),
  };
}

export function appSource(revision: string) {
  return {
    title: appTitle,
    textFallback: `${appTitle} is ready. Open the App to calculate a total.`,
    reactSource: `function payload(reply) {
      if (reply.structuredContent) return reply.structuredContent;
      const text = reply.content.find(part => part.type === "text");
      if (!text) throw new Error("Tool returned no JSON result");
      return JSON.parse(text.text);
    }
    export default function Calculator({ app, input }) {
      const [total, setTotal] = React.useState(null);
      const [failure, setFailure] = React.useState("");
      const [busy, setBusy] = React.useState(false);
      const toolsAvailable = Boolean(app.getHostCapabilities()?.serverTools);
      async function calculate() {
        setBusy(true); setFailure("");
        try {
          const reply = await app.callServerTool({ name: ${JSON.stringify(toolName)}, arguments: { quantity: input.quantity, unitPrice: input.unitPrice } });
          const next = payload(reply);
          if (reply.isError) throw new Error(next.message || "The calculation failed");
          setTotal(next.value?.total);
        } catch (error) { setFailure(error.message); }
        finally { setBusy(false); }
      }
      return <main>
        <header><h1>${appTitle}</h1><span>Ready — ${revision}</span></header>
        {!toolsAvailable && <p role="status">Server tools unavailable. Reopen in a host that enables server tools.</p>}
        <p>{input.quantity ?? 0} × {input.unitPrice ?? 0}</p>
        <button type="button" disabled={!toolsAvailable || busy} onClick={calculate}>Calculate total</button>
        {busy && <p role="status">Calculating</p>}
        {failure && <p role="alert">{failure}</p>}
        {total !== null && <output data-testid="total" aria-label="Total">{String(total)}</output>}
      </main>;
    }`,
    cssSource: `:root { font: 13px/1.5 system-ui, sans-serif; color: var(--color-text-primary, #1c2024); background: var(--color-background-primary, #f8f9fa); }
      body { margin: 0; } main { box-sizing: border-box; padding: 16px; } header { display: flex; align-items: center; gap: 16px; height: 40px; }
      h1 { font-size: 18px; font-weight: 600; } button { font: inherit; padding: 8px 12px; } output { display: block; padding-top: 12px; font-size: 18px; }`,
  };
}

async function buildStandardMcpAppHost() {
  const appRequire = createRequire(new URL("../../apps/app/package.json", import.meta.url));
  const { build } = await import(createRequire(appRequire.resolve("vite")).resolve("esbuild"));
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL("../fixtures/standard-mcp-app-host.ts", import.meta.url))],
    bundle: true, write: false, platform: "browser", format: "esm", minify: true,
  });
  const html = await readFile(new URL("../fixtures/standard-mcp-app-host.html", import.meta.url), "utf8");
  return { html, script: String(bundle.outputFiles[0].text) };
}

async function forwardLoopback(browser: Surface, origin: string, launchTool: string): Promise<AsyncDisposable> {
  if (!browser.client.webSocketDebuggerUrl) throw new Error("Browser transport unavailable");
  const socket = new WebSocket(browser.client.webSocketDebuggerUrl);
  let sequence = 0;
  const pending = new Map<number, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const active = new Set<Promise<void>>();
  const errors: Error[] = [];
  function send(method: string, params: Record<string, unknown>): Promise<void> {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Loopback forwarding timeout: ${method}`)); }, 10_000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function forward(params: Record<string, unknown>) {
    const request = record(params.request);
    const requested = new URL(field(request, "url"));
    const path = fixturePaths.find(candidate => requested.origin === origin && requested.pathname === candidate);
    if (!path) throw new Error("Refused non-fixture forwarding");
    const method = field(request, "method");
    const response = await fetch(new URL(`${path}${path.endsWith("/") ? `?tool=${encodeURIComponent(launchTool)}` : ""}`, origin), {
      method,
      headers: method === "POST" ? { origin, "content-type": "application/json" } : {},
      ...(typeof request.postData === "string" ? { body: request.postData } : {}),
      redirect: "error", signal: AbortSignal.timeout(95_000),
    });
    await send("Fetch.fulfillRequest", {
      requestId: field(params, "requestId"), responseCode: response.status,
      responseHeaders: ["content-type", "cache-control"].flatMap(name => {
        const value = response.headers.get(name);
        return value ? [{ name, value }] : [];
      }),
      body: Buffer.from(await response.arrayBuffer()).toString("base64"),
    });
  }
  socket.addEventListener("message", event => {
    const message = record(JSON.parse(String(event.data)));
    if (message.method === "Fetch.requestPaused") {
      const task = forward(record(message.params)).catch(error => { errors.push(error instanceof Error ? error : new Error("Loopback forwarding failed")); });
      active.add(task);
      void task.finally(() => active.delete(task));
    }
    if (typeof message.id === "number") {
      const call = pending.get(message.id);
      if (call) {
        clearTimeout(call.timer);
        pending.delete(message.id);
        if (message.error) call.reject(new Error("Loopback forwarding command failed"));
        else call.resolve();
      }
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Loopback forwarding connection timed out")), 10_000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Loopback forwarding connection failed")); }, { once: true });
    });
    await send("Fetch.enable", { patterns: [{ urlPattern: `${origin}/*`, requestStage: "Request" }] });
  } catch (error) {
    socket.close();
    throw error;
  }
  return { async [Symbol.asyncDispose]() {
    await Promise.all(active);
    await send("Fetch.disable", {}).finally(() => socket.close());
    if (errors.length) throw errors[0];
  } };
}

type Persona = "owner" | "member" | "outsider";
type Endpoint = "connect" | "app";
type RequestWitness = { persona: Persona; endpoint: Endpoint; via: "setup" | "client"; method: string; params: Record<string, unknown>; result: Record<string, unknown>; resourceDigest?: string };

/**
 * An owner builds an App through OpenWork Connect whose own MCP server binds a
 * saved Workflow as its one tool. A standard MCP Apps reference host talks
 * only to that App's MCP URL, as the owner, a teammate, and an outsider.
 */
export async function mcpAppServers(seed: Seed, context: { place: Place }) {
  await using resources = new AsyncDisposableStack();
  const den = await seed.den({
    web: true,
    org: { name: `App servers ${Date.now()}`, members: { member: { name: "App teammate" }, outsider: { name: "Ungranted teammate" } } },
  });
  const org = record((await seed.api(den.admin, "/v1/org")).body);
  const organizationId = field(org.organization, "id");
  const member = den.members.member;
  const outsider = den.members.outsider;
  if (!member || !outsider) throw new Error("Synthetic members missing");
  const tokens = new Map<Persona, string>();
  for (const [persona, session] of [["owner", den.admin], ["member", member], ["outsider", outsider]] satisfies Array<[Persona, typeof den.admin]>) {
    const minted = await seed.api(session, "/v1/mcp/token", {
      method: "POST", headers: { "x-openwork-org-id": organizationId },
      body: JSON.stringify({ scopes: persona === "outsider" ? ["mcp:read"] : ["mcp:read", "mcp:write"] }),
    });
    if (!minted.response.ok) throw new Error(`MCP token setup failed: ${minted.response.status}`);
    tokens.set(persona, field(minted.body, "token"));
  }
  let sequence = 0;
  let appServerPath = "";
  const requests: RequestWitness[] = [];
  async function rpc(persona: Persona, endpoint: Endpoint, method: string, params: Record<string, unknown>, via: "setup" | "client" = "setup") {
    const response = await fetch(`${den.ref.apiUrl}${endpoint === "app" ? appServerPath : "/mcp/agent"}`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokens.get(persona)}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method, params }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok) throw new Error(`Den MCP ${method} returned HTTP ${response.status}`);
    const raw = await response.text();
    const data = raw.split("\n").find(line => line.startsWith("data:"));
    const message = record(JSON.parse(data ? data.slice(5) : raw));
    const result = message.error ? { rpcError: record(message.error) } : record(message.result);
    const content = method === "resources/read" && !message.error ? rows(result.contents)[0] : undefined;
    const html = content && content.mimeType === "text/html;profile=mcp-app" ? content : undefined;
    requests.push({ persona, endpoint, via, method, params,
      result: html ? { contents: [{ uri: html.uri, mimeType: html.mimeType, _meta: html._meta }] } : result,
      ...(html ? { resourceDigest: createHash("sha256").update(field(html, "text")).digest("hex") } : {}),
    });
    return result;
  }
  const call = (persona: Persona, name: string, args: Record<string, unknown>) => rpc(persona, "connect", "tools/call", { name, arguments: args });
  const membership = rows(org.members).find(entry => field(entry.user, "email") === member.email);
  if (!membership) throw new Error("Synthetic member grant target missing");
  const memberId = field(membership, "id");
  async function grant(path: string) {
    const result = await seed.api(den.admin, path, { method: "POST", body: JSON.stringify({ orgMembershipId: memberId, role: "viewer" }) });
    if (result.response.status !== 201) throw new Error(`Viewer grant failed: ${result.response.status}`);
  }

  const inputSchema = { type: "object", properties: { quantity: { type: "number" }, unitPrice: { type: "number" } }, required: ["quantity", "unitPrice"], additionalProperties: false };
  const outputSchema = { type: "object", properties: { total: { type: "number" } }, required: ["total"], additionalProperties: false };
  const tested = await call("owner", "execute_capability_script", {
    code: "return { total: input.quantity * input.unitPrice };", input: launchInput, inputSchema, outputSchema,
  });
  if (tested.isError) throw new Error(`Procedure authoring failed: ${JSON.stringify(tested)}`);
  const metadata = record(payload(tested).metadata);
  if (record(metadata.retention).canSaveByReceipt !== true) throw new Error("Recent authoring receipt source retention is unavailable");
  const saved = await seed.api(den.admin, "/v1/workflows", {
    method: "POST", body: JSON.stringify({ name: procedureTitle, receiptId: field(metadata, "receiptId"), inputSchema, outputSchema, currentInput: launchInput }),
  });
  if (saved.response.status !== 201) throw new Error(`Saving the tested procedure failed: ${saved.response.status}`);
  const workflow = { pluginId: field(saved.body, "pluginId"), configObjectId: field(saved.body, "configObjectId") };
  const capability = `plugin:${workflow.pluginId}:${workflow.configObjectId}`;
  const tools = [{ name: toolName, description: "Multiply a quantity by a unit price.", capability }];
  const created = appSummary(await call("owner", "create_app", { ...appSource("revision one"), tools }));
  appServerPath = created.serverPath;

  const built = await buildStandardMcpAppHost();
  let origin = "";
  const server = createServer((request, response) => {
    void (async () => {
      response.setHeader("Cache-Control", "no-store");
      if (request.headers.host !== new URL(origin).host) { response.writeHead(403).end(); return; }
      const path = new URL(request.url ?? "/", origin).pathname;
      if (!fixturePaths.includes(path)) { response.writeHead(404).end(); return; }
      if (request.method === "GET" && path.endsWith("/")) {
        response.setHeader("Content-Type", "text/html");
        response.end(built.html);
      } else if (request.method === "GET" && path === "/host.js") {
        response.setHeader("Content-Type", "text/javascript");
        response.end(built.script);
      } else if (request.method === "POST" && path.endsWith("/rpc") && request.headers.origin === origin) {
        let body = "";
        for await (const chunk of request) {
          body += String(chunk);
          if (body.length > 16_384) { response.writeHead(413).end(); return; }
        }
        const message = record(JSON.parse(body));
        const method = field(message, "method");
        const params = record(message.params);
        if (!["tools/list", "resources/read", "tools/call"].includes(method)) { response.writeHead(403).end(); return; }
        const persona = path.startsWith("/owner/") ? "owner" : path.startsWith("/outsider/") ? "outsider" : "member";
        // The reference host knows nothing about OpenWork Connect: it talks only to the App's own MCP URL.
        const result = await rpc(persona, "app", method, params, "client");
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, ...(result.rpcError ? { error: result.rpcError } : { result }) }));
      } else response.writeHead(404).end();
    })().catch(() => { response.writeHead(502).end("Reference host proxy failed"); });
  });
  resources.defer(async () => {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Reference host loopback address missing");
  origin = `http://127.0.0.1:${address.port}`;
  const app = resources.use(await chrome({ name: "mcp-app-servers-reference-host", host: context.place.host(), startUrl: "about:blank", headless: true }));
  if (context.place.kind !== "local") resources.use(await forwardLoopback(app, origin, created.toolName));
  await app.client.send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false });
  const pluginWeb = await seed.web({ den, signedInAs: member, startPath: "/dashboard/library", headless: true, viewport: { width: 1280, height: 900 } });
  const url = (persona: Persona) => `${origin}/${persona}/?tool=${encodeURIComponent(created.toolName)}`;
  const retained = resources.move();
  return {
    app, pluginWeb, den, created, workflow, capability, url, requests, rpc, call,
    async share() {
      await grant(`/v1/plugins/${created.pluginId}/access`);
      await grant(`/v1/config-objects/${workflow.configObjectId}/access`);
    },
    async update() {
      const current = payload(await call("owner", "read_app", { appId: created.appId }));
      const updated = appSummary(await call("owner", "update_app", {
        ...appSource("revision two"), appId: created.appId, expectedRevisionId: field(current.app, "revisionId"),
      }));
      return { current, updated };
    },
    async index(persona: Persona) {
      const read = await rpc(persona, "connect", "resources/read", { uri: indexUri });
      const content = rows(read.contents)[0];
      return rows(record(JSON.parse(field(content, "text"))).servers);
    },
    async frame(): Promise<Surface & AsyncDisposable> {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const target = (await listTargets(app.handle.cdpUrl)).find(entry => entry.type === "iframe" && entry.url === "about:srcdoc");
        if (target) {
          const client = await connect(debuggerUrlFor(app.handle.cdpUrl, target));
          return { handle: app.handle, client, [Symbol.asyncDispose]: async () => client.close() };
        }
        await delay(100);
      }
      throw new Error("The served app iframe was not available for trusted browser input");
    },
    hostState: () => evaluate(app.client, () => ({
      digest: document.getElementById("view")?.dataset.resourceDigest ?? "",
      uri: document.getElementById("view")?.dataset.resourceUri ?? "",
      url: location.href,
    })),
    [Symbol.asyncDispose]: () => retained.disposeAsync(),
  };
}
