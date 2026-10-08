import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type RequestListener, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { denFetch } from "@openwork/behaviors";
import { allocateFreePorts, browserScript, clickAt, connect, debuggerUrlFor, emulateFocus, evaluate, listTargets, type CdpClient, type Surface } from "@openwork/cdp";
import { chrome } from "@openwork/hosts";
import type { Place, Seed } from "@openwork/env";
import { bootWorkbot, enableWorkbot, signInWorkbot } from "../../worlds/lib/workbot.ts";

/**
 * Real Workbot, runner, OAuth and Den, with Apps on: an Inventory MCP server whose stock check opens a standard MCP
 * App (fixtures/workbot-stock-app.ts), and an App built in OpenWork ("Price check") over the same server. The model is
 * scripted and holds requests to Anthropic's rules; it opens the Apps with execute_capability, as a real model does
 * after search_capabilities.
 */

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
const text = (value: string): Block => ({ type: "text", text: value });
const tool = (name: string, input: Record<string, unknown>): Block => ({ type: "tool_use", id: `toolu_${randomUUID().replaceAll("-", "").slice(0, 24)}`, name, input });

const HELLO = "Hi again, Alex. What can I help with today?";
const STOCK = "Check the stock for WIDGET-7.";
const STOCK_REPLY = "Here's the stock check.";
const ASK = "What did I just reserve?";
const RESERVATION = "RES-7001";
const ASK_REPLY = `You reserved 6 of WIDGET-7 (${RESERVATION}).`;
const PRICE = "Open the price check.";
const PRICE_REPLY = "Here's the price check.";
const STOCK_TITLE = "Stock check";
const PRICE_TITLE = "Price check";
/** What open Apps report reaches the model under this line (the runner's own words). */
const APP_STATE = "What the person's open Apps show";

const priceCheckSource = `function payload(reply) {
  if (reply.structuredContent) return reply.structuredContent;
  const part = reply.content.find(entry => entry.type === "text");
  return part ? JSON.parse(part.text) : {};
}
export default function PriceCheck({ app }) {
  const [price, setPrice] = React.useState(null);
  const [failure, setFailure] = React.useState("");
  React.useEffect(() => {
    // The provider marks the lookup read-only, so it runs as the App opens, without a click.
    app.callServerTool({ name: "lookup_unit_price", arguments: { sku: "WIDGET-7" } })
      .then(reply => { if (reply.isError) throw new Error("The price lookup failed"); setPrice(payload(reply).unitPrice); })
      .catch(error => setFailure(error.message));
  }, [app]);
  return <main>
    <h1>${PRICE_TITLE}</h1>
    <p data-testid="price">{price === null ? "Looking up WIDGET-7" : "WIDGET-7 costs " + price}</p>
    {failure && <p role="alert">{failure}</p>}
  </main>;
}`;

async function listen(stack: AsyncDisposableStack, handle: RequestListener) {
  const server = createServer(handle);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  stack.defer(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Workbot Apps fixture did not bind");
  return `http://127.0.0.1:${address.port}`;
}

async function bodyOf(request: AsyncIterable<Buffer | string>) {
  const chunks: Buffer[] = [];
  for await (const part of request) chunks.push(Buffer.isBuffer(part) ? part : Buffer.from(part));
  return Buffer.concat(chunks).toString("utf8");
}

function reply(response: ServerResponse, blocks: Block[], streamed: boolean) {
  const stop = blocks.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn";
  const message = { id: `msg_${randomUUID()}`, type: "message", role: "assistant", model: "workbot-apps", content: blocks,
    stop_reason: stop, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 20 } };
  if (!streamed) { response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(message)); return; }
  response.writeHead(200, { "content-type": "text/event-stream" });
  const send = (event: Record<string, unknown>) => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  send({ type: "message_start", message: { ...message, content: [], stop_reason: null } });
  for (const [index, block] of blocks.entries()) {
    send({ type: "content_block_start", index, content_block: block.type === "text" ? { type: "text", text: "" } : { ...block, input: {} } });
    send({ type: "content_block_delta", index, delta: block.type === "text" ? { type: "text_delta", text: block.text } : { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
    send({ type: "content_block_stop", index });
  }
  send({ type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 20 } });
  send({ type: "message_stop" });
  response.end();
}

const blocksOf = (message: Record<string, unknown>) => (Array.isArray(message.content) ? message.content.filter(record) : []);

/** The Stock check App's page: the fixture and the official App SDK in one document, as a provider serves it. */
async function stockCheckHtml() {
  const appRequire = createRequire(new URL("../../apps/app/package.json", import.meta.url));
  const { build } = await import(createRequire(appRequire.resolve("vite")).resolve("esbuild"));
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL("./fixtures/workbot-stock-app.ts", import.meta.url))],
    bundle: true, write: false, platform: "browser", format: "esm", target: "es2022", minify: true,
  });
  const script = String(bundle.outputFiles[0].text).replaceAll("</script", "<\\/script");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${STOCK_TITLE}</title>
<style>body{margin:0;font:13px/1.5 system-ui,sans-serif}main{display:grid;gap:8px;padding:16px}button{font:inherit;padding:6px 10px;justify-self:start}</style>
</head><body><main><p id="stock" data-testid="stock">Checking stock</p><button id="reserve" type="button">Reserve 6</button><button id="ask" type="button">Ask Workbot about it</button><p id="reservation" data-testid="reservation"></p><p id="guard" data-testid="guard"></p></main><script type="module">${script}</script></body></html>`;
}

/** The Inventory MCP server (the repo's mock), with a stock check that opens an App, a reservation and a price lookup. */
async function startInventory(stack: AsyncDisposableStack) {
  const [port] = await allocateFreePorts(1);
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["scripts/mock-oauth-mcp-server.mjs"], {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", HOST: "127.0.0.1", PORT: String(port), ISSUER: url, AUTO_APPROVE: "1", MOCK_ALLOW_UNAUTHENTICATED_MCP: "1" },
    stdio: "ignore",
  });
  stack.defer(() => { child.kill("SIGTERM"); });
  const deadline = Date.now() + 30_000;
  while (!(await fetch(`${url}/health`, { signal: AbortSignal.timeout(2_000) }).then((response) => response.ok).catch(() => false))) {
    if (Date.now() > deadline || child.exitCode !== null) throw new Error("The mock Inventory MCP server did not start");
    await delay(250);
  }
  const sku = { type: "object", properties: { sku: { type: "string" } }, required: ["sku"], additionalProperties: false };
  const order = { type: "object", properties: { sku: { type: "string" }, quantity: { type: "number" } }, required: ["sku", "quantity"], additionalProperties: false };
  const tools = [
    {
      name: "check_stock", title: STOCK_TITLE, description: "Check a product's stock, in an App.", inputSchema: sku,
      annotations: { readOnlyHint: true, destructiveHint: false },
      _meta: { ui: { resourceUri: "ui://inventory/stock-check.html" } },
      appHtml: await stockCheckHtml(),
      result: { content: [{ type: "text", text: "WIDGET-7: 12 in stock" }], structuredContent: { sku: "WIDGET-7", inStock: 12 }, isError: false },
    },
    {
      // Changes something, so its provider doesn't mark it read-only: an App runs it only on a click.
      name: "reserve_stock", description: "Reserve stock for an order.", inputSchema: order,
      annotations: { readOnlyHint: false, destructiveHint: false },
      result: { content: [{ type: "text", text: "Reserved 6 of WIDGET-7" }], structuredContent: { reservationId: RESERVATION, sku: "WIDGET-7", quantity: 6 }, isError: false },
    },
    {
      name: "lookup_unit_price", description: "Look up a product's unit price.", inputSchema: sku,
      annotations: { readOnlyHint: true, destructiveHint: false },
      result: { content: [{ type: "text", text: "Unit price 7" }], structuredContent: { sku: "WIDGET-7", unitPrice: 7 }, isError: false },
    },
  ];
  const configured = await fetch(`${url}/admin/tools`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tools }) });
  if (!configured.ok) throw new Error(`Could not load the Inventory tools: HTTP ${configured.status}`);
  return `${url}/mcp`;
}

/** One App in the conversation, for the spec: what its elements show, and a person's click on its buttons. */
export type AppView = AsyncDisposable & {
  /** Waits until the App's element with this test id shows the text, and returns what it shows. */
  sees(testId: string, text: string | RegExp, timeoutMs?: number): Promise<string>;
  /** Everything the App shows. */
  text(): Promise<string>;
  /** Clicks the App's button the way a person does: the browser's own input, at the button on the page. */
  click(label: string): Promise<void>;
};

/** The App's frame inside a sandbox, when that App has this title; null otherwise. */
async function openAppView(browser: Surface, sandbox: CdpClient, title: string): Promise<AppView | null> {
  const tree = await sandbox.send("Page.getFrameTree");
  const child = record(tree) && record(tree.frameTree) && Array.isArray(tree.frameTree.childFrames) ? tree.frameTree.childFrames.find(record) : undefined;
  const frameId = child && record(child.frame) && typeof child.frame.id === "string" ? child.frame.id : null;
  if (!frameId) return null;
  // Headless windows aren't focused; the sandbox counts a click only while the App's frame has focus, as a real one does.
  await sandbox.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => undefined);
  const world = await sandbox.send("Page.createIsolatedWorld", { frameId, worldName: "workbot-apps-spec" });
  const contextId = record(world) && typeof world.executionContextId === "number" ? world.executionContextId : null;
  if (contextId === null) return null;
  const read = async (expression: string): Promise<unknown> => {
    const result = await sandbox.send("Runtime.evaluate", { expression, contextId, returnByValue: true });
    return record(result) && record(result.result) ? result.result.value : undefined;
  };
  if (await read("document.title") !== title) return null;
  const textOf = async (testId: string) => String(await read(`document.querySelector(${JSON.stringify(`[data-testid="${testId}"]`)})?.textContent ?? ""`));
  return {
    async sees(testId, expected, timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs;
      let shown = "";
      while (Date.now() < deadline) {
        shown = await textOf(testId);
        if (typeof expected === "string" ? shown.includes(expected) : expected.test(shown)) return shown;
        await delay(200);
      }
      throw new Error(`${title} shows "${shown}" in ${testId}, not ${String(expected)}`);
    },
    text: async () => String(await read("document.body.innerText")),
    async click(label) {
      // The App fills its sandbox, which fills the frame on the page: the button's place on the page is the sum.
      const where = async () => {
        const inner = await read(`(() => { const button = Array.from(document.querySelectorAll("button")).find((entry) => entry.textContent.trim() === ${JSON.stringify(label)}); if (!button) return null; const box = button.getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; })()`);
        const frame = await evaluate(browser.client, browserScript((name: string) => {
          const element = Array.from(document.querySelectorAll("[data-workbot-app] iframe")).find((entry) => entry.getAttribute("title") === name);
          if (!element) return null;
          element.scrollIntoView({ block: "center", behavior: "instant" });
          const box = element.getBoundingClientRect();
          return { x: box.x, y: box.y };
        }, [title]));
        return record(inner) && typeof inner.x === "number" && typeof inner.y === "number" && frame ? { x: frame.x + inner.x, y: frame.y + inner.y } : null;
      };
      // The chat keeps the newest reply in view and an App resizes as it renders: click once the button has settled.
      const deadline = Date.now() + 5_000;
      let point = await where();
      while (Date.now() < deadline) {
        await delay(150);
        const next = await where();
        if (point && next && Math.abs(point.x - next.x) < 1 && Math.abs(point.y - next.y) < 1) break;
        point = next;
      }
      if (!point) throw new Error(`${title} has no "${label}" button on the page`);
      await clickAt(browser, point);
    },
    async [Symbol.asyncDispose]() { sandbox.close(); },
  };
}

export async function workbotApps(_seed: Seed, context: { place: Place }) {
  if (context.place.kind !== "local") throw new Error("Workbot's isolated MySQL journey requires --local");
  const stack = new AsyncDisposableStack();
  const witness = { requests: 0, sawReservation: false, sawLaunchMeta: false };
  const names = { stock: "", price: "" };
  try {
    const key = randomUUID();
    const upstream = await listen(stack, async (request, response) => {
      if (request.method !== "POST" || request.url !== "/v1/messages") { response.writeHead(404).end(); return; }
      if (request.headers["x-api-key"] !== key) { response.writeHead(401).end(); return; }
      try {
        const raw: unknown = JSON.parse(await bodyOf(request));
        if (!record(raw) || !Array.isArray(raw.messages)) throw new Error("Invalid model request");
        witness.requests += 1;
        const messages = raw.messages.filter(record);
        const transcript = JSON.stringify(messages);
        if (transcript.includes("openwork/mcpApp")) witness.sawLaunchMeta = true;
        const userTexts = messages.filter((message) => message.role === "user").flatMap((message) => blocksOf(message).filter((block) => block.type === "text").map((block) => String(block.text)));
        // The person's words; what open Apps report rides along after them.
        const prompt = [...userTexts].reverse().find((entry) => !entry.startsWith(APP_STATE)) ?? "";
        const promptIndex = messages.findLastIndex((message) => message.role === "user" && blocksOf(message).some((block) => block.type === "text" && block.text === prompt));
        const called = messages.slice(Math.max(0, promptIndex)).some((message) => blocksOf(message).some((block) => block.type === "tool_use"));
        let blocks: Block[];
        if (prompt.includes("just opened Workbot for the first time")) blocks = [text(HELLO)];
        else if (prompt.includes(STOCK)) blocks = called ? [text(STOCK_REPLY)] : [text("Checking."), tool("execute_capability", { name: names.stock, body: { sku: "WIDGET-7" } })];
        else if (prompt.includes(PRICE)) blocks = called ? [text(PRICE_REPLY)] : [tool("execute_capability", { name: names.price })];
        else if (prompt.includes(ASK)) {
          witness.sawReservation = userTexts.some((entry) => entry.startsWith(APP_STATE) && entry.includes(RESERVATION));
          blocks = [text(witness.sawReservation ? ASK_REPLY : "I can't see what you reserved.")];
        } else blocks = [text("I can help with that.")];
        reply(response, blocks, raw.stream === true);
      } catch { response.writeHead(400).end(); }
    });
    const world = await bootWorkbot(stack, undefined, {
      live: false,
      upstream: { baseUrl: upstream, key, model: "workbot-apps" },
      // Apps built in OpenWork are on in production; eval Dens leave them off unless asked.
      denEnv: { DEN_APP_MCP_SERVERS_ENABLED: "true" },
      features: { workbotApps: true },
    });
    const admin = world.den.admin;
    const orgHeaders = { authorization: `Bearer ${admin.token}`, "x-openwork-org-id": world.orgId };
    const inventoryUrl = await startInventory(stack);
    const connection = await denFetch(admin, "/v1/mcp-connections", {
      method: "POST", headers: orgHeaders,
      body: JSON.stringify({ name: `Inventory ${Date.now().toString(36)}`, url: inventoryUrl, authType: "none", credentialMode: "shared", access: { orgWide: true } }),
    });
    const connectionId = record(connection.body) && typeof connection.body.id === "string" ? connection.body.id
      : record(connection.body) && record(connection.body.item) && typeof connection.body.item.id === "string" ? connection.body.item.id : "";
    if (!connectionId) throw new Error(`Connecting Inventory failed: HTTP ${connection.response.status} ${connection.text.slice(0, 300)}`);
    names.stock = `mcp:${connectionId}:check_stock`;

    // The owner builds the Price check App through OpenWork Connect, as the desktop's agent does.
    const minted = await denFetch(admin, "/v1/mcp/token", { method: "POST", headers: orgHeaders, body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }) });
    const mcpToken = record(minted.body) && typeof minted.body.token === "string" ? minted.body.token : "";
    if (!mcpToken) throw new Error(`Minting an MCP token failed: HTTP ${minted.response.status}`);
    const created = await fetch(`${world.den.ref.apiUrl}/mcp/agent`, {
      method: "POST",
      headers: { authorization: `Bearer ${mcpToken}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_app", arguments: {
        title: PRICE_TITLE, description: "The unit price of WIDGET-7 from Inventory.",
        textFallback: "Price check: the unit price of WIDGET-7 from Inventory.",
        reactSource: priceCheckSource, cssSource: "main { font: 13px/1.5 system-ui, sans-serif; padding: 16px; } h1 { font-size: 15px; margin: 0 0 8px; }",
        tools: [{ name: "lookup_unit_price", description: "Look up a product's unit price in Inventory.", capability: `mcp:${connectionId}:lookup_unit_price` }],
      } } }),
      signal: AbortSignal.timeout(120_000),
    });
    const raw = await created.text();
    const data = raw.split("\n").find((line) => line.startsWith("data:"));
    const message: unknown = JSON.parse(data ? data.slice(5) : raw);
    const result = record(message) && record(message.result) ? message.result : null;
    const app = result && record(result.structuredContent) && record(result.structuredContent.app) ? result.structuredContent.app : null;
    if (!result || result.isError || !app || typeof app.pluginId !== "string" || typeof app.appId !== "string") throw new Error(`create_app failed: ${raw.slice(0, 500)}`);
    names.price = `plugin:${app.pluginId}:${app.appId}`;

    const login = await signInWorkbot(world);
    const browser = stack.use(await chrome({ name: "workbot-apps", host: context.place.host(), headless: true, startUrl: "about:blank" }));
    await emulateFocus(browser);
    await browser.client.send("Network.setCookies", { cookies: login.cookie.split("; ").map((entry) => {
      const split = entry.indexOf("=");
      return { name: entry.slice(0, split), value: entry.slice(split + 1), url: world.workbotUrl, httpOnly: true, sameSite: "Lax" };
    }) });
    return {
      app: browser, url: world.workbotUrl,
      hello: HELLO, stock: STOCK, stockReply: STOCK_REPLY, ask: ASK, askReply: ASK_REPLY, price: PRICE, priceReply: PRICE_REPLY,
      stockTitle: STOCK_TITLE, priceTitle: PRICE_TITLE, reservation: RESERVATION,
      witness: () => ({ ...witness }),
      thread: async () => (await login.call("/v1/workbot?turns=30")).json(),
      /** Turns Workbot's Apps on or off for the organization, as a platform admin does in /admin. */
      setApps: async (on: boolean) => { await enableWorkbot(world.den, { workbotApps: on }); },
      /**
       * An App in the conversation, by its page title: its own document, read inside its sandbox (the sandbox page runs
       * in its own process and the App's frame inside it), and clicked the way a person does, through the page.
       */
      async appView(title: string): Promise<AppView> {
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline) {
          for (const target of (await listTargets(browser.handle.cdpUrl)).filter((entry) => entry.type === "iframe" && entry.url.includes("/mcp-apps/sandbox.html"))) {
            const client = await connect(debuggerUrlFor(browser.handle.cdpUrl, target));
            const view = await openAppView(browser, client, title).catch(() => null);
            if (view) return view;
            client.close();
          }
          await delay(250);
        }
        const cards = await evaluate(browser.client, () => Array.from(document.querySelectorAll("[data-workbot-app]")).map((card) => card.textContent?.trim())).catch(() => []);
        throw new Error(`${title} did not open in the conversation. Cards: ${JSON.stringify(cards)}`);
      },
      async [Symbol.asyncDispose]() { await stack.disposeAsync(); },
    };
  } catch (error) { await stack.disposeAsync(); throw error; }
}
