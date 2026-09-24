import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chrome, defaultDaytonaExec, execInSandbox } from "@openwork/hosts";
import { connect, debuggerUrlFor, evaluate, listTargets, type Surface } from "@openwork/cdp";
import type { Place, Seed } from "@openwork/env";
import type { MockMcpTool } from "@openwork/labs";
import { reconcileDraftHost } from "../fixtures/cloud-draft-host.ts";
import { configureProvider } from "./chat.ts";

export const appTitle = "Order calculator";
export const procedureTitle = "Quantity times unit price";
export const liveTitle = "Today's pricing date";
export const launchInput = { sku: "WIDGET-7", quantity: 6 };
export const indexUri = "openwork://connect/mcp-servers/index.json";
/** The App composes three kinds of capability, each under its own clear tool name. */
export const toolNames = { live: "todays_date", connection: "lookup_unit_price", workflow: "price_total" } as const;
const unitPrice = 7;
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

/**
 * The App's source. An App opened right after create_app has no launch input,
 * so a freshly built one can start from the sample order instead.
 */
export function appSource(revision: string, options: { title?: string; sampleOrder?: boolean } = {}) {
  const title = options.title ?? appTitle;
  const order = options.sampleOrder
    ? `{ sku: launch.sku ?? ${JSON.stringify(launchInput.sku)}, quantity: launch.quantity ?? ${launchInput.quantity} }`
    : "launch";
  return {
    title,
    textFallback: `${title} is ready. Open the App to price an order.`,
    reactSource: `function payload(reply) {
      if (reply.structuredContent) return reply.structuredContent;
      const text = reply.content.find(part => part.type === "text");
      if (!text) throw new Error("Tool returned no JSON result");
      return JSON.parse(text.text);
    }
    export default function Calculator({ app, input: launch }) {
      const input = ${order};
      const [today, setToday] = React.useState(null);
      const [price, setPrice] = React.useState(null);
      const [total, setTotal] = React.useState(null);
      const [failure, setFailure] = React.useState("");
      const [busy, setBusy] = React.useState(false);
      const toolsAvailable = Boolean(app.getHostCapabilities()?.serverTools);
      React.useEffect(() => {
        if (!toolsAvailable) return;
        // Read-only tools may run when the App opens: the live Workflow, then the Inventory lookup.
        (async () => {
          const date = await app.callServerTool({ name: ${JSON.stringify(toolNames.live)}, arguments: { timeZone: "UTC" } });
          if (date.isError) throw new Error("Pricing date unavailable");
          setToday(payload(date).value?.today);
          const lookup = await app.callServerTool({ name: ${JSON.stringify(toolNames.connection)}, arguments: { sku: input.sku } });
          if (lookup.isError) throw new Error("Price lookup failed");
          setPrice(payload(lookup).unitPrice);
        })().catch(error => setFailure(error.message));
      }, [app, toolsAvailable]);
      async function calculate() {
        // OpenWork lets one click authorize one tool call, so the write is the only call this button makes.
        setBusy(true); setFailure("");
        try {
          const reply = await app.callServerTool({ name: ${JSON.stringify(toolNames.workflow)}, arguments: { quantity: input.quantity, unitPrice: price } });
          const next = payload(reply);
          if (reply.isError) throw new Error(next.message || "The calculation failed");
          setTotal(next.value?.total);
        } catch (error) { setFailure(error.message); }
        finally { setBusy(false); }
      }
      return <main>
        <header><h1>${title}</h1><span>Ready — ${revision}</span></header>
        {!toolsAvailable && <p role="status">Server tools unavailable. Reopen in a host that enables server tools.</p>}
        <p data-testid="pricing-date">{today ? "Prices as of " + today : "Loading pricing date"}</p>
        <p data-testid="order-line">{input.quantity ?? 0} × {input.sku ?? "no product"}{price !== null ? " at " + price : ""}</p>
        <button type="button" disabled={!toolsAvailable || busy || price === null} onClick={calculate}>Calculate total</button>
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
const inventoryTool: MockMcpTool = {
  name: toolNames.connection,
  description: "Look up a product's unit price.",
  inputSchema: { type: "object", properties: { sku: { type: "string" } }, required: ["sku"], additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false },
  result: { content: [{ type: "text", text: `Unit price ${unitPrice}` }], structuredContent: { sku: launchInput.sku, unitPrice }, isError: false },
};

/** Save the two Workflows and build the App over them and the Inventory connection, all through Connect. */
async function composeOrderCalculator(
  seed: Seed,
  owner: Parameters<Seed["api"]>[0],
  connectionId: string,
  call: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>,
) {
  async function saveTestedWorkflow(name: string, request: Record<string, unknown>, save: Record<string, unknown>) {
    const tested = await call("execute_capability_script", request);
    if (tested.isError) throw new Error(`${name} authoring failed: ${JSON.stringify(tested)}`);
    const metadata = record(payload(tested).metadata);
    if (record(metadata.retention).canSaveByReceipt !== true) throw new Error("Recent authoring receipt source retention is unavailable");
    const saved = await seed.api(owner, "/v1/workflows", {
      method: "POST", body: JSON.stringify({ name, receiptId: field(metadata, "receiptId"), ...save }),
    });
    if (saved.response.status !== 201) throw new Error(`Saving ${name} failed: ${saved.response.status} ${saved.text.slice(0, 300)}`);
    return { pluginId: field(saved.body, "pluginId"), configObjectId: field(saved.body, "configObjectId") };
  }
  const inputSchema = { type: "object", properties: { quantity: { type: "number" }, unitPrice: { type: "number" } }, required: ["quantity", "unitPrice"], additionalProperties: false };
  const outputSchema = { type: "object", properties: { total: { type: "number" } }, required: ["total"], additionalProperties: false };
  const procedureInput = { quantity: launchInput.quantity, unitPrice };
  const procedure = await saveTestedWorkflow(procedureTitle, {
    code: "return { total: input.quantity * input.unitPrice };", input: procedureInput, inputSchema, outputSchema,
  }, { inputSchema, outputSchema, currentInput: procedureInput });
  const runtimeKeys = ["now", "today", "timeZone", "dayStart", "dayEnd"];
  const runtimeSchema = {
    type: "object", additionalProperties: false, required: ["runtime"], properties: {
      runtime: { type: "object", additionalProperties: false, required: runtimeKeys, properties: Object.fromEntries(runtimeKeys.map(key => [key, { type: "string" }])) },
    },
  };
  const liveOutputSchema = { type: "object", properties: { today: { type: "string" } }, required: ["today"], additionalProperties: false };
  const live = await saveTestedWorkflow(liveTitle, {
    mode: "live", code: "return { today: input.runtime.today };", inputSchema: runtimeSchema, outputSchema: liveOutputSchema,
  }, { inputSchema: runtimeSchema, outputSchema: liveOutputSchema });
  const capabilities = {
    live: `plugin:${live.pluginId}:${live.configObjectId}`,
    connection: `mcp:${connectionId}:${toolNames.connection}`,
    workflow: `plugin:${procedure.pluginId}:${procedure.configObjectId}`,
  };
  const tools = [
    { name: toolNames.live, description: "Today's pricing date for the viewer.", capability: capabilities.live, mode: "live" },
    { name: toolNames.connection, description: "Look up a product's unit price in Inventory.", capability: capabilities.connection },
    { name: toolNames.workflow, description: "Multiply a quantity by a unit price.", capability: capabilities.workflow },
  ];
  const created = appSummary(await call("create_app", { ...appSource("revision one"), tools }));
  return { procedure, live, capabilities, tools, created };
}

export async function mcpAppServers(seed: Seed, context: { place: Place }) {
  await using resources = new AsyncDisposableStack();
  const den = await seed.den({
    web: true,
    // Legacy Workflow-bound views are on so the journey can prove they are read-only beside App servers.
    env: { DEN_GENERATED_ARTIFACT_VIEWS_ENABLED: "true", DEN_APP_MCP_SERVERS_ENABLED: "true" },
    org: { name: `App servers ${Date.now()}`, members: { member: { name: "App teammate" }, outsider: { name: "Ungranted teammate" } } },
    mocks: { inventory: seed.mock({ allowUnauthenticatedMcp: true, tools: [inventoryTool] }) },
  });
  const connection = await seed.orgConnection(den.admin, {
    name: `Inventory ${Date.now()}`, url: den.mocks.inventory.mcpUrl,
    authType: "none", credentialMode: "shared", access: { orgWide: true },
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

  const { procedure, live, capabilities, tools, created } = await composeOrderCalculator(seed, den.admin, connection.id, (name, args) => call("owner", name, args));
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
    app, pluginWeb, den, created, capabilities, tools, url, requests, rpc, call,
    inventoryCalls: (options: { sinceIso?: string; atLeast?: number } = {}) => den.mocks.inventory.toolCalls({ name: toolNames.connection, atLeast: 0, ...options }),
    async share() {
      await grant(`/v1/plugins/${created.pluginId}/access`);
      for (const workflow of [procedure, live]) await grant(`/v1/config-objects/${workflow.configObjectId}/access`);
    },
    /** Every write path a Workflow-bound view had, tried against the running Den. */
    async legacyWrites() {
      const reactSource = "export default function View() { return <p>legacy</p> }";
      const results = await Promise.all([
        call("owner", "save_artifact_view", { configObjectId: procedure.configObjectId, title: "New legacy view", reactSource }),
        call("owner", "save_artifact_view", { artifactViewId: "existing-legacy-view", configObjectId: procedure.configObjectId, title: "Edited legacy view", reactSource }),
        call("owner", "activate_artifact_view_revision", { artifactViewId: "existing-legacy-view", revisionId: "existing-legacy-revision" }),
      ]);
      const saved = await seed.api(den.admin, "/v1/apps/existing-legacy-view/save", {
        method: "POST", body: JSON.stringify({ revisionId: "existing-legacy-revision", title: "Saved legacy view", useInWorkflow: false, expectedActiveRevisionId: null }),
      });
      return { tools: results.map(result => ({ isError: result.isError === true, body: payload(result) })), save: { status: saved.response.status, body: record(saved.body) } };
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

export const chatPrompt = "Open the Order calculator for 6 of WIDGET-7.";
export const chatReply = "The Order calculator is open in this conversation.";
export const pricerTitle = "Quick order pricer";
export const buildPrompt = "Build me an App that looks up a product's unit price in Inventory and multiplies it by the quantity.";
export const buildReply = "The Quick order pricer is ready in this conversation.";

/**
 * Apps prompted from an OpenWork chat: the model builds a new App with
 * create_app and opens an existing one with launch input, both through
 * Connect, and each App's own tools run in the conversation.
 */
export async function mcpAppServersChat(seed: Seed) {
  const den = await seed.den({
    env: { DEN_GENERATED_ARTIFACT_VIEWS_ENABLED: "true", DEN_APP_MCP_SERVERS_ENABLED: "true" },
    org: { name: `App servers chat ${Date.now()}` },
    mocks: { inventory: seed.mock({ allowUnauthenticatedMcp: true, tools: [inventoryTool] }) },
  });
  const connection = await seed.orgConnection(den.admin, {
    name: `Inventory ${Date.now()}`, url: den.mocks.inventory.mcpUrl,
    authType: "none", credentialMode: "shared", access: { orgWide: true },
  });
  const organizationId = field(record((await seed.api(den.admin, "/v1/org")).body).organization, "id");
  const minted = await seed.api(den.admin, "/v1/mcp/token", {
    method: "POST", headers: { "x-openwork-org-id": organizationId }, body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }),
  });
  if (!minted.response.ok) throw new Error(`MCP token setup failed: ${minted.response.status}`);
  const token = field(minted.body, "token");
  let sequence = 0;
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await fetch(`${den.ref.apiUrl}/mcp/agent`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method: "tools/call", params: { name, arguments: args } }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok) throw new Error(`Den MCP ${name} returned HTTP ${response.status}`);
    const raw = await response.text();
    const data = raw.split("\n").find(line => line.startsWith("data:"));
    return record(record(JSON.parse(data ? data.slice(5) : raw)).result);
  };
  const { created, tools } = await composeOrderCalculator(seed, den.admin, connection.id, call);
  // Each prompt is matched on its own turn, since both share one conversation.
  const configured = await fetch(`${den.mocks.inventory.url}/admin/agent-workloads`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ workloads: [
      { promptMarker: buildPrompt, finalReply: buildReply, latestUserTurn: true, steps: [
        { tool: "create_app", arguments: { ...appSource("revision one", { title: pricerTitle, sampleOrder: true }), tools } },
      ] },
      { promptMarker: chatPrompt, finalReply: chatReply, latestUserTurn: true, steps: [
        { tool: "execute_capability", arguments: { name: `plugin:${created.pluginId}:${created.appId}`, body: launchInput } },
      ] },
    ] }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!configured.ok) throw new Error(`Chat model setup failed: ${configured.status}`);
  const workspacePath = seed.tmpPath("mcp-app-servers-chat");
  const denOrigin = new URL(den.ref.apiUrl);
  const app = await seed.appWeb({ name: "mcp-app-servers-chat", workspacePath, headless: true,
    ...(denOrigin.protocol === "https:" ? { syntheticPreactivatedDenOrigin: denOrigin.origin } : {}) });
  const workspace = await seed.workspace(app, workspacePath);
  await configureProvider(seed, app, workspace.workspaceId, "app-chat-model", "app-chat-model", {
    provider: { "app-chat-model": {
      npm: "@ai-sdk/openai-compatible", name: "App chat model fixture",
      options: { baseURL: `${den.mocks.inventory.url}/v1`, apiKey: "sk-app-chat-fixture" },
      models: { "app-chat-model": { name: "App chat model fixture", tool_call: true } },
    } },
    mcp: { "openwork-cloud": { type: "remote", url: `${den.ref.apiUrl}/mcp/agent`, enabled: true, oauth: false, headers: { Authorization: `Bearer ${token}` } } },
  });
  const session = await seed.session(app, { title: appTitle });
  // The private App host reads the Connect server index, which lists the App as its own server.
  const hostSetup = {
    name: app.handle.name, openworkUrl: app.openworkUrl, workspaceRoot: app.workspaceRoot,
    workspaceId: workspace.workspaceId, cloudUrl: `${den.ref.apiUrl}/mcp/agent`, token, appHostToken: field(minted.body, "appHostToken"),
  };
  const reconciled = record(app.handle.sandboxId
    ? JSON.parse((await execInSandbox(defaultDaytonaExec, app.handle.sandboxId,
      `node /workspace/evals/fixtures/cloud-draft-host.ts ${Buffer.from(JSON.stringify(hostSetup)).toString("base64url")}`,
      { context: "Reconcile the App chat host", timeoutMs: 150_000 })).stdout.trim())
    : await reconcileDraftHost(hostSetup));
  if (reconciled.status !== 200 || reconciled.phase !== "ready" || reconciled.diagnostic !== "ready") throw new Error(`Cloud reconcile failed: ${JSON.stringify(reconciled)}`);
  return {
    app, session, den, created,
    inventoryCalls: (options: { sinceIso?: string; atLeast?: number } = {}) => den.mocks.inventory.toolCalls({ name: toolNames.connection, atLeast: 0, ...options }),
    /** An App's isolated frame in the conversation, by its title, for trusted input. */
    async appFrame(title: string): Promise<Surface & AsyncDisposable> {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        for (const target of (await listTargets(app.handle.cdpUrl)).filter(entry => entry.type === "iframe" && entry.url === "about:srcdoc")) {
          const client = await connect(debuggerUrlFor(app.handle.cdpUrl, target));
          if (await evaluate(client, () => document.title).catch(() => "") === title) {
            return { handle: app.handle, client, [Symbol.asyncDispose]: async () => client.close() };
          }
          client.close();
        }
        await delay(250);
      }
      throw new Error(`${title} did not open in the conversation`);
    },
  };
}
