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
// No token overlap with the App title or launch tool name: search_capabilities also
// matches authored Apps, and the proof counts exactly one Workflow match.
export const procedureTitle = "Quantity times unit price";
export const launchInput = { quantity: 6, unitPrice: 7 };
const fixturePaths = ["/owner/", "/member/", "/outsider/", "/blocked/", "/host.js", "/owner/rpc", "/member/rpc", "/outsider/rpc", "/blocked/rpc"];

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
    title: field(app, "title"), toolName: field(app, "toolName"), resourceUri: field(app, "resourceUri"),
  };
}

export function appSource(revision: string) {
  return {
    title: appTitle,
    textFallback: `${appTitle} is ready. Open the App to find capabilities and run a procedure.`,
    reactSource: `function payload(reply) {
      if (reply.structuredContent) return reply.structuredContent;
      const text = reply.content.find(part => part.type === "text");
      if (!text) throw new Error("Tool returned no JSON result");
      return JSON.parse(text.text);
    }
    export default function Calculator({ app, input, result, hostContext }) {
      const [matches, setMatches] = React.useState(null);
      const [answer, setAnswer] = React.useState(null);
      const [failure, setFailure] = React.useState("");
      const [writeResult, setWriteResult] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [height, setHeight] = React.useState(0);
      const toolsAvailable = Boolean(app.getHostCapabilities()?.serverTools);
      const procedure = matches?.find(match => match.kind === "workflow");
      async function find() {
        setBusy(true); setFailure("");
        try {
          const reply = await app.callServerTool({ name: "search_capabilities", arguments: { query: ${JSON.stringify(procedureTitle)}, type: "marketplace" } });
          const next = payload(reply);
          if (reply.isError || !Array.isArray(next.matches)) throw new Error(next.message || "Search unavailable");
          setMatches(next.matches);
        } catch (error) { setFailure(error.message); }
        finally { setBusy(false); }
      }
      async function run() {
        setBusy(true); setFailure("");
        try {
          const reply = await app.callServerTool({ name: "execute_capability", arguments: { name: procedure.name, body: input } });
          const next = payload(reply);
          if (reply.isError) throw new Error(next.message || "Procedure failed");
          setAnswer(next);
        } catch (error) { setFailure(error.message); }
        finally { setBusy(false); }
      }
      async function checkWrite() {
        try {
          const reply = await app.callServerTool({ name: "create_app", arguments: {
            title: "Read scope must not create this", textFallback: "Must not be created",
            reactSource: "export default function View() { return <p>Must not be created</p> }"
          } });
          setWriteResult(payload(reply));
        } catch (error) { setFailure(error.message); }
      }
      return <main style={{ minHeight: height }}>
        <header><h1>${appTitle}</h1><span>Ready — ${revision}</span></header>
        {!toolsAvailable && <p role="status">Server tools unavailable. Reopen in a host that enables server tools.</p>}
        <p>Theme: {hostContext?.theme}</p>
        <output data-testid="launch-input" aria-label="Launch input">{JSON.stringify(input)}</output>
        <output data-testid="launch-result" aria-label="Launch result">{result?.structuredContent?.app?.title}</output>
        <div className="actions">
          <button type="button" disabled={!toolsAvailable || busy} onClick={find}>Find capabilities</button>
          <button type="button" disabled={!toolsAvailable || busy || !procedure} onClick={run}>Run procedure</button>
        </div>
        {busy && <p role="status">Waiting for the tool result</p>}
        {matches && <p role="status">{matches.length === 1 ? "1 capability found" : matches.length + " capabilities found"}</p>}
        {matches?.length === 0 && <p>No procedure available. Ask its owner to share it.</p>}
        {failure && <p role="alert">{failure}</p>}
        {answer && <output data-testid="procedure-result" aria-label="Procedure result">{JSON.stringify(answer.value)}</output>}
        <details><summary>View options</summary><div className="actions">
          <button type="button" onClick={() => setHeight(520)}>Expand content</button>
          <button type="button" onClick={async () => { setHeight(900); await app.sendSizeChanged({ height: 1200 }); }}>Request height</button>
          <button type="button" disabled={!toolsAvailable} onClick={checkWrite}>Check write access</button>
        </div></details>
        {writeResult && <output data-testid="write-result" aria-label="Write result">{JSON.stringify(writeResult)}</output>}
      </main>;
    }`,
    cssSource: `:root { font: 13px/1.5 system-ui, sans-serif; color: var(--color-text-primary, #1c2024); background: var(--color-background-primary, #f8f9fa); }
      body { margin: 0; } main { box-sizing: border-box; padding: 16px; } header { display: flex; align-items: center; gap: 16px; height: 40px; }
      h1 { font-size: 18px; font-weight: 600; } .actions { display: flex; gap: 12px; padding: 12px 0; }
      button { font: inherit; padding: 8px 12px; } output { display: block; overflow-wrap: anywhere; } details { padding-top: 12px; }`,
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

async function forwardLoopback(browser: Surface, origin: string, toolName: string): Promise<AsyncDisposable> {
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
    const response = await fetch(new URL(`${path}${path.endsWith("/") ? `?tool=${encodeURIComponent(toolName)}` : ""}`, origin), {
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
type RequestWitness = { persona: Persona; via: "setup" | "client"; method: string; params: Record<string, unknown>; result: Record<string, unknown>; resourceDigest?: string };

export async function generatedMcpApps(seed: Seed, context: { place: Place }) {
  await using resources = new AsyncDisposableStack();
  const den = await seed.den({
    web: true,
    env: { DEN_GENERATED_ARTIFACT_VIEWS_ENABLED: "true" },
    org: { name: `Generated Apps ${Date.now()}`, members: { member: { name: "App teammate" }, outsider: { name: "Ungranted teammate" } } },
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
      body: JSON.stringify({ scopes: persona === "owner" ? ["mcp:read", "mcp:write"] : ["mcp:read"] }),
    });
    if (!minted.response.ok) throw new Error(`MCP token setup failed: ${minted.response.status}`);
    tokens.set(persona, field(minted.body, "token"));
  }
  let sequence = 0;
  const requests: RequestWitness[] = [];
  async function rpc(persona: Persona, method: string, params: Record<string, unknown>, via: "setup" | "client" = "setup") {
    const response = await fetch(`${den.ref.apiUrl}/mcp/agent`, {
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
    requests.push({ persona, via, method, params,
      result: content ? { contents: [{ uri: content.uri, mimeType: content.mimeType, _meta: content._meta }] } : result,
      ...(content ? { resourceDigest: createHash("sha256").update(field(content, "text")).digest("hex") } : {}),
    });
    return result;
  }
  const call = (persona: Persona, name: string, args: Record<string, unknown>) => rpc(persona, "tools/call", { name, arguments: args });
  const workflowsBefore = await seed.api(den.admin, "/v1/workflows");
  if (!workflowsBefore.response.ok) throw new Error("Could not inspect initial Workflows");
  const created = appSummary(await call("owner", "create_app", appSource("revision one")));
  const membership = rows(org.members).find(entry => field(entry.user, "email") === member.email);
  if (!membership) throw new Error("Synthetic member grant target missing");
  const memberId = field(membership, "id");
  async function grant(path: string) {
    const result = await seed.api(den.admin, path, {
      method: "POST", body: JSON.stringify({ orgMembershipId: memberId, role: "viewer" }),
    });
    if (result.response.status !== 201) throw new Error(`Viewer grant failed: ${result.response.status}`);
  }
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
        const result = await rpc(persona, method, params, "client");
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
  const app = resources.use(await chrome({ name: "standard-mcp-app-reference-host", host: context.place.host(), startUrl: "about:blank", headless: true }));
  if (context.place.kind !== "local") resources.use(await forwardLoopback(app, origin, created.toolName));
  await app.client.send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 1050, deviceScaleFactor: 1, mobile: false });
  const pluginWeb = await seed.web({ den, signedInAs: member, startPath: "/dashboard/library", headless: true, viewport: { width: 1280, height: 900 } });
  const url = (persona: Persona | "blocked") => `${origin}/${persona}/?tool=${encodeURIComponent(created.toolName)}`;
  const retained = resources.move();
  return {
    app, pluginWeb, den, member, outsider, created, url, requests, rpc, call,
    workflowsBefore: rows(record(workflowsBefore.body).items),
    shareApp: () => grant(`/v1/plugins/${created.pluginId}/access`),
    async update() {
      const current = payload(await call("owner", "read_app", { appId: created.appId }));
      const updated = appSummary(await call("owner", "update_app", {
        ...appSource("revision two"), appId: created.appId, expectedRevisionId: field(current.app, "revisionId"),
      }));
      return { current, updated };
    },
    async seedProcedure() {
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
      const workflow = { pluginId: field(saved.body, "pluginId"), configObjectId: field(saved.body, "configObjectId"), configObjectVersionId: field(saved.body, "configObjectVersionId") };
      await grant(`/v1/config-objects/${workflow.configObjectId}/access`);
      return workflow;
    },
    async frame(): Promise<Surface & AsyncDisposable> {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const target = (await listTargets(app.handle.cdpUrl)).find(entry => entry.type === "iframe" && entry.url === "about:srcdoc");
        if (target) {
          const client = await connect(debuggerUrlFor(app.handle.cdpUrl, target));
          try {
            await evaluate(client, () => {
              document.documentElement.dataset.trustedClicks = "0";
              document.documentElement.dataset.untrustedClicks = "0";
              document.addEventListener("click", event => {
                if (!(event.target instanceof Element) || !event.target.closest("button")) return;
                const key = event.isTrusted ? "trustedClicks" : "untrustedClicks";
                document.documentElement.dataset[key] = String(Number(document.documentElement.dataset[key]) + 1);
              }, { capture: true });
            });
            return { handle: app.handle, client, [Symbol.asyncDispose]: async () => client.close() };
          } catch (error) { client.close(); throw error; }
        }
        await delay(100);
      }
      throw new Error("The served app iframe was not available for trusted browser input");
    },
    hostState: () => evaluate(app.client, () => ({
      digest: document.getElementById("view")?.dataset.resourceDigest ?? "",
      uri: document.getElementById("view")?.dataset.resourceUri ?? "",
      sizeEvents: document.getElementById("view")?.dataset.sizeEvents ?? "[]",
      url: location.href,
    })),
    clicks: (frame: Surface) => evaluate(frame.client, () => ({ trusted: Number(document.documentElement.dataset.trustedClicks), untrusted: Number(document.documentElement.dataset.untrustedClicks) })),
    [Symbol.asyncDispose]: () => retained.disposeAsync(),
  };
}
