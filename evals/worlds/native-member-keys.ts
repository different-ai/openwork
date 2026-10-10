import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { browserScript } from "@openwork/cdp";
import { evalIn, waitFor } from "@openwork/behaviors";
import { app as startApp } from "@openwork/env";
import type { App, Place, Seed } from "@openwork/env";
import { isRecord, records, stringField } from "./library.ts";

async function configureModel(surface: App, modelUrl: string, gatewayUrl: string, gatewayToken: string) {
  await evalIn(surface, browserScript(async (workspaceId, modelUrl, gatewayUrl, gatewayToken) => {
    const info = await window.__OPENWORK_ELECTRON__.invokeDesktop("openworkServerInfo");
    if (!info.baseUrl) throw new Error("No owned server");
    const headers = { Authorization: `Bearer ${info.ownerToken}`, "Content-Type": "application/json" };
    const root = info.baseUrl.replace(/\/$/, "");
    const response = await fetch(`${root}/workspace/${workspaceId}/config`, { method: "PATCH", headers,
      body: JSON.stringify({ opencode: { model: "native-proof/proof", small_model: "native-proof/proof", provider: {
        "native-proof": { npm: "@ai-sdk/openai-compatible", name: "Native proof", options: { baseURL: `${modelUrl}/v1`, apiKey: "fixture-model-only" },
          models: { proof: { name: "Native credential proof model", tool_call: true } } },
      } } }), signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error("Model fixture configuration failed");
    const connection = await fetch(`${root}/workspace/${workspaceId}/mcp/openwork-cloud/reconcile`, { method: "POST", headers,
      body: JSON.stringify({ config: { type: "remote", url: gatewayUrl, enabled: true, oauth: false, headers: { Authorization: `Bearer ${gatewayToken}` } }, trigger: "native-credential-fixture" }), signal: AbortSignal.timeout(45_000) });
    if (!connection.ok) throw new Error("Owned member gateway configuration failed");
    localStorage.setItem("openwork.defaultModel", "native-proof/proof");
  }, [surface.workspaceId, modelUrl, gatewayUrl, gatewayToken]), { awaitPromise: true, timeoutMs: 90_000 });
  await waitFor(surface, browserScript(async (workspaceId) => {
    const info = await window.__OPENWORK_ELECTRON__.invokeDesktop("openworkServerInfo");
    if (!info.baseUrl) return false;
    const root = info.baseUrl.replace(/\/$/, "");
    const headers = { Authorization: `Bearer ${info.ownerToken}` };
    const response = await fetch(`${root}/workspace/${workspaceId}/opencode/global/health`, { headers, signal: AbortSignal.timeout(2500) });
    return response.ok;
  }, [surface.workspaceId]), { timeoutMs: 60_000, label: "owned engine reachable before the single fixture reload" });
  const reload = await evalIn(surface, browserScript(async (workspaceId) => {
    const info = await window.__OPENWORK_ELECTRON__.invokeDesktop("openworkServerInfo");
    if (!info.baseUrl) throw new Error("No owned server");
    const response = await fetch(`${info.baseUrl.replace(/\/$/, "")}/workspace/${workspaceId}/engine/reload`, { method: "POST", headers: { Authorization: `Bearer ${info.ownerToken}` }, signal: AbortSignal.timeout(60_000) });
    if (!response.ok) {
      const payload: unknown = await response.json().catch(() => null);
      const outer = payload && typeof payload === "object" ? payload : {};
      const error = "error" in outer && outer.error && typeof outer.error === "object" ? outer.error : outer;
      const code = "code" in error && typeof error.code === "string" ? error.code : "unknown";
      const safe = ["opencode_unconfigured", "opencode_reload_timeout", "opencode_engine_unreachable", "opencode_reload_failed"].includes(code) ? code : "unknown";
      if (response.status !== 503 || safe !== "opencode_engine_unreachable") throw new Error(`Owned engine reload failed with HTTP ${response.status}, code ${safe}`);
      return { status: response.status, code: safe };
    }
    return { status: response.status, code: "acknowledged" };
  }, [surface.workspaceId]), { awaitPromise: true, timeoutMs: 90_000 });
  await waitFor(surface, browserScript(async (workspaceId) => {
    const info = await window.__OPENWORK_ELECTRON__.invokeDesktop("openworkServerInfo");
    if (!info.baseUrl) return false;
    const root = info.baseUrl.replace(/\/$/, "");
    const headers = { Authorization: `Bearer ${info.ownerToken}` };
    const configured = await fetch(`${root}/workspace/${workspaceId}/opencode/config`, { headers, signal: AbortSignal.timeout(2500) });
    if (!configured.ok) return false;
    const config: unknown = await configured.json();
    if (!config || typeof config !== "object" || !("provider" in config) || !config.provider || typeof config.provider !== "object" || !("native-proof" in config.provider)) return false;
    const provider = config.provider["native-proof"];
    if (!provider || typeof provider !== "object" || !("models" in provider) || !provider.models || typeof provider.models !== "object" || !("proof" in provider.models)) return false;
    const response = await fetch(`${root}/workspace/${workspaceId}/opencode/mcp`, { headers, signal: AbortSignal.timeout(2500) });
    if (!response.ok) return false;
    const value: unknown = await response.json();
    return Boolean(value && typeof value === "object" && "openwork-cloud" in value && value["openwork-cloud"]
      && typeof value["openwork-cloud"] === "object" && "status" in value["openwork-cloud"] && value["openwork-cloud"].status === "connected");
  }, [surface.workspaceId]), { timeoutMs: 60_000, label: "effective fixture model and connected member gateway after one reload attempt" });
  await evalIn(surface, () => location.reload());
  await waitFor(surface, () => Boolean(window.__openworkControl), { timeoutMs: 60_000, label: "owned desktop reload" });
  return reload;
}

export async function nativeMemberKeys(seed: Seed, { place }: { place: Place }) {
  if (place.kind !== "local" || process.env.OPENWORK_EVAL_DEN_API_URL || process.env.OPENWORK_EVAL_DEN_WEB_URL) throw new Error("Owned local native fixture required");
  const analyticsBodies: string[] = [];
  const analytics = createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (request.method === "OPTIONS") { response.writeHead(204).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    analyticsBodies.push(Buffer.concat(chunks).toString());
    response.writeHead(200, { "Content-Type": "application/json" }).end('{"status":1}');
  });
  await new Promise<void>(resolve => analytics.listen(0, "127.0.0.1", resolve));
  const analyticsAddress = analytics.address();
  if (!analyticsAddress || typeof analyticsAddress === "string") throw new Error("Owned analytics endpoint unavailable");
  const den = await seed.den({ org: { name: "Native credential fixture", members: { alice: {}, blair: {}, ungranted: {} } },
    mocks: { source: seed.mock({ allowUnauthenticatedMcp: true, isolatedProcessEnv: true,
      agentWorkloads: [
        { promptMarker: "Connect my native private tools", finalReply: "Open secure Connect for your own account.", steps: [{ tool: "search_capabilities", arguments: { query: "Native private tools", type: "mcp", intent: "connect", limit: 1 } }] },
        { promptMarker: "Read my fixture identity", finalReply: "Identity read finished.", steps: [{ tool: "search_capabilities", arguments: { query: "identity_probe", type: "mcp", limit: 1 } }, { tool: "execute_capability", arguments: { body: {} }, argumentsFrom: "capability-search" }] },
      ],
      tools: [{ name: "identity_probe", description: "Read-only fixture identity", inputSchema: { type: "object" }, result: { content: [{ type: "text", text: "fixture identity" }] } }] }) } });
  const keys = { alice: randomBytes(24).toString("hex"), blair: randomBytes(24).toString("hex") };
  const fingerprint = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 12);
  const accepted = new Set(Object.values(keys));
  const wire: { method: string; identity: string; status: number }[] = [];
  const witness = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    const method = body ? JSON.parse(body).method : request.method;
    const key = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
    if (!accepted.has(key)) { wire.push({ method, identity: fingerprint(key), status: 401 }); response.writeHead(401).end(); return; }
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) if (value && !["host", "connection", "content-length"].includes(name)) headers.set(name, Array.isArray(value) ? value.join(",") : value);
    try {
      const upstream = await fetch(den.mocks.source.mcpUrl, { method: request.method, headers, ...(body ? { body } : {}), signal: AbortSignal.timeout(10_000) });
      wire.push({ method, identity: fingerprint(key), status: upstream.status });
      response.writeHead(upstream.status, Object.fromEntries(upstream.headers)).end(Buffer.from(await upstream.arrayBuffer()));
    } catch { response.writeHead(502).end(); }
  });
  await new Promise<void>(resolve => witness.listen(0, "127.0.0.1", resolve));
  const address = witness.address();
  if (!address || typeof address === "string") throw new Error("Owned witness missing");
  const organization = await seed.api(den.admin, "/v1/org");
  if (!isRecord(organization.body)) throw new Error("Missing owned organization");
  const organizationId = stringField(organization.body.organization, "id");
  const members = records(organization.body.members);
  const memberFor = (email: string) => {
    const member = members.find(row => isRecord(row.user) && row.user.email === email);
    if (!member) throw new Error("Owned member absent from organization");
    return stringField(member, "id");
  };
  const created = await seed.api(den.admin, "/v1/mcp-connections", { method: "POST", body: JSON.stringify({ name: "Native private tools", url: `http://127.0.0.1:${address.port}/mcp`, authType: "apikey", credentialMode: "per_member", access: { orgWide: false, memberIds: [memberFor(den.members.alice.email), memberFor(den.members.blair.email)] } }) });
  if (!created.response.ok) throw new Error("Owned connection creation failed");
  const connectionId = stringField(created.body, "id");
  const tokens = { alice: "", blair: "" };
  for (const name of ["alice", "blair"] as const) {
    const minted = await seed.api(den.members[name], "/v1/mcp/token", { method: "POST", body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }) });
    if (!minted.response.ok) throw new Error("Owned token mint failed");
    tokens[name] = stringField(minted.body, "token");
  }
  const reloads: { member: string; status: number; code: string }[] = [];
  const withMember = async (name: "alice" | "blair", use: (desktop: App, memberId: string) => Promise<void>) => {
    await using desktop = await startApp({ den, as: name, place, env: {
      OPENWORK_APP_NAME: "OpenWork Native Credential Proof",
      VITE_OPENWORK_POSTHOG_HOST: `http://127.0.0.1:${analyticsAddress.port}`, VITE_OPENWORK_POSTHOG_KEY: "synthetic-analytics-only",
    } });
    const reload = await configureModel(desktop, den.mocks.source.url, `${den.ref.apiUrl}/mcp/agent`, tokens[name]);
    reloads.push({ member: name, ...reload });
    await evalIn(desktop, () => {
      const entries: string[] = [];
      Reflect.set(window, "__nativeProofConsole", entries);
      for (const name of ["log", "warn", "error"] as const) {
        const original = console[name].bind(console);
        console[name] = (...args: unknown[]) => { entries.push(args.map(String).join(" ")); original(...args); };
      }
    });
    await use(desktop, memberFor(den.members[name].email));
  };
  return { den, withMember, reloads, keys, fingerprint, connectionId, organizationId, analyticsBodies, wire,
    async [Symbol.asyncDispose]() {
      analytics.closeAllConnections(); witness.closeAllConnections();
      await Promise.all([new Promise<void>((resolve, reject) => analytics.close(error => error ? reject(error) : resolve())), new Promise<void>((resolve, reject) => witness.close(error => error ? reject(error) : resolve()))]);
    },
  };
}
