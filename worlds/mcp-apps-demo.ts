// Seed a ready-to-try App scenario into a running world and print a private test handoff.
//
//   node worlds/mcp-apps-demo.ts                       # inside a Freestyle ACME world
//   node worlds/mcp-apps-demo.ts --den-api <url> --den-web <url> --email <owner> --password <password>
//
// It starts a mock "Inventory" MCP server, connects it to the org, saves two
// Workflows, and builds the "Order calculator" App through OpenWork Connect's
// create_app. The App is its own MCP server with three composed tools:
// todays_date (live Workflow, read-only), lookup_unit_price (Inventory
// connection tool, read-only), and price_total (Workflow with input).
// Output includes disposable tokens: keep it out of logs, PRs, and notes.
import { spawn } from "node:child_process";
import { openSync, readFileSync } from "node:fs";

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readJson(path: string): Json | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function outputValue(outputs: Json | null, key: string): string | undefined {
  const entry = outputs?.[key];
  const value = isRecord(entry) ? entry.value : entry;
  return typeof value === "string" ? value : undefined;
}

const services = readJson("/opt/openwork-preview/services.json");
const outputs = readJson("/opt/openwork-preview/outputs.json");
const access = readJson("/opt/openwork-preview/access.json");
const denApi = flag("den-api") ?? (typeof services?.api === "string" ? services.api : undefined);
const denWeb = flag("den-web") ?? (typeof services?.den === "string" ? services.den : undefined);
const email = flag("email") ?? outputValue(outputs, "alexEmail");
const password = flag("password") ?? outputValue(outputs, "alexPassword");
if (!denApi || !denWeb || !email || !password) {
  throw new Error("Run inside a Freestyle ACME world, or pass --den-api, --den-web, --email, and --password.");
}
const inventoryPort = Number(flag("inventory-port") ?? "39790");
const inventoryUrl = `http://127.0.0.1:${inventoryPort}`;

async function den(path: string, init: RequestInit & { token?: string; orgId?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  headers.set("origin", denWeb ?? "");
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  if (init.orgId) headers.set("x-openwork-org-id", init.orgId);
  const response = await fetch(`${denApi}${path}`, { ...init, headers, signal: AbortSignal.timeout(60_000) });
  const text = await response.text();
  let body: unknown = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  return { status: response.status, body: isRecord(body) ? body : {} };
}

let rpcId = 0;
async function connect(token: string, name: string, args: Json): Promise<Json> {
  const response = await fetch(`${denApi}/mcp/agent`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
    signal: AbortSignal.timeout(120_000),
  });
  const raw = await response.text();
  const data = raw.split("\n").find((line) => line.startsWith("data:"));
  const message: unknown = JSON.parse(data ? data.slice(5) : raw);
  if (!isRecord(message) || !isRecord(message.result)) throw new Error(`${name} failed: ${raw.slice(0, 500)}`);
  return message.result;
}

function structured(result: Json): Json {
  if (isRecord(result.structuredContent)) return result.structuredContent;
  const text = Array.isArray(result.content) ? result.content.find((part) => isRecord(part) && part.type === "text") : undefined;
  const parsed: unknown = isRecord(text) && typeof text.text === "string" ? JSON.parse(text.text) : {};
  return isRecord(parsed) ? parsed : {};
}

async function healthy(url: string) {
  try { return (await fetch(`${url}/health`, { signal: AbortSignal.timeout(2_000) })).ok; } catch { return false; }
}

async function startInventory() {
  if (!await healthy(inventoryUrl)) {
    const log = openSync("/tmp/mcp-apps-demo-inventory.log", "a");
    spawn(process.execPath, ["scripts/mock-oauth-mcp-server.mjs"], {
      detached: true,
      stdio: ["ignore", log, log],
      env: { ...process.env, HOST: "127.0.0.1", PORT: String(inventoryPort), ISSUER: inventoryUrl, AUTO_APPROVE: "1", MOCK_ALLOW_UNAUTHENTICATED_MCP: "1" },
    }).unref();
    const deadline = Date.now() + 30_000;
    while (!await healthy(inventoryUrl)) {
      if (Date.now() > deadline) throw new Error("The mock Inventory MCP server did not start; see /tmp/mcp-apps-demo-inventory.log.");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  const tools = await fetch(`${inventoryUrl}/admin/tools`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tools: [{
      name: "lookup_unit_price",
      description: "Look up a product's unit price.",
      inputSchema: { type: "object", properties: { sku: { type: "string" } }, required: ["sku"], additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false },
      result: { content: [{ type: "text", text: "Unit price 7" }], structuredContent: { sku: "WIDGET-7", unitPrice: 7 }, isError: false },
    }] }),
  });
  if (!tools.ok) throw new Error(`Could not load the Inventory tool: HTTP ${tools.status}`);
}

const signedIn = await den("/api/auth/sign-in/email", { method: "POST", body: JSON.stringify({ email, password }) });
const session = typeof signedIn.body.token === "string" ? signedIn.body.token : "";
if (!session) throw new Error(`Sign-in failed for ${email}: HTTP ${signedIn.status}`);
const org = await den("/v1/org", { token: session });
const orgId = outputValue(outputs, "orgId") ?? (isRecord(org.body.organization) && typeof org.body.organization.id === "string" ? org.body.organization.id : "");
const minted = await den("/v1/mcp/token", { method: "POST", token: session, orgId, body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }) });
const mcpToken = typeof minted.body.token === "string" ? minted.body.token : "";
if (!mcpToken) throw new Error(`Minting an MCP token failed: HTTP ${minted.status}`);

await startInventory();
const connection = await den("/v1/mcp-connections", {
  method: "POST", token: session, orgId,
  body: JSON.stringify({ name: `Inventory ${Date.now().toString(36)}`, url: `${inventoryUrl}/mcp`, authType: "none", credentialMode: "shared", access: { orgWide: true } }),
});
const connectionId = typeof connection.body.id === "string" ? connection.body.id
  : isRecord(connection.body.item) && typeof connection.body.item.id === "string" ? connection.body.item.id : "";
if (!connectionId) throw new Error(`Connecting Inventory failed: HTTP ${connection.status} ${JSON.stringify(connection.body).slice(0, 300)}`);

async function saveWorkflow(name: string, test: Json, schemas: Json) {
  const tested = structured(await connect(mcpToken, "execute_capability_script", test));
  const metadata = isRecord(tested.metadata) ? tested.metadata : {};
  const saved = await den("/v1/workflows", { method: "POST", token: session, orgId, body: JSON.stringify({ name, receiptId: metadata.receiptId, ...schemas }) });
  if (saved.status !== 201) throw new Error(`Saving ${name} failed: HTTP ${saved.status} ${JSON.stringify(saved.body).slice(0, 300)}`);
  return `plugin:${String(saved.body.pluginId)}:${String(saved.body.configObjectId)}`;
}
const run = Date.now().toString(36);
const priceSchema = { type: "object", properties: { quantity: { type: "number" }, unitPrice: { type: "number" } }, required: ["quantity", "unitPrice"], additionalProperties: false };
const totalSchema = { type: "object", properties: { total: { type: "number" } }, required: ["total"], additionalProperties: false };
const priceTotal = await saveWorkflow(`Quantity times unit price ${run}`, {
  code: "return { total: input.quantity * input.unitPrice };", input: { quantity: 6, unitPrice: 7 }, inputSchema: priceSchema, outputSchema: totalSchema,
}, { inputSchema: priceSchema, outputSchema: totalSchema, currentInput: { quantity: 6, unitPrice: 7 } });
const runtimeKeys = ["now", "today", "timeZone", "dayStart", "dayEnd"];
const runtimeSchema = { type: "object", additionalProperties: false, required: ["runtime"], properties: {
  runtime: { type: "object", additionalProperties: false, required: runtimeKeys, properties: Object.fromEntries(runtimeKeys.map((key) => [key, { type: "string" }])) },
} };
const todaySchema = { type: "object", properties: { today: { type: "string" } }, required: ["today"], additionalProperties: false };
const todaysDate = await saveWorkflow(`Today's pricing date ${run}`, {
  mode: "live", code: "return { today: input.runtime.today };", inputSchema: runtimeSchema, outputSchema: todaySchema,
}, { inputSchema: runtimeSchema, outputSchema: todaySchema });

const reactSource = `function payload(reply) {
  if (reply.structuredContent) return reply.structuredContent;
  const text = reply.content.find(part => part.type === "text");
  return text ? JSON.parse(text.text) : {};
}
export default function OrderCalculator({ app, input }) {
  const [today, setToday] = React.useState(null);
  const [sku, setSku] = React.useState(input.sku ?? "WIDGET-7");
  const [quantity, setQuantity] = React.useState(String(input.quantity ?? 6));
  const [price, setPrice] = React.useState(null);
  const [total, setTotal] = React.useState(null);
  const [status, setStatus] = React.useState("");
  const toolsAvailable = Boolean(app.getHostCapabilities()?.serverTools);
  React.useEffect(() => {
    if (!toolsAvailable) return;
    app.callServerTool({ name: "todays_date", arguments: {} })
      .then(reply => setToday(reply.isError ? null : payload(reply).value?.today))
      .catch(() => setToday(null));
  }, [app, toolsAvailable]);
  async function calculate() {
    setStatus("Calculating"); setTotal(null);
    try {
      const lookup = await app.callServerTool({ name: "lookup_unit_price", arguments: { sku } });
      if (lookup.isError) throw new Error("Price lookup failed");
      const unitPrice = payload(lookup).unitPrice;
      setPrice(unitPrice);
      const reply = await app.callServerTool({ name: "price_total", arguments: { quantity: Number(quantity), unitPrice } });
      if (reply.isError) throw new Error(payload(reply).message || "The calculation failed");
      setTotal(payload(reply).value?.total);
      setStatus("");
    } catch (error) { setStatus(error.message); }
  }
  return <main>
    <h1>Order calculator</h1>
    {!toolsAvailable && <p role="status">Server tools unavailable. Open this App in a host that enables server tools.</p>}
    <p>{today ? "Prices as of " + today : "Loading pricing date"}</p>
    <label>Product <input value={sku} onChange={event => setSku(event.target.value)} /></label>
    <label>Quantity <input type="number" min="1" value={quantity} onChange={event => setQuantity(event.target.value)} /></label>
    <button type="button" disabled={!toolsAvailable} onClick={calculate}>Calculate total</button>
    {price !== null && <p>Unit price {price}</p>}
    {status && <p role="status">{status}</p>}
    {total !== null && <output aria-label="Total">Total {total}</output>}
  </main>;
}`;
const cssSource = `main { font: 13px/1.5 system-ui, sans-serif; padding: 16px; display: grid; gap: 10px; max-width: 360px; }
h1 { font-size: 16px; margin: 0; } label { display: grid; gap: 4px; } input, button { font: inherit; padding: 6px 10px; }
output { font-size: 18px; font-weight: 600; }`;
let title = "Order calculator";
let created: Json = {};
for (let attempt = 0; attempt < 5; attempt += 1) {
  created = await connect(mcpToken, "create_app", {
    title, description: "Price an order with Inventory and two Workflows.",
    textFallback: "Order calculator: look up a unit price in Inventory and multiply it by a quantity.",
    reactSource, cssSource,
    tools: [
      { name: "todays_date", description: "Today's pricing date for the viewer.", capability: todaysDate, mode: "live" },
      { name: "lookup_unit_price", description: "Look up a product's unit price in Inventory.", capability: `mcp:${connectionId}:lookup_unit_price` },
      { name: "price_total", description: "Multiply a quantity by a unit price.", capability: priceTotal },
    ],
  });
  if (!created.isError) break;
  if (!JSON.stringify(created).includes("duplicate_plugin")) throw new Error(`create_app failed: ${JSON.stringify(created).slice(0, 500)}`);
  title = `Order calculator ${attempt + 2}`;
}
if (created.isError) throw new Error(`create_app failed: ${JSON.stringify(created).slice(0, 500)}`);
const result = structured(created);
const app = isRecord(result.app) ? result.app : {};

// Den answers with its template origins; the gateway serves them at this clone's origins.
function publicUrl(url: string): string {
  const templates = isRecord(access?.templateOrigins) ? access.templateOrigins : {};
  const origins = isRecord(access?.origins) ? access.origins : {};
  for (const [name, template] of Object.entries(templates)) {
    const origin = origins[name];
    if (typeof template === "string" && typeof origin === "string" && url.startsWith(template)) return origin + url.slice(template.length);
  }
  return url;
}
const appUrl = publicUrl(String(result.mcpUrl));
const connectUrl = appUrl.replace(/\/connections\/[^/]+$/u, "");
const denOrigin = isRecord(access?.origins) && typeof access.origins.den === "string" ? access.origins.den : denWeb;
const cookie = typeof access?.token === "string" ? `__Host-openwork-preview=${access.token}` : null;
const headers = [`Authorization: Bearer ${mcpToken}`, ...(cookie ? [`Cookie: ${cookie}`] : [])];
const headerFlags = headers.map((header) => `--header "${header}"`).join(" ");

console.log(JSON.stringify({
  app: { title: app.title, appId: app.appId, pluginId: app.pluginId, revisionId: app.revisionId, tools: app.tools },
  appMcpUrl: appUrl,
  connectMcpUrl: connectUrl,
  pluginPage: `${denOrigin}/dashboard/library/plugins/${String(app.pluginId)}`,
  signIn: { email, password },
  headers,
  claudeCode: {
    app: `claude mcp add --transport http order-calculator ${appUrl} ${headerFlags}`,
    connect: `claude mcp add --transport http openwork-connect ${connectUrl} ${headerFlags}`,
  },
  referenceHost: `node evals/fixtures/standard-mcp-app-host-serve.ts --url ${appUrl} ${headerFlags}`,
  expires: typeof access?.expiresAt === "string" ? access.expiresAt : null,
}, null, 2));
