import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { allocateFreePort } from "@openwork/cdp";
import type { Place, Seed } from "@openwork/env";
import type { MockAgentToolStep, MockAgentWorkload } from "@openwork/labs";
import { engineParity } from "./engine-parity.ts";
import { isRecord } from "./library.ts";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";

/** What OpenWork sends after a key is saved; it carries no key. */
export const KEY_SAVED_PROMPT = "I've saved the key. Go ahead.";
export const CONNECT_PROMPT = "Connect our status service. It needs an API key.";
export const GATEWAY_PROMPT = "Add our OpenRouter account to the AI Gateway for everyone.";
export const BACKUP_PROMPT = "Also connect our backup status service.";
export const VERTEX_PROMPT = "Add our Google Cloud Vertex project to the AI Gateway for everyone.";

function field(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) current = isRecord(current) ? current[key] : undefined;
  return current;
}

/**
 * An organization admin chatting in the real app (in a browser), signed in to
 * a real Den with secure keys in chat on and the AI Gateway deployed (its
 * proxy points at a closed port; no inference is sent). The agent's model is
 * scripted; Den, MCP routing and the key field are real.
 *
 * The status service only answers through an owned proxy that accepts one
 * generated key, so "it works" means the key Den stored is the key typed.
 * Keys are random per run and never logged; witnesses record fingerprints.
 */
export async function secureKeysInChat(seed: Seed, context: { place: Place }) {
  await using setup = new AsyncDisposableStack();
  const local = context.place.kind === "local";
  const gatewayUrl = `http://127.0.0.1:${await allocateFreePort()}`;
  const proof = `Status: all systems normal ${randomBytes(4).toString("hex")}`;
  const den = await seed.den({
    web: true,
    env: {
      DEN_ORG_MODE: "multi_org", GATEWAY_ENABLED: "true", PROVISIONER_MODE: "stub",
      ...(local ? { NODE_ENV: "test", OPENWORK_DEV_MODE: "1", DB_MODE: "mysql", GATEWAY_PROXY_BASE_URL: gatewayUrl, GATEWAY_PUBLIC_BASE_URL: gatewayUrl } : {}),
    },
    org: { name: `Secure keys ${Date.now()}`, admin: { name: "Avery Owner" }, members: { riley: { name: "Riley Member" } } },
    mocks: { status: seed.mock({ allowUnauthenticatedMcp: true, tools: [
      { name: "team_status", description: "Read the team status page", inputSchema: { type: "object", properties: {} }, result: { content: [{ type: "text", text: proof }] } },
    ] }) },
  });
  const organizationId = await enableOrganizationCapabilities(seed, den.admin, { secureSecretFields: true });

  // Keys exist only in this process; witnesses keep a 12-character fingerprint.
  const keys = { status: randomBytes(24).toString("hex"), wrong: randomBytes(24).toString("hex"), gateway: `sk-or-${randomBytes(24).toString("hex")}` };
  // The private key body is unique per run; any trace of it in a model request is a leak.
  const serviceAccountSentinel = randomBytes(48).toString("hex");
  /** A synthetic service-account key file; never a real credential. */
  const serviceAccount = JSON.stringify({ type: "service_account", project_id: "fixture-project", client_email: `fixture-${randomBytes(4).toString("hex")}@fixture-project.iam.gserviceaccount.com`, private_key: `-----BEGIN PRIVATE KEY-----\n${serviceAccountSentinel}\n-----END PRIVATE KEY-----\n`, token_uri: "https://oauth2.googleapis.com/token" });
  const fingerprint = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 12);
  const wire: { method: string; identity: string; status: number }[] = [];
  const witness = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    let method = request.method ?? "";
    try { const parsed: unknown = body ? JSON.parse(body) : null; if (isRecord(parsed) && typeof parsed.method === "string") method = parsed.method; } catch { /* non-JSON */ }
    const key = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
    if (key !== keys.status) { wire.push({ method, identity: fingerprint(key), status: 401 }); response.writeHead(401).end(); return; }
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) if (value && !["host", "connection", "content-length", "authorization"].includes(name)) headers.set(name, Array.isArray(value) ? value.join(",") : value);
    try {
      const upstream = await fetch(den.mocks.status.mcpUrl, { method: request.method, headers, ...(body ? { body } : {}), signal: AbortSignal.timeout(10_000) });
      wire.push({ method, identity: fingerprint(key), status: upstream.status });
      response.writeHead(upstream.status, Object.fromEntries(upstream.headers)).end(Buffer.from(await upstream.arrayBuffer()));
    } catch { response.writeHead(502).end(); }
  });
  await new Promise<void>((resolve) => witness.listen(0, "127.0.0.1", resolve));
  setup.defer(async () => { witness.closeAllConnections(); await new Promise<void>((resolve) => witness.close(() => resolve())); });
  const address = witness.address();
  if (!address || typeof address === "string") throw new Error("Status witness unavailable");
  const statusUrl = `http://127.0.0.1:${address.port}/mcp`;

  const base = setup.use(await engineParity(seed, context, { env: {
    OPENWORK_DEV_HEADLESS_WEB_DEN_PROXY: "1", OPENWORK_DEV_DEN_PROXY_TARGET: den.ref.webUrl,
    OPENWORK_DEV_HEADLESS_DEN_API_TARGET: den.ref.apiUrl,
    VITE_DEN_BASE_URL: den.ref.webUrl, VITE_DEN_API_BASE_URL: "/api/den",
  } }));
  await seed.signIn(base.app, den.admin, "Avery Owner");
  const issued = await seed.api(den.admin, "/v1/mcp/token", { method: "POST", headers: { "x-openwork-org-id": organizationId }, body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }) });
  const token = field(issued.body, "token");
  if (!issued.response.ok || typeof token !== "string") throw new Error("Missing agent MCP token");
  // Sign-in finishes before the app lands on its workspace session; wait for it.
  let workspace: string | undefined;
  for (const deadline = Date.now() + 90_000; !workspace && Date.now() < deadline;) {
    workspace = /\/workspace\/([^/]+)\/session/.exec(await base.route())?.[1];
    if (!workspace) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!workspace) throw new Error(`Missing workspace after sign-in; route: ${await base.route()}`);
  const connected = await base.request(`/workspace/${workspace}/mcp/openwork-cloud/reconcile`, "POST", {
    config: { type: "remote", url: `${den.ref.apiUrl}/mcp/agent`, enabled: true, oauth: false, headers: { Authorization: `Bearer ${token}` } }, trigger: "secure-keys-fixture",
  });
  if (connected.status !== 200) throw new Error(`Connect reconciliation failed: ${connected.status}`);
  const sentinels = await fetch(`${base.mock.url}/admin/private-sentinels`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ values: [...Object.values(keys), serviceAccountSentinel] }) });
  if (!sentinels.ok) throw new Error("Model privacy witness setup failed");

  /** One OpenWork Cloud call as the engine makes it: a direct call (v1) or inside Code Mode (v2). */
  const cloudCall = (tool: "search_capabilities" | "execute_capability", input: Record<string, unknown>): MockAgentToolStep => ({ tool: "execute", arguments: { code: `return await tools["openwork-cloud"].${tool}(${JSON.stringify(input)});` } });
  const statusCall: MockAgentToolStep[] = [{ tool: "execute", arguments: { code: `
        const found = await tools["openwork-cloud"].search_capabilities({ query: "team_status", type: "mcp", limit: 1 });
        const result = typeof found === "string" ? JSON.parse(found) : found;
        const catalog = result.matches ? result : JSON.parse(result.content[0].text);
        return await tools["openwork-cloud"].execute_capability({ name: catalog.matches[0].name, body: {} });
      ` } }];

  async function script(workloads: MockAgentWorkload[]) {
    const response = await fetch(`${base.mock.url}/admin/agent-workloads`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workloads }) });
    if (!response.ok) throw new Error(`Model script failed: ${response.status}`);
  }

  async function agentMcp(name: string, args: Record<string, unknown>) {
    const response = await fetch(`${den.ref.apiUrl}/mcp/agent`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } }), signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    const line = text.split("\n").find((value) => value.startsWith("data:"));
    const envelope: unknown = JSON.parse(line ? line.slice(5) : text);
    const content = field(envelope, "result", "content");
    const first = Array.isArray(content) ? content.find((part) => isRecord(part) && part.type === "text") : null;
    const raw = isRecord(first) && typeof first.text === "string" ? first.text : "";
    let body: unknown = null;
    try { body = JSON.parse(raw); } catch { body = raw; }
    return { isError: field(envelope, "result", "isError") === true, body, text };
  }

  const vertexModels = await (async () => {
    const result = await seed.api(den.admin, "/v1/llm-provider-catalog/google-vertex");
    const models = field(result.body, "provider", "models");
    const ids = Array.isArray(models) ? models.flatMap((model) => isRecord(model) && typeof model.id === "string" && /^gemini-2\.5/.test(model.id) && !/preview|exp|lite|image|tts|live|embed/i.test(model.id) ? [model.id] : []) : [];
    if (!ids.length) throw new Error("The google-vertex catalog has no Gemini 2.5 models");
    return ids.slice(0, 1);
  })();
  // OpenWork Cloud in headless Chrome, signed in as the admin.
  const web = await seed.web({
    den, signedInAs: den.admin, startPath: "/dashboard/ai-gateway?tab=ai-providers", headless: true,
    viewport: { width: 1280, height: 900, deviceScaleFactor: 1 },
  });

  const resources = setup.move();
  return {
    ...base, den, web, organizationId, keys, fingerprint, wire, proof, statusUrl, serviceAccount,
    /** The admin asks; the agent creates the connection without its key and ends its turn. */
    async scriptConnection() {
      await script([
        { promptMarker: CONNECT_PROMPT, latestUserTurn: true, finalReply: "Add the key in the field above and I'll continue.", steps: [
          cloudCall("execute_capability", { name: "postMcpConnections", body: { name: "Status service", url: statusUrl, authType: "apikey", credentialMode: "shared", access: { orgWide: true } } }),
        ] },
        { promptMarker: KEY_SAVED_PROMPT, latestUserTurn: true, finalReply: "The status service did not answer", finalReplyFrom: "last-tool-text", steps: statusCall },
      ]);
    },
    /** The admin asks; the agent adds the provider for everyone without its key and ends its turn. */
    async scriptGateway() {
      await script([
        { promptMarker: GATEWAY_PROMPT, latestUserTurn: true, finalReply: "Add the OpenRouter key in the field above and I'll finish.", steps: [
          cloudCall("execute_capability", { name: "postInferenceProviders", body: { name: "Team OpenRouter", providerId: "openrouter", modelIds: ["openai/gpt-4o-mini"], allMembers: true } }),
        ] },
        { promptMarker: KEY_SAVED_PROMPT, latestUserTurn: true, finalReply: "Team OpenRouter is ready for everyone.", steps: [] },
      ]);
    },
    /** A second request whose key nobody has entered yet. */
    async scriptBackup() {
      await script([
        { promptMarker: BACKUP_PROMPT, latestUserTurn: true, finalReply: "Add the backup service's key in the field above.", steps: [
          cloudCall("execute_capability", { name: "postMcpConnections", body: { name: "Backup status service", url: statusUrl, authType: "apikey", credentialMode: "shared", access: { orgWide: true } } }),
        ] },
      ]);
    },
    /** The admin asks; the agent adds a Vertex provider for everyone without its key file and ends its turn. */
    async scriptVertex() {
      await script([
        { promptMarker: VERTEX_PROMPT, latestUserTurn: true, finalReply: "Paste the service account key in the field above and I'll finish.", steps: [
          cloudCall("execute_capability", { name: "postInferenceProviders", body: { name: "Team Vertex", providerId: "google-vertex", modelIds: vertexModels, settings: { project: "fixture-project", location: "us-central1" }, allMembers: true } }),
        ] },
        { promptMarker: KEY_SAVED_PROMPT, latestUserTurn: true, finalReply: "Team Vertex is ready for everyone.", steps: [] },
      ]);
    },
    agentMcp,
    async providerByName(name: string) {
      const listed = await seed.api(den.admin, "/v1/inference-providers", { headers: { "x-openwork-org-id": organizationId } });
      const rows = field(listed.body, "inferenceProviders");
      const summary = Array.isArray(rows) ? rows.find((row) => isRecord(row) && row.name === name) : undefined;
      const id = field(summary, "id");
      if (typeof id !== "string") return null;
      const detail = await seed.api(den.admin, `/v1/inference-providers/${encodeURIComponent(id)}`, { headers: { "x-openwork-org-id": organizationId } });
      return { id, body: detail.body, text: detail.text };
    },
    async connection() {
      const listed = await seed.api(den.admin, "/v1/mcp-connections?scope=manageable", { headers: { "x-openwork-org-id": organizationId } });
      const rows = field(listed.body, "connections");
      return Array.isArray(rows) ? rows.find((row) => isRecord(row) && row.name === "Status service") : undefined;
    },
    async gatewayProvider() {
      const listed = await seed.api(den.admin, "/v1/inference-providers", { headers: { "x-openwork-org-id": organizationId } });
      const rows = field(listed.body, "inferenceProviders");
      const summary = Array.isArray(rows) ? rows.find((row) => isRecord(row) && row.name === "Team OpenRouter") : undefined;
      const id = field(summary, "id");
      if (typeof id !== "string") return null;
      const detail = await seed.api(den.admin, `/v1/inference-providers/${encodeURIComponent(id)}`, { headers: { "x-openwork-org-id": organizationId } });
      return { status: detail.response.status, body: detail.body, text: detail.text };
    },
    /** A member without Manage connections, calling the human route with their own session. */
    async memberSavesSharedKey(connectionId: string) {
      const riley = den.members.riley;
      if (!riley) throw new Error("Missing member");
      return seed.api(riley, `/v1/mcp-connections/${encodeURIComponent(connectionId)}/shared-credential`, { method: "PUT", headers: { "x-openwork-org-id": organizationId }, body: JSON.stringify({ apiKey: keys.wrong }) });
    },
    async setFeature(enabled: boolean) {
      await seed.api(den.admin, `/v1/admin/organizations/${organizationId}/capabilities`, { method: "PUT", body: JSON.stringify({ capabilities: { secureSecretFields: enabled } }) });
    },
    async colorScheme(theme: "light" | "dark") {
      await base.app.client.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
    },
    async [Symbol.asyncDispose]() { await resources.disposeAsync(); },
  };
}
