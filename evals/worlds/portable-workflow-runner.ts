import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chrome } from "@openwork/hosts";
import { connect, debuggerUrlFor, evaluate, listTargets, type Surface } from "@openwork/cdp";
import type { Place, Seed } from "@openwork/env";

export const runnerUri = "ui://openwork/workflow-runner/v1/view.html";
export const runnerTimeZone = "Pacific/Auckland";
export const readyTitle = "Daily runtime";
export const blockedTitle = "Needs a topic";
const fixturePaths = ["/member/", "/outsider/", "/host.js", "/member/rpc", "/outsider/rpc"] as const;

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

export async function buildPortableWorkflowHost() {
  const appRequire = createRequire(new URL("../../apps/app/package.json", import.meta.url));
  const { build } = await import(createRequire(appRequire.resolve("vite")).resolve("esbuild"));
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL("../fixtures/portable-workflow-host.ts", import.meta.url))],
    bundle: true, write: false, platform: "browser", format: "esm", minify: true,
  });
  const html = await readFile(new URL("../fixtures/portable-workflow-host.html", import.meta.url), "utf8");
  return { html, script: String(bundle.outputFiles[0].text) };
}

async function forwardLoopback(browser: Surface, origin: string): Promise<AsyncDisposable> {
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
    // Rebuild the fixture URL from constants so only the known loopback routes are fetched.
    const path = fixturePaths.find(candidate => requested.origin === origin && requested.pathname === candidate);
    if (!path) throw new Error("Refused non-fixture forwarding");
    const method = field(request, "method");
    const response = await fetch(new URL(`${path}${path.endsWith("/") ? "?tool=open_workflows" : ""}`, origin), {
      method,
      headers: method === "POST" ? { origin, "content-type": "application/json" } : {},
      ...(typeof request.postData === "string" ? { body: request.postData } : {}),
      signal: AbortSignal.timeout(95_000),
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
type RequestWitness = { persona: Persona; method: string; params: Record<string, unknown>; result: Record<string, unknown>; resourceDigest?: string };

export async function portableWorkflowRunner(seed: Seed, context: { place: Place }) {
  await using resources = new AsyncDisposableStack();
  const den = await seed.den({
    web: false,
    env: { DEN_GENERATED_ARTIFACT_VIEWS_ENABLED: "false" },
    org: { name: `Portable Workflows ${Date.now()}`, members: { member: { name: "Workflow teammate" }, outsider: { name: "Ungranted teammate" } } },
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
  async function rpc(persona: Persona, method: string, params: Record<string, unknown>, observe = true) {
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
    if (message.error) throw new Error(`Den MCP ${method} rejected the request`);
    const result = record(message.result);
    if (observe) {
      const content = method === "resources/read" ? rows(result.contents)[0] : undefined;
      requests.push({ persona, method, params,
        result: content ? { contents: [{ uri: content.uri, mimeType: content.mimeType }] } : result,
        ...(content ? { resourceDigest: createHash("sha256").update(field(content, "text")).digest("hex") } : {}),
      });
    }
    return result;
  }
  const runtimeSchema = {
    type: "object", additionalProperties: false,
    properties: Object.fromEntries(["now", "today", "timeZone", "dayStart", "dayEnd"].map(key => [key, { type: "string", minLength: 1 }])),
    required: ["now", "today", "timeZone", "dayStart", "dayEnd"],
  };
  async function save(name: string, code: string, inputSchema: Record<string, unknown>, outputSchema: Record<string, unknown>, currentInput?: Record<string, unknown>) {
    const tested = await rpc("owner", "tools/call", {
      name: "execute_capability_script",
      arguments: { code, inputSchema, outputSchema, ...(currentInput ? { input: currentInput } : { mode: "live", timeZone: runnerTimeZone }) },
    }, false);
    if (tested.isError) throw new Error(`Authoring ${name} failed`);
    const metadata = record(record(tested.structuredContent).metadata);
    if (record(metadata.retention).canSaveByReceipt !== true) throw new Error("Recent authoring receipt source retention is unavailable");
    const saved = await seed.api(den.admin, "/v1/workflows", {
      method: "POST", body: JSON.stringify({ name, receiptId: field(metadata, "receiptId"), inputSchema, outputSchema, ...(currentInput ? { currentInput } : {}) }),
    });
    if (saved.response.status !== 201) throw new Error(`Saving ${name} by recent receipt failed: ${saved.response.status}`);
    return { pluginId: field(saved.body, "pluginId"), configObjectId: field(saved.body, "configObjectId"), configObjectVersionId: field(saved.body, "configObjectVersionId") };
  }
  const ready = await save(readyTitle, "return input.runtime;", {
    type: "object", properties: { runtime: runtimeSchema }, required: ["runtime"], additionalProperties: false,
  }, runtimeSchema);
  const topicSchema = { type: "object", properties: { topic: { type: "string" } }, required: ["topic"], additionalProperties: false };
  const blocked = await save(blockedTitle, "return { topic: input.topic };", topicSchema, topicSchema, { topic: "Only authoring has caller input" });
  const membership = rows(org.members).find(entry => field(entry.user, "email") === member.email);
  if (!membership) throw new Error("Synthetic member grant target missing");
  for (const workflow of [ready, blocked]) {
    const grant = await seed.api(den.admin, `/v1/config-objects/${workflow.configObjectId}/access`, {
      method: "POST", body: JSON.stringify({ orgMembershipId: field(membership, "id"), role: "viewer" }),
    });
    if (grant.response.status !== 201) throw new Error(`Workflow grant failed: ${grant.response.status}`);
  }
  const built = await buildPortableWorkflowHost();
  let origin = "";
  const server = createServer((request, response) => {
    void (async () => {
      response.setHeader("Cache-Control", "no-store");
      if (request.headers.host !== new URL(origin).host) { response.writeHead(403).end(); return; }
      const path = new URL(request.url ?? "/", origin).pathname;
      if (request.method === "GET" && ["/member/", "/outsider/"].includes(path)) {
        response.setHeader("Content-Type", "text/html");
        response.end(built.html);
      } else if (request.method === "GET" && path === "/host.js") {
        response.setHeader("Content-Type", "text/javascript");
        response.end(built.script);
      } else if (request.method === "POST" && ["/member/rpc", "/outsider/rpc"].includes(path) && request.headers.origin === origin) {
        let body = "";
        for await (const chunk of request) {
          body += String(chunk);
          if (body.length > 16_384) { response.writeHead(413).end(); return; }
        }
        const message = record(JSON.parse(body));
        const method = field(message, "method");
        const params = record(message.params);
        const allowed = method === "tools/list" || (method === "resources/read" && params.uri === runnerUri)
          || (method === "tools/call" && ["open_workflows", "run_workflow_readonly"].includes(field(params, "name")));
        if (!allowed) { response.writeHead(403).end(); return; }
        const persona = path.startsWith("/member/") ? "member" : "outsider";
        const result = await rpc(persona, method, params);
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
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
  const app = resources.use(await chrome({ name: "portable-workflow-reference-host", host: context.place.host(), startUrl: "about:blank", headless: true }));
  if (context.place.kind !== "local") resources.use(await forwardLoopback(app, origin));
  await app.client.send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 850, deviceScaleFactor: 1, mobile: false });
  await app.client.send("Emulation.setTimezoneOverride", { timezoneId: runnerTimeZone });
  const url = (persona: "member" | "outsider") => `${origin}/${persona}/?tool=open_workflows`;
  const retained = resources.move();
  return {
    app, den, member, outsider, ready, blocked, url, requests,
    call: (persona: Persona, name: string, args: Record<string, unknown>) => rpc(persona, "tools/call", { name, arguments: args }),
    async frame(): Promise<Surface & AsyncDisposable> {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const target = (await listTargets(app.handle.cdpUrl)).find(entry => entry.type === "iframe" && entry.url === "about:srcdoc");
        if (target) {
          const client = await connect(debuggerUrlFor(app.handle.cdpUrl, target));
          try {
            await client.send("Emulation.setTimezoneOverride", { timezoneId: runnerTimeZone });
            await evaluate(client, () => {
              document.documentElement.dataset.trustedRunClicks = "0";
              document.documentElement.dataset.untrustedRunClicks = "0";
              document.addEventListener("click", event => {
                if (!(event.target instanceof Element) || event.target.closest("button")?.textContent !== "Run workflow") return;
                const key = event.isTrusted ? "trustedRunClicks" : "untrustedRunClicks";
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
    hostResourceDigest: () => evaluate(app.client, () => document.getElementById("view")?.dataset.resourceDigest ?? ""),
    clicks: (frame: Surface) => evaluate(frame.client, () => ({ trusted: Number(document.documentElement.dataset.trustedRunClicks), untrusted: Number(document.documentElement.dataset.untrustedRunClicks) })),
    // Trusted keyboard type-ahead for the focused <select>: real keypresses change the
    // value without opening the native popup, which CDP cannot drive inside a sandboxed frame.
    async typeAhead(frame: Surface, text: string) {
      if (!/^[A-Za-z]+$/.test(text)) throw new Error("Type-ahead expects a single word of letters");
      for (const character of text) {
        const key = { key: character, code: `Key${character.toUpperCase()}`, windowsVirtualKeyCode: character.toUpperCase().charCodeAt(0) };
        await frame.client.send("Input.dispatchKeyEvent", { type: "keyDown", ...key, text: character });
        await frame.client.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
      }
    },
    [Symbol.asyncDispose]: () => retained.disposeAsync(),
  };
}
