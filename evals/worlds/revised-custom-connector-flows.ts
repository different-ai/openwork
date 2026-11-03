import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { connect, debuggerUrlFor, listTargets, type Surface } from "@openwork/cdp";
import type { Seed } from "@openwork/env";

export const DEMO_CLIENT = "synthetic-review-client";
export const DEMO_SECRET = "synthetic-review-secret";
export const DEMO_KEY = "synthetic-review-key";
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

/** Real protocol exchanges against a disposable provider, including confidential OAuth and required headers. */
export async function revisedCustomConnectorFlows(seed: Seed) {
  let origin = "";
  const token = randomBytes(24).toString("hex");
  const codes = new Map<string, { redirect: string; challenge: string }>();
  let exchanges = 0;
  const authorizationScopes: string[][] = [];
  let calls = 0;
  let headerAuthenticated = 0;
  let keyAuthenticated = 0;
  let registrationAttempts = 0;
  const heldRuntime = new Map<string, number>();
  const runtimeValidations = new Map<string, number>();
  const releasedRuntime = new Set<string>();
  const runtimeWaiters = new Map<string, Array<() => void>>();
  const releaseRuntime = (mode: string) => { releasedRuntime.add(mode); runtimeWaiters.get(mode)?.forEach((resolve) => resolve()); runtimeWaiters.delete(mode); };
  const provider = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", origin);
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString();
      let rpc: unknown;
      if (req.headers["content-type"]?.includes("application/json") && body) rpc = JSON.parse(body);
      const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers }); res.end(JSON.stringify(value)); };
      if (url.pathname.startsWith("/mcp/")) {
        const mode = url.pathname.split("/").at(-1);
        const authenticated = mode === "public" || mode === "late-public" || (mode === "own" || mode === "retry") && req.headers.authorization === `Bearer ${token}`
          || mode === "key" && req.headers.authorization === `Bearer ${DEMO_KEY}`
          || (mode === "header" || mode === "late-header") && req.headers["x-example-key"] === DEMO_KEY;
        if (!authenticated) {
          json({ error: "unauthorized" }, 401, { "www-authenticate": (mode === "own" || mode === "retry") ? `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp/${mode}"` : 'Bearer realm="demo"' }); return;
        }
        if (mode === "header") headerAuthenticated++;
        if (mode === "key") keyAuthenticated++;
        if (req.method === "DELETE") { res.writeHead(200).end(); return; }
        if (!record(rpc) || !("id" in rpc)) { res.writeHead(202).end(); return; }
        if (mode && rpc.method === "initialize" && record(rpc.params) && record(rpc.params.clientInfo) && rpc.params.clientInfo.name !== "OpenWork requirements discovery") {
          runtimeValidations.set(mode, (runtimeValidations.get(mode) ?? 0) + 1);
          if ((mode === "late-public" || mode === "late-header") && !releasedRuntime.has(mode)) {
            heldRuntime.set(mode, (heldRuntime.get(mode) ?? 0) + 1);
            await new Promise<void>((resolve) => runtimeWaiters.set(mode, [...(runtimeWaiters.get(mode) ?? []), resolve]));
          }
        }
        const answer = (result: unknown) => json({ jsonrpc: "2.0", id: rpc.id, result });
        if (rpc.method === "initialize") { answer({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fieldnotes-demo", version: "1" } }); return; }
        if (rpc.method === "tools/list") { answer({ tools: [{ name: "get_demo_profile", title: "Get demo profile", description: "Read the demo profile.", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: {} } }] }); return; }
        if (rpc.method === "tools/call") { calls++; answer({ _meta: { serverInfo: { icons: [{ src: "data:image/png;base64,c3ludGhldGljLWljb24=" }] } }, structuredContent: { account: "demo-account", access: "read" }, content: [{ type: "text", text: '{"account":"demo-account","access":"read"}' }] }); return; }
        json({ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "Method not found" } }); return;
      }
      if (url.pathname === "/.well-known/oauth-protected-resource/mcp/own" || url.pathname === "/.well-known/oauth-protected-resource/mcp/retry") { json({ resource: `${origin}${url.pathname.replace("/.well-known/oauth-protected-resource", "")}`, authorization_servers: [origin], scopes_supported: ["read", "write"] }); return; }
      if (url.pathname === "/.well-known/oauth-authorization-server") { json({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, response_types_supported: ["code"], grant_types_supported: ["authorization_code"], scopes_supported: ["read", "write"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["client_secret_post"] }); return; }
      if (url.pathname === "/register") { registrationAttempts++; json({ error: "not_supported" }, 400); return; }
      if (url.pathname === "/authorize") {
        authorizationScopes.push((url.searchParams.get("scope") ?? "").split(/\s+/).filter(Boolean));
        if (url.searchParams.get("client_id") !== DEMO_CLIENT) { json({ error: "invalid_client" }, 400); return; }
        const approve = new URL(url); approve.pathname = "/approve";
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html><html lang="en"><title>Approve demo connection</title><body><main><h1>Approve OpenWork access</h1><p>Read the disposable demo account.</p><form method="post" action="${approve.href.replaceAll("&", "&amp;")}"><button>Approve access</button></form></main></body></html>`); return;
      }
      if (url.pathname === "/approve") {
        const redirect = url.searchParams.get("redirect_uri"), challenge = url.searchParams.get("code_challenge"), state = url.searchParams.get("state");
        if (!redirect || !challenge || !state) { json({}, 400); return; }
        const code = randomBytes(20).toString("hex"); codes.set(code, { redirect, challenge });
        const callback = new URL(redirect); callback.searchParams.set("code", code); callback.searchParams.set("state", state); callback.searchParams.set("iss", origin);
        res.writeHead(302, { location: callback.href }).end(); return;
      }
      if (url.pathname === "/token") {
        const params = new URLSearchParams(body); const grant = codes.get(params.get("code") ?? "");
        if (!grant || params.get("client_id") !== DEMO_CLIENT || params.get("client_secret") !== DEMO_SECRET || params.get("redirect_uri") !== grant.redirect || createHash("sha256").update(params.get("code_verifier") ?? "").digest("base64url") !== grant.challenge) { json({ error: "invalid_grant" }, 400); return; }
        codes.delete(params.get("code") ?? ""); exchanges++; json({ access_token: token, token_type: "Bearer", expires_in: 3600, scope: "read" }); return;
      }
      json({}, 404);
    } catch { res.writeHead(500).end(); }
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address(); if (!address || typeof address === "string") throw new Error("No provider port"); origin = `http://127.0.0.1:${address.port}`;
  try {
    const den = await seed.den({ env: { DEN_ALLOW_PRIVATE_MCP_URLS: "1" }, org: { name: "Fieldnotes Studio", admin: { name: "Connector Admin" } } });
    const web = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/mcp-connections", headless: true, viewport: { width: 1280, height: 1300 } });
    const endpoint = web.client.webSocketDebuggerUrl;
    if (!endpoint) throw new Error("No browser CDP endpoint");
    const faultSocket = new WebSocket(endpoint);
    let faultSequence = 0;
    let injectedFailures = 0;
    const apiRequests = new Map<string, { method: string; path: string; name?: string; status?: number; finished: boolean }>();
    const sendFault = (method: string, params: Record<string, unknown>) => faultSocket.send(JSON.stringify({ id: ++faultSequence, method, params }));
    faultSocket.addEventListener("message", ({ data }) => {
      const message: unknown = JSON.parse(String(data));
      if (!record(message) || !record(message.params)) return;
      const params = message.params;
      if (message.method === "Network.requestWillBeSent" && typeof params.requestId === "string" && record(params.request) && typeof params.request.url === "string") {
        const path = new URL(params.request.url).pathname;
        if (path.includes("/v1/mcp-connections") && (params.request.method === "POST" && path.endsWith("/v1/mcp-connections") || params.request.method === "DELETE")) {
          let input: unknown;
          if (typeof params.request.postData === "string") { try { input = JSON.parse(params.request.postData); } catch {} }
          apiRequests.set(params.requestId, { method: String(params.request.method), path, ...(record(input) && typeof input.name === "string" ? { name: input.name } : {}), finished: false });
        }
      }
      if (typeof params.requestId === "string") {
        const request = apiRequests.get(params.requestId);
        if (request && message.method === "Network.responseReceived" && record(params.response) && typeof params.response.status === "number") request.status = params.response.status;
        if (request && message.method === "Network.loadingFinished") request.finished = true;
      }
      if (message.method !== "Fetch.requestPaused") return;
      const { requestId, request } = message.params;
      if (typeof requestId !== "string" || !record(request)) return;
      let input: unknown;
      if (request.method === "POST" && typeof request.postData === "string") { try { input = JSON.parse(request.postData); } catch {} }
      if (typeof message.params.networkId === "string" && record(input) && typeof input.name === "string") {
        const tracked = apiRequests.get(message.params.networkId); if (tracked) tracked.name = input.name;
      }
      if (injectedFailures === 0 && record(input) && input.name === "Retry projects") {
        injectedFailures++;
        sendFault("Fetch.fulfillRequest", { requestId, responseCode: 503, responseHeaders: [{ name: "Content-Type", value: "application/json" }, { name: "Cache-Control", value: "no-store" }], body: Buffer.from(JSON.stringify({ error: "temporary_failure", message: "Synthetic connection save interruption. Try again." })).toString("base64") });
      } else sendFault("Fetch.continueRequest", { requestId });
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Fault observer connection timed out")), 10000);
      faultSocket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      faultSocket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Fault observer unavailable")); }, { once: true });
    });
    sendFault("Network.enable", {});
    sendFault("Fetch.enable", { patterns: [{ urlPattern: "*/v1/mcp-connections", requestStage: "Request" }] });
    return {
      den, web,
      setupUrl: (mode: string, name: string) => `${den.ref.webUrl}/dashboard/mcp-connections/new/custom?name=${encodeURIComponent(name)}&url=${encodeURIComponent(`${origin}/mcp/${mode}`)}`,
      injectedFailures: () => injectedFailures,
      createPosts: (name: string) => [...apiRequests.values()].filter((entry) => entry.method === "POST" && entry.name === name).length,
      completedSave: (name: string) => [...apiRequests.values()].some((entry) => entry.method === "POST" && entry.name === name && entry.finished && entry.status === 200),
      completedDelete: (id: string) => [...apiRequests.values()].some((entry) => entry.method === "DELETE" && entry.path.endsWith(`/${id}`) && entry.finished && (entry.status === 200 || entry.status === 204)),
      runtimeValidations: (mode: string) => runtimeValidations.get(mode) ?? 0,
      heldRuntime: (mode: string) => heldRuntime.get(mode) ?? 0,
      releaseRuntime,
      authorizationScopes: () => authorizationScopes,
      exchanges: () => exchanges, calls: () => calls, keyAuthenticated: () => keyAuthenticated, headerAuthenticated: () => headerAuthenticated, registrationAttempts: () => registrationAttempts,
      async connections() { const r = await seed.api(den.admin, "/v1/mcp-connections?scope=manageable"); return record(r.body) && Array.isArray(r.body.connections) ? r.body.connections.filter(record) : []; },
      async signInTab(): Promise<Surface | undefined> {
        const target = (await listTargets(web.handle.cdpUrl)).find((entry) => entry.type === "page" && entry.id !== web.client.targetId && (entry.url.startsWith(origin) || entry.url.includes("/connect/oauth")));
        return target ? { handle: web.handle, client: await connect(debuggerUrlFor(web.handle.cdpUrl, target)) } : undefined;
      },
      async [Symbol.asyncDispose]() { faultSocket.close(); releaseRuntime("late-public"); releaseRuntime("late-header"); provider.closeAllConnections(); await new Promise<void>((resolve) => provider.close(() => resolve())); },
    };
  } catch (error) { provider.closeAllConnections(); provider.close(); throw error; }
}
