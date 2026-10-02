import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chrome, defaultDaytonaExec, execInSandbox } from "@openwork/hosts";
import { browserScript, connect, debuggerUrlFor, evaluate, listTargets, type Surface } from "@openwork/cdp";
import type { EvalEngine, Place, Seed } from "@openwork/env";
import type { MockMcpTool } from "@openwork/labs";
import { reconcileDraftHost } from "../fixtures/cloud-draft-host.ts";
import { configureProvider } from "./chat.ts";
import { enableOrganizationCapabilities } from "./dashboards.ts";

export const appTitle = "Order calculator";
export const procedureTitle = "Quantity times unit price";
export const liveTitle = "Today's pricing date";
export const launchInput = { sku: "WIDGET-7", quantity: 6 };
export const indexUri = "openwork://connect/mcp-servers/index.json";
/** The App composes three kinds of capability, each under its own clear tool name. */
export const toolNames = { live: "todays_date", connection: "lookup_unit_price", workflow: "price_total", reserve: "reserve_stock" } as const;
export const reservationId = "RES-7001";
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
      const [priceNeedsClick, setPriceNeedsClick] = React.useState(false);
      const [reservation, setReservation] = React.useState(null);
      const [total, setTotal] = React.useState(null);
      const [failure, setFailure] = React.useState("");
      const [busy, setBusy] = React.useState("");
      const toolsAvailable = Boolean(app.getHostCapabilities()?.serverTools);
      async function lookUpPrice() {
        const lookup = await app.callServerTool({ name: ${JSON.stringify(toolNames.connection)}, arguments: { sku: input.sku } });
        if (lookup.isError) throw new Error("Price lookup failed");
        setPrice(payload(lookup).unitPrice);
      }
      React.useEffect(() => {
        if (!toolsAvailable) return;
        // Read-only tools load when the App opens: the live Workflow's date, and
        // the Inventory price, whose provider marks its lookup read-only.
        app.callServerTool({ name: ${JSON.stringify(toolNames.live)}, arguments: { timeZone: "UTC" } })
          .then(date => { if (date.isError) throw new Error("Pricing date unavailable"); setToday(payload(date).value?.today); })
          .catch(error => setFailure(error.message));
        // A host that asks before this call refuses it; a button then makes it instead.
        lookUpPrice().catch(() => setPriceNeedsClick(true));
      }, [app, toolsAvailable]);
      // Other connection tools and Workflow runs ask first, and OpenWork lets one
      // click authorize one tool call, so each button makes exactly one.
      async function run(label, call) {
        setBusy(label); setFailure("");
        try { await call(); } catch (error) { setFailure(error.message); }
        finally { setBusy(""); }
      }
      const lookUp = () => run("Looking up price", lookUpPrice);
      const reserve = () => run("Reserving stock", async () => {
        const reply = await app.callServerTool({ name: ${JSON.stringify(toolNames.reserve)}, arguments: { sku: input.sku, quantity: input.quantity } });
        if (reply.isError) throw new Error("The reservation failed");
        setReservation(payload(reply).reservationId);
      });
      const calculate = () => run("Calculating", async () => {
        const reply = await app.callServerTool({ name: ${JSON.stringify(toolNames.workflow)}, arguments: { quantity: input.quantity, unitPrice: price } });
        const next = payload(reply);
        if (reply.isError) throw new Error(next.message || "The calculation failed");
        setTotal(next.value?.total);
      });
      return <main>
        <header><h1>${title}</h1><span>Ready — ${revision}</span></header>
        {!toolsAvailable && <p role="status">Server tools unavailable. Reopen in a host that enables server tools.</p>}
        <p data-testid="pricing-date">{today ? "Prices as of " + today : "Loading pricing date"}</p>
        <p data-testid="order-line">{input.quantity ?? 0} × {input.sku ?? "no product"}{price !== null ? " at " + price : ""}</p>
        {priceNeedsClick && price === null && <button type="button" disabled={!toolsAvailable || busy !== ""} onClick={lookUp}>Look up price</button>}
        <button type="button" disabled={!toolsAvailable || busy !== ""} onClick={reserve}>Reserve stock</button>
        <button type="button" disabled={!toolsAvailable || busy !== "" || price === null} onClick={calculate}>Calculate total</button>
        {reservation && <p data-testid="reservation">Reserved {reservation}</p>}
        {busy && <p role="status">{busy}</p>}
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
 * An owner builds an App through OpenWork Connect whose own MCP server composes
 * a live Workflow, two Inventory connection tools, and a Workflow. A standard
 * MCP Apps reference host talks only to that App's MCP URL, as the owner, a
 * teammate, and an outsider.
 */
const inventoryTool: MockMcpTool = {
  name: toolNames.connection,
  description: "Look up a product's unit price.",
  inputSchema: { type: "object", properties: { sku: { type: "string" } }, required: ["sku"], additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false },
  result: { content: [{ type: "text", text: `Unit price ${unitPrice}` }], structuredContent: { sku: launchInput.sku, unitPrice }, isError: false },
};

/** A connection tool that changes something, so its provider does not mark it read-only. */
const reserveTool: MockMcpTool = {
  name: toolNames.reserve,
  description: "Reserve stock for an order.",
  inputSchema: { type: "object", properties: { sku: { type: "string" }, quantity: { type: "number" } }, required: ["sku", "quantity"], additionalProperties: false },
  annotations: { readOnlyHint: false, destructiveHint: false },
  result: {
    content: [{ type: "text", text: `Reserved ${launchInput.quantity} of ${launchInput.sku}` }],
    structuredContent: { reservationId, sku: launchInput.sku, quantity: launchInput.quantity }, isError: false,
  },
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
    reserve: `mcp:${connectionId}:${toolNames.reserve}`,
  };
  const tools = [
    { name: toolNames.live, description: "Today's pricing date for the viewer.", capability: capabilities.live, mode: "live" },
    { name: toolNames.connection, description: "Look up a product's unit price in Inventory.", capability: capabilities.connection },
    { name: toolNames.workflow, description: "Multiply a quantity by a unit price.", capability: capabilities.workflow },
    { name: toolNames.reserve, description: "Reserve the order's stock in Inventory.", capability: capabilities.reserve },
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
    mocks: { inventory: seed.mock({ allowUnauthenticatedMcp: true, tools: [inventoryTool, reserveTool] }) },
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
  // Each desktop reads the Connect server index as its private App host.
  const appHostTokens = new Map<Persona, string>();
  for (const [persona, session] of [["owner", den.admin], ["member", member], ["outsider", outsider]] satisfies Array<[Persona, typeof den.admin]>) {
    const minted = await seed.api(session, "/v1/mcp/token", {
      method: "POST", headers: { "x-openwork-org-id": organizationId },
      body: JSON.stringify({ scopes: persona === "outsider" ? ["mcp:read"] : ["mcp:read", "mcp:write"] }),
    });
    if (!minted.response.ok) throw new Error(`MCP token setup failed: ${minted.response.status}`);
    tokens.set(persona, field(minted.body, "token"));
    appHostTokens.set(persona, field(minted.body, "appHostToken"));
  }
  let sequence = 0;
  let appServerPath = "";
  const requests: RequestWitness[] = [];
  async function rpc(persona: Persona, endpoint: Endpoint, method: string, params: Record<string, unknown>, via: "setup" | "client" = "setup", appHost = false) {
    const response = await fetch(`${den.ref.apiUrl}${endpoint === "app" ? appServerPath : "/mcp/agent"}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${(appHost ? appHostTokens : tokens).get(persona)}`, "content-type": "application/json", accept: "application/json, text/event-stream",
        ...(appHost ? { "x-openwork-mcp-client-capabilities": "mcp-app-host-v1" } : {}),
      },
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
  // Building your own Apps is on for every organization, so Connect offers the
  // App builder before any platform admin changes a capability. Org dashboards
  // stay default-off per organization.
  const builderToolsByDefault = rows((await rpc("owner", "connect", "tools/list", {})).tools)
    .map(tool => field(tool, "name")).filter(name => ["create_app", "update_app", "read_app"].includes(name));
  await enableOrganizationCapabilities(seed, den.admin, { orgManagedDashboards: true }, organizationId);
  const membership = rows(org.members).find(entry => field(entry.user, "email") === member.email);
  if (!membership) throw new Error("Synthetic member grant target missing");
  const memberId = field(membership, "id");
  async function grant(path: string) {
    const result = await seed.api(den.admin, path, { method: "POST", body: JSON.stringify({ orgMembershipId: memberId, role: "viewer" }) });
    if (result.response.status !== 201) throw new Error(`Viewer grant failed: ${result.response.status}`);
  }

  const { procedure, capabilities, tools, created } = await composeOrderCalculator(seed, den.admin, connection.id, (name, args) => call("owner", name, args));
  appServerPath = created.serverPath;
  // An empty organization dashboard, for the owner to add the App to from Den's picker.
  const dashboardName = `Pricing board ${Date.now()}`;
  const dashboard = await seed.api(den.admin, "/v1/dashboards", { method: "POST", body: JSON.stringify({ name: dashboardName, elements: [] }) });
  if (dashboard.response.status !== 201) throw new Error(`Creating the dashboard failed: ${dashboard.response.status}`);
  const dashboardId = field(record(dashboard.body).item, "id");

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
        // Name the person each page acts as, so evidence screenshots say whose view they show.
        const viewer = path === "/owner/" ? "the owner" : path === "/member/" ? "a teammate" : "a teammate without access";
        response.end(built.html.replace("</h1>", `</h1><span data-testid="viewer">Signed in as ${viewer}</span>`));
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
  const adminWeb = await seed.web({ den, signedInAs: den.admin, startPath: `/dashboard/dashboards/${dashboardId}`, headless: true, viewport: { width: 1280, height: 900 } });
  const url = (persona: Persona) => `${origin}/${persona}/?tool=${encodeURIComponent(created.toolName)}`;
  const retained = resources.move();
  const elementsOf = (body: unknown) => rows(record(body).elements ?? []);
  return {
    app, pluginWeb, adminWeb, dashboardId, dashboardName, den, organizationId, created, capabilities, tools, url, requests, rpc, call,
    /** The App builder tools Connect offered a new organization before any /admin change. */
    builderToolsByDefault,
    /** The dashboard's tiles as its admin sees them. */
    async dashboardElements() {
      const read = await seed.api(den.admin, `/v1/dashboards/${dashboardId}`);
      return elementsOf(record(read.body).item);
    },
    /** Grants the dashboard to the teammate and returns their tiles as their desktop reads them. */
    async teammateDashboardElements() {
      const granted = await seed.api(den.admin, `/v1/dashboards/${dashboardId}/access`, { method: "POST", body: JSON.stringify({ orgMembershipId: memberId, role: "viewer" }) });
      if (granted.response.status !== 201) throw new Error(`Granting the dashboard failed: ${granted.response.status}`);
      const mine = rows(record((await seed.api(member, "/v1/me/dashboards")).body).items);
      return elementsOf(mine.find(item => item.id === dashboardId) ?? {});
    },
    inventoryCalls: (options: { sinceIso?: string; atLeast?: number } = {}) => den.mocks.inventory.toolCalls({ name: toolNames.connection, atLeast: 0, ...options }),
    reservations: (options: { sinceIso?: string; atLeast?: number } = {}) => den.mocks.inventory.toolCalls({ name: toolNames.reserve, atLeast: 0, ...options }),
    /** Shares only the App's own Plugin, which carries the Workflows its tools run. */
    async share() {
      await grant(`/v1/plugins/${created.pluginId}/access`);
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
    /** The Connect server index as this person's desktop App host reads it. */
    async index(persona: Persona) {
      const read = await rpc(persona, "connect", "resources/read", { uri: indexUri }, "setup", true);
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
export const reopenPrompt = "Show me that calculator again, please.";
export const reopenReply = "Here it is again, below.";
export const pricerTitle = "Quick order pricer";
export const buildPrompt = "Build me an App that looks up a product's unit price in Inventory and multiplies it by the quantity.";
export const buildReply = "The Quick order pricer is ready in this conversation.";
export const signInPrompt = "I need the Order calculator once more for 6 of WIDGET-7.";
export const signInReply = "Here is the Order calculator.";

/**
 * Apps prompted from an OpenWork chat: the model builds a new App with
 * create_app and opens an existing one with launch input, both through
 * Connect, and each App's own tools run in the conversation.
 */
export async function mcpAppServersChat(seed: Seed, benchmark: boolean | { place: Place } = false, options: { engine?: EvalEngine; desktop?: boolean; lifecycle?: boolean; ownSignIn?: boolean } = {}) {
  const measured = benchmark === true;
  const engine = options.engine ?? "v1";
  const toolStep = (tool: string, args: Record<string, unknown>) => engine === "v2" ? { tool: "execute", arguments: { code: `return await tools["openwork-cloud"].${tool}(${JSON.stringify(args)});` } } : { tool, arguments: args };
  const den = await seed.den({
    env: { DEN_GENERATED_ARTIFACT_VIEWS_ENABLED: "true", DEN_APP_MCP_SERVERS_ENABLED: "true", DEN_DASHBOARDS_ENABLED: "true", ...(measured ? { OPENWORK_MCP_APP_TIMINGS: "1" } : {}) },
    org: { name: `App servers chat ${Date.now()}` },
    mocks: { inventory: seed.mock({ allowUnauthenticatedMcp: true, tools: [inventoryTool, reserveTool] }) },
  });
  // With ownSignIn, each person signs in to Inventory with their own account, as with a real provider.
  const connection = await seed.orgConnection(den.admin, {
    name: `Inventory ${Date.now()}`, url: den.mocks.inventory.mcpUrl,
    ...(options.ownSignIn ? { authType: "oauth", credentialMode: "per_member" } : { authType: "none", credentialMode: "shared" }),
    access: { orgWide: true },
  });
  const organizationId = field(record((await seed.api(den.admin, "/v1/org")).body).organization, "id");
  if (options.ownSignIn) {
    // The owner signs in once, through the provider's real OAuth, before building with Inventory's tools.
    const started = record((await seed.api(den.admin, `/v1/mcp-connections/${connection.id}/connect/start`)).body);
    if (typeof started.authorizeUrl !== "string") throw new Error(`Inventory sign-in did not start: ${JSON.stringify(started)}`);
    const callback = (await fetch(started.authorizeUrl, { redirect: "manual", signal: AbortSignal.timeout(15_000) })).headers.get("location");
    if (!callback) throw new Error("Inventory sign-in did not redirect back to Den");
    const completed = await fetch(callback, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
    if (!completed.ok) throw new Error(`Inventory sign-in callback failed: HTTP ${completed.status}`);
  }
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
  const performanceApps = [];
  if (measured) for (let i = 0; i < 10; i++) performanceApps.push(appSummary(await call("create_app", {
    ...appSource("revision one", { title: `Performance App ${i}`, sampleOrder: true }), tools,
  })));
  // Each prompt is matched on its own turn, since they share one conversation.
  const configured = await fetch(`${den.mocks.inventory.url}/admin/agent-workloads`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ workloads: [
      { promptMarker: buildPrompt, finalReply: buildReply, latestUserTurn: true, steps: [
        ...(options.lifecycle ? [toolStep("search_capabilities", { query: "Inventory lookup unit price", type: "mcp", limit: 2 })] : []),
        toolStep("prepare_app", { title: pricerTitle, tools }),
        { ...toolStep("create_app", { ...appSource("revision one", { title: pricerTitle, sampleOrder: true }), tools, ...(engine === "v2" ? { preparationId: "__APP_PREPARATION_ID__" } : {}) }), argumentsFrom: "app-preparation", holdUntilReleased: true },
      ] },
      { promptMarker: chatPrompt, finalReply: chatReply, latestUserTurn: true, steps: [
        { tool: "execute_capability", arguments: { name: `plugin:${created.pluginId}:${created.appId}`, body: launchInput } },
      ] },
      { promptMarker: reopenPrompt, finalReply: reopenReply, latestUserTurn: true, steps: [
        { tool: "execute_capability", arguments: { name: `plugin:${created.pluginId}:${created.appId}`, body: launchInput } },
      ] },
      { promptMarker: signInPrompt, finalReply: signInReply, latestUserTurn: true, steps: [
        { tool: "execute_capability", arguments: { name: `plugin:${created.pluginId}:${created.appId}`, body: launchInput } },
      ] },
    ] }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!configured.ok) throw new Error(`Chat model setup failed: ${configured.status}`);
  const workspacePath = seed.tmpPath("mcp-app-servers-chat");
  const denOrigin = new URL(den.ref.apiUrl);
  const app = options.desktop ? await seed.desktop({ den, as: "admin", workspacePath, enterpriseActivated: true }) : await seed.appWeb({ name: `mcp-app-servers-chat-${engine}`, workspacePath, headless: true, engine,
    env: {
      OPENWORK_DEV_HEADLESS_WEB_DEN_PROXY: "1", OPENWORK_DEV_DEN_PROXY_TARGET: den.ref.webUrl,
      OPENWORK_DEV_HEADLESS_DEN_API_TARGET: den.ref.apiUrl,
      VITE_DEN_BASE_URL: den.ref.webUrl, VITE_DEN_API_BASE_URL: "/api/den",
      ...(measured ? { OPENWORK_MCP_APP_TIMINGS: "1" } : {}),
    },
    ...(denOrigin.protocol === "https:" ? { syntheticPreactivatedDenOrigin: denOrigin.origin } : {}) });
  if (!options.desktop) await seed.signIn(app, den.admin, "App owner");
  const workspace = await seed.workspace(app, workspacePath);
  await configureProvider(seed, app, workspace.workspaceId, "app-chat-model", "app-chat-model", {
    provider: { "app-chat-model": {
      npm: "@ai-sdk/openai-compatible", name: "App chat model fixture",
      options: { baseURL: `${den.mocks.inventory.url}/v1`, apiKey: "sk-app-chat-fixture" },
      models: { "app-chat-model": { name: "App chat model fixture", tool_call: true } },
    } },
    mcp: { "openwork-cloud": { type: "remote", url: `${den.ref.apiUrl}/mcp/agent`, enabled: true, oauth: false, headers: { Authorization: `Bearer ${token}` } } },
  }, engine);
  const session = await seed.session(app, { title: appTitle });
  // The private App host reads the Connect server index, which lists the App as its own server.
  if ("openworkUrl" in app) {
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
  } else {
    const status = await seed.evalIn(app, browserScript(async (workspaceId, url, mcpToken, appHostToken) => {
      const port = localStorage.getItem("openwork.server.port");
      const credential = localStorage.getItem("openwork.server.token");
      const response = await fetch(`http://127.0.0.1:${port}/workspace/${encodeURIComponent(workspaceId)}/mcp/openwork-cloud/reconcile`, {
        method: "POST", headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
        body: JSON.stringify({ config: { type: "remote", url, enabled: true, oauth: false, headers: { Authorization: `Bearer ${mcpToken}` } }, appHostAuthorization: `Bearer ${appHostToken}`, trigger: "app-creation-world" }),
      });
      return response.status;
    }, [workspace.workspaceId, `${den.ref.apiUrl}/mcp/agent`, token, field(minted.body, "appHostToken")]), { awaitPromise: true, timeoutMs: 150_000 });
    if (status !== 200) throw new Error(`Desktop App host reconciliation failed: ${status}`);
  }
  return {
    app, session, den, created, performanceApps, workspace, engine,
    async prepareLifecycleTurn(prompt: string, kind: "edit" | "failure" | "interrupt") {
      const catalog = rows(record((await seed.api(den.admin, "/v1/mcp-apps")).body).apps);
      const built = catalog.find(app => app.title === pricerTitle);
      if (!built) throw new Error("Created App is missing from the accessible catalog");
      const steps = kind === "edit"
        ? [toolStep("read_app", { appId: field(built, "connectionId") }), { ...toolStep("update_app", { ...appSource("revision two", { title: pricerTitle, sampleOrder: true }), appId: field(built, "connectionId"), ...(engine === "v2" ? { expectedRevisionId: "__APP_REVISION_ID__" } : {}) }), argumentsFrom: "app-read" }]
        : kind === "failure"
          ? [toolStep("create_app", { title: "Broken App", reactSource: "export default function App( {", tools, textFallback: "The App is unavailable." })]
          : [toolStep("prepare_app", { title: "Interrupted App", tools }), { ...toolStep("create_app", { ...appSource("interrupted", { title: "Interrupted App", sampleOrder: true }), tools, ...(engine === "v2" ? { preparationId: "__APP_PREPARATION_ID__" } : {}) }), argumentsFrom: "app-preparation", holdUntilReleased: true }];
      const response = await fetch(`${den.mocks.inventory.url}/admin/agent-workloads`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workloads: [{ promptMarker: prompt, finalReply: kind === "edit" ? "The App has been updated." : "The App could not be created.", latestUserTurn: true, steps }] }) });
      if (!response.ok) throw new Error("Could not prepare the lifecycle turn");
      return field(built, "connectionId");
    },
    /** Hold the model after preparation so the person can inspect real writing progress. */
    async holdCreation(held: boolean) {
      const response = await fetch(`${den.mocks.inventory.url}/admin/agent-hold`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ held }),
      });
      if (!response.ok) throw new Error("Could not change the creation fixture gate");
    },
    async profileIndex() {
      const response = await fetch(`${den.ref.apiUrl}/mcp/agent`, {
        method: "POST", headers: { authorization: `Bearer ${field(minted.body, "appHostToken")}`, "content-type": "application/json",
          accept: "application/json, text/event-stream", "x-openwork-mcp-client-capabilities": "mcp-app-host-v1" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method: "resources/read", params: { uri: indexUri } }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error("Benchmark index unavailable");
      const raw = await response.text();
      const data = raw.split("\n").find(line => line.startsWith("data:"));
      if (record(JSON.parse(data ? data.slice(5) : raw)).error) throw new Error("Benchmark index rejected");
    },
    inventoryCalls: (options: { sinceIso?: string; atLeast?: number } = {}) => den.mocks.inventory.toolCalls({ name: toolNames.connection, atLeast: 0, ...options }),
    reservations: (options: { sinceIso?: string; atLeast?: number } = {}) => den.mocks.inventory.toolCalls({ name: toolNames.reserve, atLeast: 0, ...options }),
    inventoryName: connection.name,
    /** The owner removes their own Inventory account, as a teammate who never signed in would be. */
    async disconnectInventory() {
      const removed = await seed.api(den.admin, `/v1/mcp-connections/${connection.id}/disconnect-my-account`, { method: "POST" });
      if (!removed.response.ok) throw new Error(`Disconnecting Inventory failed: HTTP ${removed.response.status}`);
    },
    /** Whether the owner is signed in to Inventory, from the connection list the desktop reads. */
    async inventorySignedIn() {
      const listed = rows(record((await seed.api(den.admin, "/v1/mcp-connections?scope=usable")).body).connections);
      return listed.find(entry => entry.id === connection.id)?.connectedForMe === true;
    },
    /** Clicks a button from the App's own script: a click the host does not trust as user input. */
    async scriptedClick(frame: Surface, label: string) {
      const clicked = await evaluate(frame.client, browserScript((text: string) => {
        const button = Array.from(document.querySelectorAll("button")).find(candidate => candidate.textContent?.trim() === text);
        button?.click();
        return Boolean(button);
      }, [label]));
      if (!clicked) throw new Error(`The App has no ${label} button`);
    },
    /** The App frame, by title, that shows the given text: a reloaded App replaces a frame the browser may still list. */
    async appFrameShowing(title: string, text: string): Promise<Surface & AsyncDisposable> {
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        for (const target of (await listTargets(app.handle.cdpUrl)).filter(entry => entry.type === "iframe" && entry.url === "about:srcdoc")) {
          const client = await connect(debuggerUrlFor(app.handle.cdpUrl, target));
          const shown = await evaluate(client, browserScript((wanted: string) => [document.title, document.body?.innerText.includes(wanted) ?? false], [text])).catch(() => ["", false]);
          if (Array.isArray(shown) && shown[0] === title && shown[1] === true) {
            return { handle: app.handle, client, [Symbol.asyncDispose]: async () => client.close() };
          }
          client.close();
        }
        await delay(500);
      }
      const seen: string[] = [];
      for (const target of (await listTargets(app.handle.cdpUrl)).filter(entry => entry.type === "iframe")) {
        const client = await connect(debuggerUrlFor(app.handle.cdpUrl, target));
        seen.push(String(await evaluate(client, () => `${document.title} | ${(document.body?.innerText ?? "").slice(0, 200)}`).catch(() => "unreadable")));
        client.close();
      }
      const host = await evaluate(app.client, () => Array.from(document.querySelectorAll("[data-mcp-app-resource], [role=alert], [role=status]")).map(node => `${node.tagName} ${node.getAttribute("role") ?? ""} ${(node.textContent ?? "").slice(0, 160)}`)).catch(() => []);
      throw new Error(`No ${title} frame showed "${text}". Frames: ${JSON.stringify(seen)} Host: ${JSON.stringify(host)}`);
    },
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
      const statuses = await evaluate(app.client, () => Array.from(document.querySelectorAll('[data-dashboard-tile] [role="status"], [data-dashboard-tile] [role="alert"]')).map(node => node.textContent?.trim()).filter(Boolean)).catch(() => []);
      throw new Error(`${title} did not open. Dashboard status: ${JSON.stringify(statuses)}`);
    },
  };
}

export const mcpAppServersChatOwnSignIn = (seed: Seed) => mcpAppServersChat(seed, false, { ownSignIn: true });
export const mcpAppCreationV1 = (seed: Seed) => mcpAppServersChat(seed, false, { engine: "v1", lifecycle: true });
export const mcpAppCreationV2 = (seed: Seed) => mcpAppServersChat(seed, false, { engine: "v2", lifecycle: true });
export const mcpAppCreationDesktop = (seed: Seed) => mcpAppServersChat(seed, false, { engine: "v1", desktop: true, lifecycle: true });
