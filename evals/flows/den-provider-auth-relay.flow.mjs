/**
 * Internal proof for Den's downstream-provider authorization relay.
 *
 * Runs app-less against a real Den API and two public mock OAuth MCP gateways
 * supplied by the orchestrator through OPENWORK_EVAL_* environment variables.
 */
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const requireFromDenApi = createRequire(new URL("../../ee/apps/den-api/package.json", import.meta.url));
const { Client } = await import(requireFromDenApi.resolve("@modelcontextprotocol/sdk/client/index.js"));
const { StreamableHTTPClientTransport } = await import(requireFromDenApi.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js"));

const FLOW_ID = "den-provider-auth-relay";
const TOOL_NAME = "query_salesforce_records";
const REQUIRED_ENV = [
  "OPENWORK_EVAL_DEN_API_URL",
  "OPENWORK_EVAL_GATEWAY_MCP_URL",
  "OPENWORK_EVAL_GATEWAY_MCP_URL_FOREIGN",
];
const RUN_TAG = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
const ADMIN_EMAIL = `den-provider-auth-${RUN_TAG}@acme.test`;
const ADMIN_PASSWORD = `OpenWork-${RUN_TAG}-Provider-Auth!`;
const CONNECTION_A_NAME = `Salesforce Gateway Auth Required ${RUN_TAG}`;
const CONNECTION_B_NAME = `Salesforce Gateway Foreign Link ${RUN_TAG}`;
const TIMEOUT_WORDING = /latency|timed? ?out/i;

const vo = await loadVoiceoverParagraphs(FLOW_ID);
const envSnapshot = readEvalEnv();

const state = {
  adminToken: null,
  mcpToken: null,
  organization: null,
  currentMember: null,
  orgMode: null,
  gatewayA: null,
  gatewayB: null,
  rawGatewayA: null,
  rawGatewayB: null,
  health: null,
};

function readEvalEnv() {
  const values = {};
  const missing = [];
  for (const name of REQUIRED_ENV) {
    const value = (process.env[name] ?? "").trim();
    if (!value) {
      missing.push(name);
    }
    values[name] = value;
  }
  return { values, missing };
}

function missingEnvMessage() {
  return `Missing required environment variables for ${FLOW_ID}: ${envSnapshot.missing.join(", ")}. Set OPENWORK_EVAL_DEN_API_URL, OPENWORK_EVAL_GATEWAY_MCP_URL, and OPENWORK_EVAL_GATEWAY_MCP_URL_FOREIGN to the Daytona Den API and mock gateway MCP URLs.`;
}

function requiredEnv(ctx) {
  if (envSnapshot.missing.length > 0) {
    const message = missingEnvMessage();
    if (ctx) {
      witness(ctx, false, message);
    }
    throw new Error(message);
  }
  return {
    denApiUrl: stripTrailingSlashes(envSnapshot.values.OPENWORK_EVAL_DEN_API_URL),
    gatewayMcpUrl: stripTrailingSlashes(envSnapshot.values.OPENWORK_EVAL_GATEWAY_MCP_URL),
    foreignGatewayMcpUrl: stripTrailingSlashes(envSnapshot.values.OPENWORK_EVAL_GATEWAY_MCP_URL_FOREIGN),
  };
}

function stripTrailingSlashes(value) {
  return value.replace(/\/+$/, "");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function own(value, key) {
  if (!isRecord(value)) return undefined;
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

function compactActual(actual) {
  if (actual === undefined) return undefined;
  if (typeof actual === "string") return actual.slice(0, 900);
  try {
    return JSON.stringify(actual).slice(0, 900);
  } catch {
    return String(actual).slice(0, 900);
  }
}

function witness(ctx, condition, assertion, actual) {
  ctx.recordEvidence({
    type: "assertion",
    status: condition ? "passed" : "failed",
    assertion,
    actual: compactActual(actual),
  });
  ctx.assert(condition, assertion + (actual === undefined ? "" : ` (actual: ${compactActual(actual)})`));
}

function authOrigins(denApiUrl) {
  const url = new URL(denApiUrl);
  const origins = [url.origin];
  if (url.hostname === "127.0.0.1") {
    const localhost = new URL(url.toString());
    localhost.hostname = "localhost";
    origins.push(localhost.origin);
  } else if (url.hostname === "localhost") {
    const loopback = new URL(url.toString());
    loopback.hostname = "127.0.0.1";
    origins.push(loopback.origin);
  }
  return [...new Set(origins)];
}

async function fetchJson(url, options = {}) {
  const { ctx: _ctx, ...requestOptions } = options;
  const headers = {
    accept: "application/json",
    ...(requestOptions.body ? { "content-type": "application/json" } : {}),
    ...(requestOptions.headers ?? {}),
  };
  const response = await fetch(url, { ...requestOptions, headers });
  const text = await response.text();
  let body = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {}
  return { response, body, text };
}

async function denFetch(path, options = {}) {
  const { denApiUrl } = requiredEnv(options.ctx);
  return fetchJson(`${denApiUrl}${path}`, options);
}

async function denAuthFetch(path, options = {}) {
  const { denApiUrl } = requiredEnv(options.ctx);
  let last = null;
  for (const origin of authOrigins(denApiUrl)) {
    const result = await fetchJson(`${denApiUrl}${path}`, {
      ...options,
      headers: {
        origin,
        ...(options.headers ?? {}),
      },
    });
    last = result;
    if (!(result.response.status === 403 && own(result.body, "code") === "INVALID_ORIGIN")) {
      return result;
    }
  }
  return last;
}

async function authedDenFetch(ctx, path, token, options = {}) {
  return denFetch(path, {
    ...options,
    ctx,
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.headers ?? {}),
    },
  });
}

function summarizeAuthResult(result) {
  const body = isRecord(result.body) ? result.body : null;
  const user = isRecord(own(body, "user")) ? own(body, "user") : null;
  const session = isRecord(own(body, "session")) ? own(body, "session") : null;
  return {
    status: result.response.status,
    ok: result.response.ok,
    token: typeof own(body, "token") === "string" ? "<redacted>" : null,
    user: user ? {
      id: own(user, "id"),
      email: own(user, "email"),
      name: own(user, "name"),
      emailVerified: own(user, "emailVerified"),
    } : null,
    session: session ? {
      id: own(session, "id"),
      activeOrganizationId: own(session, "activeOrganizationId"),
    } : null,
    body: body && typeof own(body, "token") !== "string" ? body : undefined,
  };
}

async function signUpAndSignInAdmin(ctx) {
  const signUp = await denAuthFetch("/api/auth/sign-up/email", {
    ctx,
    method: "POST",
    body: JSON.stringify({ email: ADMIN_EMAIL, name: "Provider Auth Admin", password: ADMIN_PASSWORD }),
  });
  witness(ctx, signUp.response.ok, "Admin email sign-up succeeds through the real Den auth API", summarizeAuthResult(signUp));

  const signIn = await denAuthFetch("/api/auth/sign-in/email", {
    ctx,
    method: "POST",
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  const token = isRecord(signIn.body) && typeof own(signIn.body, "token") === "string" ? own(signIn.body, "token") : null;
  witness(ctx, signIn.response.ok && typeof token === "string", "Admin email sign-in returns a bearer session token", summarizeAuthResult(signIn));
  state.adminToken = token;
  return token;
}

function currentMemberCanAdmin(currentMember) {
  if (!isRecord(currentMember)) return false;
  if (own(currentMember, "isOwner") === true) return true;
  const roles = String(own(currentMember, "role") ?? "").split(",").map((role) => role.trim());
  return roles.includes("admin") || roles.includes("owner");
}

function compactOrganizationContext(body) {
  const organization = isRecord(own(body, "organization")) ? own(body, "organization") : null;
  const currentMember = isRecord(own(body, "currentMember")) ? own(body, "currentMember") : null;
  return {
    organization: organization ? {
      id: own(organization, "id"),
      name: own(organization, "name"),
      slug: own(organization, "slug"),
    } : null,
    currentMember: currentMember ? {
      id: own(currentMember, "id"),
      role: own(currentMember, "role"),
      isOwner: own(currentMember, "isOwner"),
      userId: own(currentMember, "userId"),
    } : null,
  };
}

async function loadOrgContext(ctx, token, label) {
  const result = await authedDenFetch(ctx, "/v1/org", token);
  witness(ctx, result.response.ok, label, { status: result.response.status, body: compactOrganizationContext(result.body) });
  const organization = isRecord(own(result.body, "organization")) ? own(result.body, "organization") : null;
  const currentMember = isRecord(own(result.body, "currentMember")) ? own(result.body, "currentMember") : null;
  witness(ctx, typeof own(organization, "id") === "string", "Active organization id is present", compactOrganizationContext(result.body));
  witness(ctx, currentMemberCanAdmin(currentMember), "The signed-in member can administer MCP connections", compactOrganizationContext(result.body));
  state.organization = organization;
  state.currentMember = currentMember;
  return result.body;
}

async function ensureWorkspace(ctx, token) {
  const existing = await authedDenFetch(ctx, "/v1/org", token);
  if (existing.response.ok) {
    state.orgMode = "existing_or_single_org";
    const body = existing.body;
    const currentMember = isRecord(own(body, "currentMember")) ? own(body, "currentMember") : null;
    witness(ctx, currentMemberCanAdmin(currentMember), "Existing active organization grants admin rights", compactOrganizationContext(body));
    state.organization = isRecord(own(body, "organization")) ? own(body, "organization") : null;
    state.currentMember = currentMember;
    return body;
  }

  witness(ctx, existing.response.status === 404, "New admin starts without an active organization before bootstrap in multi-org mode", { status: existing.response.status, body: existing.body });
  const created = await authedDenFetch(ctx, "/v1/org", token, {
    method: "POST",
    body: JSON.stringify({ name: `Provider Auth Relay ${RUN_TAG}` }),
  });
  if (created.response.status === 409 && own(created.body, "error") === "single_org_mode") {
    state.orgMode = "single_org";
    return loadOrgContext(ctx, token, "Single-org deployment resolves the admin's singleton workspace");
  }

  state.orgMode = "multi_org";
  witness(ctx, created.response.status === 201, "Multi-org deployment creates a new workspace for the admin", { status: created.response.status, body: created.body });
  return loadOrgContext(ctx, token, "The newly created workspace is active for the admin session");
}

function compactConnection(connection) {
  return {
    id: own(connection, "id"),
    name: own(connection, "name"),
    url: own(connection, "url"),
    authType: own(connection, "authType"),
    credentialMode: own(connection, "credentialMode"),
    connected: own(connection, "connected"),
    connectedForMe: own(connection, "connectedForMe"),
    access: own(connection, "access"),
  };
}

async function createGatewayConnection(ctx, input) {
  const result = await authedDenFetch(ctx, "/v1/mcp-connections", state.adminToken, {
    method: "POST",
    body: JSON.stringify({
      name: input.name,
      url: input.url,
      authType: "none",
      credentialMode: "shared",
      access: { orgWide: true, memberIds: [], teamIds: [] },
    }),
  });
  witness(ctx, result.response.ok, `${input.name} is registered through POST /v1/mcp-connections`, { status: result.response.status, body: compactConnection(result.body) });
  witness(ctx, own(result.body, "authType") === "none", `${input.name} uses no-auth gateway credentials`, compactConnection(result.body));
  witness(ctx, own(result.body, "credentialMode") === "shared", `${input.name} uses one shared org connection`, compactConnection(result.body));
  witness(ctx, own(result.body, "connected") === true, `${input.name} validated and is marked connected`, compactConnection(result.body));
  return result.body;
}

async function gatewayRpc(endpoint, payload) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let body = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {}
  return { response, body, text };
}

function toolListIncludes(body, toolName) {
  const result = isRecord(own(body, "result")) ? own(body, "result") : null;
  const tools = Array.isArray(own(result, "tools")) ? own(result, "tools") : [];
  return tools.some((tool) => isRecord(tool) && own(tool, "name") === toolName);
}

function jsonRpcError(body) {
  return isRecord(own(body, "error")) ? own(body, "error") : null;
}

function jsonRpcConnectUrl(body) {
  const error = jsonRpcError(body);
  const data = isRecord(own(error, "data")) ? own(error, "data") : null;
  return typeof own(data, "connect_url") === "string" ? own(data, "connect_url") : null;
}

async function captureRawGatewayAuthRequired(ctx, endpoint, label) {
  const initialize = await gatewayRpc(endpoint, {
    jsonrpc: "2.0",
    id: `${label}-initialize`,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: FLOW_ID, version: "1.0.0" } },
  });
  witness(ctx, initialize.response.status === 200, `${label} initialize returns HTTP 200`, { status: initialize.response.status, body: initialize.body });

  const tools = await gatewayRpc(endpoint, { jsonrpc: "2.0", id: `${label}-tools`, method: "tools/list", params: {} });
  witness(ctx, tools.response.status === 200, `${label} tools/list returns HTTP 200`, { status: tools.response.status, body: tools.body });
  witness(ctx, toolListIncludes(tools.body, TOOL_NAME), `${label} tools/list advertises ${TOOL_NAME}`, tools.body);

  const call = await gatewayRpc(endpoint, {
    jsonrpc: "2.0",
    id: `${label}-call`,
    method: "tools/call",
    params: { name: TOOL_NAME, arguments: {} },
  });
  const error = jsonRpcError(call.body);
  const connectUrl = jsonRpcConnectUrl(call.body);
  witness(ctx, call.response.status === 200, `${label} tools/call returns HTTP 200 even though the provider requires auth`, { status: call.response.status, body: call.body });
  witness(ctx, own(error, "code") === -32001, `${label} tools/call body carries JSON-RPC -32001`, call.body);
  witness(ctx, typeof connectUrl === "string", `${label} tools/call body carries error.data.connect_url`, call.body);
  witness(ctx, String(own(error, "message") ?? "").includes("Authorization required"), `${label} tools/call message says authorization is required`, call.body);
  return { initialize, tools, call, connectUrl };
}

async function mintMcpToken(ctx) {
  const result = await authedDenFetch(ctx, "/v1/mcp/token", state.adminToken, {
    method: "POST",
    body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }),
  });
  const token = isRecord(result.body) && typeof own(result.body, "token") === "string" ? own(result.body, "token") : null;
  witness(ctx, result.response.ok && typeof token === "string", "A session bearer mints an org-scoped MCP bearer token", {
    status: result.response.status,
    body: {
      token: token ? "<redacted>" : null,
      expiresAt: own(result.body, "expiresAt"),
      organizationId: own(result.body, "organizationId"),
      scopes: own(result.body, "scopes"),
      resource: own(result.body, "resource"),
    },
  });
  state.mcpToken = token;
  return token;
}

async function withAgentClient(ctx, callback) {
  const { denApiUrl } = requiredEnv(ctx);
  const token = state.mcpToken ?? await mintMcpToken(ctx);
  const transport = new StreamableHTTPClientTransport(new URL(`${denApiUrl}/mcp/agent`), {
    requestInit: {
      headers: { authorization: `Bearer ${token}` },
    },
  });
  const client = new Client({ name: `${FLOW_ID}-client`, version: "1.0.0" });
  try {
    await client.connect(transport);
    return await callback(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

function firstText(result) {
  const content = Array.isArray(own(result, "content")) ? own(result, "content") : [];
  const entry = content.find((item) => isRecord(item) && own(item, "type") === "text" && typeof own(item, "text") === "string");
  return entry ? own(entry, "text") : null;
}

function parseToolTextJson(ctx, result, label) {
  const text = firstText(result);
  witness(ctx, typeof text === "string", `${label} returned text content`, result);
  try {
    return JSON.parse(text);
  } catch {
    witness(ctx, false, `${label} returned parseable JSON text`, text);
    return null;
  }
}

function findMatch(ctx, searchBody, expectedName) {
  const matches = Array.isArray(own(searchBody, "matches")) ? own(searchBody, "matches") : [];
  const match = matches.find((entry) => isRecord(entry) && own(entry, "name") === expectedName) ?? null;
  witness(ctx, Boolean(match), `search_capabilities returns ${expectedName}`, { expectedName, matches });
  witness(ctx, typeof own(match, "schemaDigest") === "string", `${expectedName} includes schemaDigest`, match);
  witness(ctx, isRecord(own(match, "argumentsSchema")), `${expectedName} includes provider argumentsSchema`, match);
  return match;
}

async function searchAndExecuteGateway(ctx, connection, query) {
  const expectedName = `mcp:${own(connection, "id")}:${TOOL_NAME}`;
  return withAgentClient(ctx, async (client) => {
    const search = await client.callTool({
      name: "search_capabilities",
      arguments: { query, limit: 10, type: "mcp" },
    });
    const searchBody = parseToolTextJson(ctx, search, "search_capabilities");
    const match = findMatch(ctx, searchBody, expectedName);
    const execute = await client.callTool({
      name: "execute_capability",
      arguments: { name: expectedName, schemaDigest: own(match, "schemaDigest"), body: {} },
    });
    witness(ctx, own(execute, "isError") === true, "execute_capability returns an MCP tool error envelope", execute);
    const envelope = parseToolTextJson(ctx, execute, "execute_capability");
    return { searchBody, match, execute, envelope };
  });
}

function assertSameHostConnectUrl(ctx, connectUrl, connectionUrl) {
  const connect = new URL(connectUrl);
  const connection = new URL(connectionUrl);
  witness(ctx, connect.host === connection.host, "The provider connect link is on the same host as gateway A", { connectUrl, connectionUrl });
}

function assertForeignHostConnectUrl(ctx, connectUrl, connectionUrl) {
  const connect = new URL(connectUrl);
  const connection = new URL(connectionUrl);
  witness(ctx, connect.host !== connection.host, "The foreign provider connect link is on a different host than gateway B", { connectUrl, connectionUrl });
}

function assertProviderAuthEnvelope(ctx, envelope, expectedConnectUrl) {
  const providerError = isRecord(own(envelope, "providerError")) ? own(envelope, "providerError") : null;
  const connectionStatus = isRecord(own(envelope, "connectionStatus")) ? own(envelope, "connectionStatus") : null;
  const action = isRecord(own(connectionStatus, "action")) ? own(connectionStatus, "action") : null;
  witness(ctx, own(envelope, "error") === "needs_connection", "execute_capability error is needs_connection", envelope);
  witness(ctx, typeof own(envelope, "referenceId") === "string", "execute_capability exposes a diagnostic referenceId", envelope);
  witness(ctx, own(envelope, "retryable") === false, "execute_capability retryable is false", envelope);
  witness(ctx, own(providerError, "jsonRpcCode") === -32001, "providerError.jsonRpcCode carries the provider JSON-RPC code", providerError);
  witness(ctx, String(own(providerError, "message") ?? "").includes("Authorization required"), "providerError.message carries the provider authorization wording", providerError);
  witness(ctx, String(own(providerError, "data") ?? "").includes(expectedConnectUrl), "providerError.data includes the provider connect-link declaration", providerError);
  witness(ctx, own(connectionStatus, "layer") === "downstream_provider", "connectionStatus.layer is downstream_provider", connectionStatus);
  witness(ctx, own(connectionStatus, "state") === "needs_connection", "connectionStatus.state is needs_connection", connectionStatus);
  witness(ctx, own(action, "type") === "connect", "connectionStatus.action.type is connect", action);
  witness(ctx, own(action, "url") === expectedConnectUrl, "connectionStatus.action.url is exactly the gateway connect link", action);
  witness(ctx, own(envelope, "diagnostic") === undefined, "execute_capability does not expose the internal diagnostic object", envelope);
  witness(ctx, own(envelope, "actionOwner") === undefined, "execute_capability does not expose actionOwner", envelope);
  witness(ctx, own(envelope, "operatorAction") === undefined, "execute_capability does not expose operatorAction", envelope);
  witness(ctx, own(connectionStatus, "diagnostic") === undefined, "connectionStatus does not embed the internal diagnostic object", connectionStatus);
  witness(ctx, !TIMEOUT_WORDING.test(String(own(envelope, "message") ?? "")), "execute_capability message contains no latency or timeout wording", own(envelope, "message"));
}

function assertForeignLinkStrippedEnvelope(ctx, envelope) {
  const providerError = isRecord(own(envelope, "providerError")) ? own(envelope, "providerError") : null;
  const connectionStatus = isRecord(own(envelope, "connectionStatus")) ? own(envelope, "connectionStatus") : null;
  const action = isRecord(own(connectionStatus, "action")) ? own(connectionStatus, "action") : null;
  witness(ctx, own(envelope, "error") === "needs_connection", "foreign-host execute_capability error is still needs_connection", envelope);
  witness(ctx, typeof own(envelope, "referenceId") === "string", "foreign-host envelope exposes a diagnostic referenceId", envelope);
  witness(ctx, own(envelope, "retryable") === false, "foreign-host envelope retryable is false", envelope);
  witness(ctx, own(providerError, "jsonRpcCode") === -32001, "foreign-host providerError.jsonRpcCode carries the provider JSON-RPC code", providerError);
  witness(ctx, own(connectionStatus, "layer") === "downstream_provider", "foreign-host connectionStatus.layer is downstream_provider", connectionStatus);
  witness(ctx, own(connectionStatus, "state") === "needs_connection", "foreign-host connectionStatus.state is needs_connection", connectionStatus);
  witness(ctx, own(action, "type") === "connect", "foreign-host action still tells the member to connect", action);
  witness(ctx, own(envelope, "diagnostic") === undefined, "foreign-host envelope does not expose the internal diagnostic object", envelope);
  witness(ctx, own(connectionStatus, "diagnostic") === undefined, "foreign-host connectionStatus does not embed diagnostics", connectionStatus);
  witness(ctx, own(action, "url") === undefined, "foreign-host connectionStatus.action.url is stripped", action);
  witness(ctx, !TIMEOUT_WORDING.test(String(own(envelope, "message") ?? "")), "foreign-host message contains no latency or timeout wording", own(envelope, "message"));
}

export default {
  id: FLOW_ID,
  title: "Den relays downstream provider authorization links without masking them as timeouts",
  kind: "internal",
  requiresApp: false,
  steps: [
    {
      name: "Frame 1 — The fixed Den API is reachable on Daytona",
      run: async (ctx) => {
        await ctx.prove("A real Den API answers health checks from the configured Daytona URL", {
          voiceover: vo[0],
          action: async () => {
            const { denApiUrl } = requiredEnv(ctx);
            state.health = await fetchJson(`${denApiUrl}/health`);
          },
          assert: async () => {
            const { denApiUrl } = requiredEnv(ctx);
            witness(ctx, state.health.response.ok, "GET /health returns HTTP 200", { status: state.health.response.status, body: state.health.body });
            witness(ctx, own(state.health.body, "ok") === true, "Health payload reports ok: true", state.health.body);
            witness(ctx, own(state.health.body, "service") === "den-api", "Health payload identifies den-api", state.health.body);
            witness(ctx, typeof own(state.health.body, "version") === "string", "Health payload exposes the configured service version", state.health.body);
            const version = String(own(state.health.body, "version") ?? "");
            if (/commit [a-f0-9]{7}/i.test(version)) {
              witness(ctx, true, "Health payload includes a commit-shaped service version", version);
            }
            ctx.output("den-api-health", JSON.stringify({ baseUrl: denApiUrl, health: state.health.body }, null, 2));
          },
        });
      },
    },
    {
      name: "Frame 2 — Admin registers gateway A and captures the raw provider auth payload",
      run: async (ctx) => {
        await ctx.prove("The admin publishes a no-auth gateway MCP connection and the gateway returns structured downstream authorization", {
          voiceover: vo[1],
          action: async () => {
            const { gatewayMcpUrl } = requiredEnv(ctx);
            const adminToken = await signUpAndSignInAdmin(ctx);
            await ensureWorkspace(ctx, adminToken);
            state.gatewayA = await createGatewayConnection(ctx, { name: CONNECTION_A_NAME, url: gatewayMcpUrl });
            state.rawGatewayA = await captureRawGatewayAuthRequired(ctx, gatewayMcpUrl, "gateway A");
          },
          assert: async () => {
            const { gatewayMcpUrl } = requiredEnv(ctx);
            assertSameHostConnectUrl(ctx, state.rawGatewayA.connectUrl, gatewayMcpUrl);
            ctx.output("workspace-and-gateway-a", JSON.stringify({
              runTag: RUN_TAG,
              admin: { email: ADMIN_EMAIL, sessionToken: "<redacted>" },
              orgMode: state.orgMode,
              organization: compactOrganizationContext({ organization: state.organization, currentMember: state.currentMember }),
              connection: compactConnection(state.gatewayA),
            }, null, 2));
            ctx.output("raw-gateway-a-auth-required-json-rpc", JSON.stringify({
              endpoint: gatewayMcpUrl,
              initialize: { httpStatus: state.rawGatewayA.initialize.response.status, body: state.rawGatewayA.initialize.body },
              toolsList: { httpStatus: state.rawGatewayA.tools.response.status, body: state.rawGatewayA.tools.body },
              toolsCall: { httpStatus: state.rawGatewayA.call.response.status, body: state.rawGatewayA.call.body },
            }, null, 2));
          },
        });
      },
    },
    {
      name: "Frame 3 — Agent execute relays the provider sign-in link",
      run: async (ctx) => {
        await ctx.prove("The agent-facing MCP surface returns needs_connection with the downstream provider connect URL", {
          voiceover: vo[2],
          action: async () => {
            await mintMcpToken(ctx);
            state.gatewayA.agentResult = await searchAndExecuteGateway(ctx, state.gatewayA, `${CONNECTION_A_NAME} ${TOOL_NAME}`);
          },
          assert: async () => {
            assertProviderAuthEnvelope(ctx, state.gatewayA.agentResult.envelope, state.rawGatewayA.connectUrl);
            ctx.output("agent-gateway-a-search-and-execute", JSON.stringify({
              search: state.gatewayA.agentResult.searchBody,
              selectedMatch: state.gatewayA.agentResult.match,
              executeEnvelope: state.gatewayA.agentResult.envelope,
            }, null, 2));
          },
        });
      },
    },
    {
      name: "Frame 4 — Foreign-host provider links are stripped",
      run: async (ctx) => {
        await ctx.prove("Den keeps the downstream needs_connection state but strips a foreign-host connect URL", {
          voiceover: vo[3],
          action: async () => {
            const { foreignGatewayMcpUrl } = requiredEnv(ctx);
            state.gatewayB = await createGatewayConnection(ctx, { name: CONNECTION_B_NAME, url: foreignGatewayMcpUrl });
            state.rawGatewayB = await captureRawGatewayAuthRequired(ctx, foreignGatewayMcpUrl, "gateway B");
            state.gatewayB.agentResult = await searchAndExecuteGateway(ctx, state.gatewayB, `${CONNECTION_B_NAME} ${TOOL_NAME}`);
          },
          assert: async () => {
            const { foreignGatewayMcpUrl } = requiredEnv(ctx);
            assertForeignHostConnectUrl(ctx, state.rawGatewayB.connectUrl, foreignGatewayMcpUrl);
            assertForeignLinkStrippedEnvelope(ctx, state.gatewayB.agentResult.envelope);
            ctx.output("raw-gateway-b-and-stripped-agent-envelope", JSON.stringify({
              endpoint: foreignGatewayMcpUrl,
              rawToolsCall: { httpStatus: state.rawGatewayB.call.response.status, body: state.rawGatewayB.call.body },
              selectedMatch: state.gatewayB.agentResult.match,
              executeEnvelope: state.gatewayB.agentResult.envelope,
            }, null, 2));
          },
        });
      },
    },
  ],
};
