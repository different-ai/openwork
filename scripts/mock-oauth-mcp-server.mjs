#!/usr/bin/env node
import http from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const args = process.argv.slice(2);

function argValue(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function firstExtraPort() {
  return process.env.OPENWORK_EXTRA_APP_PORTS?.split(",")[0]?.trim() || undefined;
}

function hostForUrl(value) {
  const normalized = value.replace(/^\[|\]$/g, "");
  return isIP(normalized) === 6 ? `[${normalized}]` : value;
}

if (args.includes("--help")) {
  console.log(`OpenWork enterprise diagnostic MCP mock

Usage:
  pnpm dev:mcp-diagnostic -- --profile <name> [--response-mode json|sse] [--auth-mode bearer|none] [--fault <name>]

Profiles:
  generic, servicenow, workiq, microsoft-enterprise, agent365-mail

Representative faults:
  expired_session, cursor_loop, provider_denied, provider_throttled,
  missing_auth_challenge, bad_resource_metadata, issuer_mismatch, no_pkce,
  dcr_unsupported, invalid_client, invalid_grant, wrong_audience,
  unsupported_version, malformed_initialize, notification_rejected,
  wrong_content_type, broken_sse, empty_tool_catalog

The default listener is loopback-only and all records/tokens are synthetic.
Non-loopback binding requires --unsafe-allow-non-loopback. Request-log access
is disabled unless MCP_MOCK_DIAGNOSTICS_KEY is configured.`);
  process.exit(0);
}

const profileName = argValue("--profile") || process.env.MCP_MOCK_PROFILE || "generic";
const fault = argValue("--fault") || process.env.MCP_MOCK_FAULT || "none";
const responseMode = argValue("--response-mode") || process.env.MCP_MOCK_RESPONSE_MODE || "json";
const authMode = argValue("--auth-mode") || process.env.MCP_MOCK_AUTH_MODE || "bearer";
const host = argValue("--host") || process.env.HOST || "127.0.0.1";
const port = Number(
  argValue("--port")
    || process.env.MCP_DIAGNOSTIC_MOCK_PORT
    || firstExtraPort()
    || process.env.PORT
    || 3978,
);
const issuer = process.env.ISSUER || `http://${hostForUrl(host)}:${port}`;
const autoApprove = process.env.AUTO_APPROVE !== "0";
const disableDcrRequested = process.env.DISABLE_DCR === "1" || fault === "dcr_unsupported";
const enableDcrRequested = process.env.MCP_MOCK_ENABLE_DCR === "1";
const mockClientId = process.env.MOCK_CLIENT_ID || "mock-preregistered-client";
const mockClientSecret = process.env.MOCK_CLIENT_SECRET || "mock-preregistered-secret";
const preregisteredRedirectUris = (process.env.MOCK_REDIRECT_URIS || "http://127.0.0.1:19876/mock/callback")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const unsafeAllowNonLoopback = args.includes("--unsafe-allow-non-loopback")
  || process.env.MCP_MOCK_UNSAFE_ALLOW_NON_LOOPBACK === "1";
const diagnosticsKey = process.env.MCP_MOCK_DIAGNOSTICS_KEY?.trim() || null;

const MAX_REQUEST_BODY_BYTES = 256 * 1024;
const requestedTestCap = Number(process.env.MCP_MOCK_TEST_STATE_CAP);
const testStateCap = Number.isInteger(requestedTestCap) && requestedTestCap >= 5 && requestedTestCap <= 50
  ? requestedTestCap
  : null;
const MAX_CLIENTS = testStateCap ?? 100;
const MAX_APPROVAL_TRANSACTIONS = testStateCap ?? 100;
const MAX_CODES = testStateCap ?? 200;
const MAX_ACCESS_TOKENS = testStateCap ?? 300;
const MAX_REFRESH_TOKENS = testStateCap ?? 200;
const MAX_SESSIONS = testStateCap ?? 200;
const MAX_REQUEST_LOG_ENTRIES = testStateCap ?? 500;
const MAX_DRAFTS = testStateCap ?? 100;
const MAX_LEDGER_ENTRIES = testStateCap ?? 200;
const requestedTestTtl = Number(process.env.MCP_MOCK_TEST_STATE_TTL_MS);
const testStateTtlMs = Number.isFinite(requestedTestTtl) && requestedTestTtl >= 10 && requestedTestTtl <= 60_000
  ? requestedTestTtl
  : null;
const CLIENT_TTL_MS = testStateTtlMs ?? 60 * 60 * 1000;
const APPROVAL_TRANSACTION_TTL_MS = testStateTtlMs ?? 5 * 60 * 1000;
const AUTHORIZATION_CODE_TTL_MS = testStateTtlMs ?? 2 * 60 * 1000;
const ACCESS_TOKEN_TTL_MS = testStateTtlMs ?? 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = testStateTtlMs ?? 2 * 60 * 60 * 1000;
const SESSION_TTL_MS = testStateTtlMs ?? 15 * 60 * 1000;
const REQUEST_LOG_TTL_MS = testStateTtlMs ?? 60 * 60 * 1000;
const DRAFT_TTL_MS = testStateTtlMs ?? 15 * 60 * 1000;
const LEDGER_TTL_MS = testStateTtlMs ?? 60 * 60 * 1000;

const FIXTURE_VERIFIED_AT = "2026-07-10";
const SERVICE_NOW_DOCUMENTATION = "https://www.servicenow.com/docs/r/intelligent-experiences/connect-mcp-server-client.html";
const WORK_IQ_DOCUMENTATION = "https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/mcp/tool-reference";
const WORK_IQ_PERMISSIONS_DOCUMENTATION = "https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/permissions";
const AGENT_365_MAIL_DOCUMENTATION = "https://learn.microsoft.com/en-us/microsoft-copilot-studio/mcp-mail-work-iq";
const AGENT_365_TOOLING_DOCUMENTATION = "https://learn.microsoft.com/en-us/microsoft-agent-365/developer/tooling";
const MOCK_TENANT_ID = process.env.MCP_MOCK_TENANT_ID || "mock-tenant";
const AGENT_365_MAIL_AUDIENCE = "api://05879165-0320-489e-b644-f72b33f3edf0";

const SUPPORTED_FAULTS = new Set([
  "none",
  "missing_auth_challenge",
  "bad_resource_metadata",
  "issuer_mismatch",
  "no_pkce",
  "dcr_unsupported",
  "invalid_client",
  "invalid_grant",
  "wrong_audience",
  "unsupported_version",
  "malformed_initialize",
  "expired_session",
  "notification_rejected",
  "wrong_content_type",
  "broken_sse",
  "empty_tool_catalog",
  "cursor_loop",
  "oversized_catalog_response",
  "deep_tool_schema",
  "oversized_schema_string",
  "oversized_cursor",
  "oversized_tool_name",
  "too_many_page_tools",
  "too_many_total_tools",
  "too_many_pages",
  "total_response_budget",
  "slow_tools_list",
  "hung_delete",
  "open_sse_after_result",
  "internal_error",
  "provider_denied",
  "provider_throttled",
]);
const ADVERTISED_FAULTS = [
  "expired_session",
  "cursor_loop",
  "provider_denied",
  "provider_throttled",
  "missing_auth_challenge",
  "bad_resource_metadata",
  "issuer_mismatch",
  "no_pkce",
  "dcr_unsupported",
  "invalid_client",
  "invalid_grant",
  "wrong_audience",
  "unsupported_version",
  "malformed_initialize",
  "notification_rejected",
  "wrong_content_type",
  "broken_sse",
  "empty_tool_catalog",
];

const syntheticIncident = {
  number: "INC0000001",
  short_description: "Synthetic printer test incident",
  state: "In Progress",
  sys_id: "00000000000000000000000000000001",
};

const syntheticUser = {
  id: "00000000-0000-0000-0000-000000000001",
  displayName: "Synthetic User",
  userPrincipalName: "synthetic.user@example.invalid",
};

function tool(name, description, properties = {}, required = [], annotations = { readOnlyHint: true }) {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
    },
    annotations,
  };
}

const profiles = {
  generic: {
    endpoint: "/mcp",
    scopes: ["mcp:read", "mcp:write"],
    audience: null,
    tenantId: null,
    registrationMode: "dynamic",
    identityProvider: "mock-oauth",
    documentation: [],
    protocols: ["2025-06-18"],
    pageSize: 20,
    tools: [
      tool("mock_echo", "Echoes text from the mock OAuth MCP server.", { text: { type: "string" } }, ["text"]),
    ],
  },
  servicenow: {
    endpoint: "/sncapps/mcp-server/mcp/sn_mcp_server_default",
    scopes: ["mcp_server"],
    audience: null,
    tenantId: null,
    registrationMode: "manual",
    identityProvider: "servicenow-instance-oauth",
    tokenEndpointAuthMethod: "client_secret_post",
    documentation: [SERVICE_NOW_DOCUMENTATION],
    protocols: ["2025-06-18"],
    pageSize: 2,
    tools: [
      tool("case_summarization", "Get a synthetic summary of details in a case record.", { case_number: { type: "string" } }, ["case_number"]),
      tool("incident_summarization", "Get a synthetic summary of details in an incident record.", { incident_number: { type: "string" } }, ["incident_number"]),
      tool("look_up_case_records", "Look up bounded synthetic case records for summarization.", { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 10 } }),
      tool("look_up_incident_records", "Look up bounded synthetic incident records for summarization.", { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 10 } }),
    ],
  },
  workiq: {
    endpoint: "/mcp",
    scopes: ["api://workiq.svc.cloud.microsoft/WorkIQAgent.Ask"],
    audience: "api://workiq.svc.cloud.microsoft",
    tenantId: MOCK_TENANT_ID,
    registrationMode: "pre_registered",
    identityProvider: "microsoft-entra-tenant",
    tokenEndpointAuthMethod: "client_secret_post",
    documentation: [WORK_IQ_DOCUMENTATION, WORK_IQ_PERMISSIONS_DOCUMENTATION],
    protocols: ["2025-11-25", "2025-06-18"],
    pageSize: 3,
    tools: [
      tool("fetch", "Reads one or more synthetic Microsoft 365 entities by resource path.", { entityUrls: { type: "array", items: { type: "string" }, minItems: 1 }, agentId: { type: "string" } }, ["entityUrls"]),
      tool("create_entity", "Creates a synthetic entity in a collection.", { parentUrl: { type: "string" }, jsonBody: { type: "string" }, agentId: { type: "string" } }, ["parentUrl", "jsonBody"], { readOnlyHint: false, destructiveHint: false }),
      tool("update_entity", "Updates a synthetic entity.", { entityUrl: { type: "string" }, jsonBody: { type: "string" }, agentId: { type: "string" } }, ["entityUrl", "jsonBody"], { readOnlyHint: false, destructiveHint: false }),
      tool("delete_entity", "Deletes a synthetic entity.", { entityUrl: { type: "string" }, agentId: { type: "string" } }, ["entityUrl"], { readOnlyHint: false, destructiveHint: true }),
      tool("do_action", "Executes a synthetic side-effect action.", { actionUrl: { type: "string" }, jsonBody: { type: "string" }, agentId: { type: "string" } }, ["actionUrl"], { readOnlyHint: false }),
      tool("call_function", "Calls a synthetic Microsoft Graph function.", { functionUrl: { type: "string" }, agentId: { type: "string" } }, ["functionUrl"]),
      tool("ask", "Answers from synthetic work context.", { question: { type: "string" }, agentId: { type: "string" }, fileUrls: { type: "array", items: { type: "string" } }, conversationId: { type: "string" }, timeZone: { type: "string" } }, ["question"]),
      tool("list_agents", "Lists synthetic Work IQ agents."),
      tool("get_schema", "Returns a synthetic schema for an operation.", { operationIds: { type: "string" }, path: { type: "string" }, operationType: { type: "string", enum: ["fetch", "create", "update"] }, format: { type: "string", enum: ["jsonschema", "typescript"] }, backend: { type: "string" }, agentId: { type: "string" } }, ["operationType"]),
      tool("search_paths", "Searches synthetic Microsoft 365 paths by prefix or regular expression.", { filter: { type: "string" }, backend: { type: "string" }, agentId: { type: "string" } }, ["filter"]),
    ],
  },
  "microsoft-enterprise": {
    endpoint: "/enterprise",
    scopes: ["MCP.User.Read.All"],
    audience: "api://mock-microsoft-enterprise",
    tenantId: MOCK_TENANT_ID,
    registrationMode: "pre_registered",
    identityProvider: "microsoft-entra-tenant",
    tokenEndpointAuthMethod: "client_secret_post",
    documentation: [],
    protocols: ["2025-11-25", "2025-06-18"],
    pageSize: 2,
    tools: [
      tool("microsoft_graph_suggest_queries", "Suggests bounded read-only directory queries.", { question: { type: "string" } }, ["question"]),
      tool("microsoft_graph_get", "Reads one synthetic directory resource.", { path: { type: "string" } }, ["path"]),
      tool("microsoft_graph_list_properties", "Lists safe properties for a synthetic resource.", { resource: { type: "string" } }, ["resource"]),
    ],
  },
  "agent365-mail": {
    endpoint: `/agents/tenants/${MOCK_TENANT_ID}/servers/mcp_MailTools`,
    scopes: ["McpServers.Mail.All"],
    audience: AGENT_365_MAIL_AUDIENCE,
    tenantId: MOCK_TENANT_ID,
    registrationMode: "pre_registered",
    identityProvider: "microsoft-entra-tenant",
    tokenEndpointAuthMethod: "client_secret_post",
    documentation: [AGENT_365_MAIL_DOCUMENTATION, AGENT_365_TOOLING_DOCUMENTATION],
    protocols: ["2025-11-25", "2025-06-18"],
    pageSize: 2,
    tools: [
      tool("mcp_MailTools_graph_mail_createMessage", "Creates a synthetic draft email.", { subject: { type: "string" }, toRecipients: { type: "array", items: { type: "object" } }, body: { type: "object" }, preferHtml: { type: "boolean" }, headers: { type: "object" } }, ["subject", "toRecipients", "body"], { readOnlyHint: false, destructiveHint: false }),
      tool("mcp_MailTools_graph_mail_deleteMessage", "Deletes a synthetic message.", { id: { type: "string" }, "If-Match": { type: "string" } }, ["id"], { readOnlyHint: false, destructiveHint: true }),
      tool("mcp_MailTools_graph_mail_getMessage", "Gets one synthetic message by ID.", { id: { type: "string" }, select: { type: "string" }, expand: { type: "string" }, preferHtml: { type: "boolean" }, headers: { type: "object" } }, ["id"]),
      tool("mcp_MailTools_graph_mail_listSent", "Lists synthetic sent messages.", { filter: { type: "string" }, search: { type: "string" }, orderby: { type: "string" }, top: { type: "integer", minimum: 1 }, select: { type: "string" } }),
      tool("mcp_MailTools_graph_mail_reply", "Records a synthetic reply.", { id: { type: "string" }, comment: { type: "string" }, message: { type: "object" }, preferHtml: { type: "boolean" }, headers: { type: "object" } }, ["id"], { readOnlyHint: false, destructiveHint: false }),
      tool("mcp_MailTools_graph_mail_replyAll", "Records a synthetic reply-all.", { id: { type: "string" }, comment: { type: "string" }, message: { type: "object" }, preferHtml: { type: "boolean" }, headers: { type: "object" } }, ["id"], { readOnlyHint: false, destructiveHint: false }),
      tool("mcp_MailTools_graph_mail_searchMessages", "Searches synthetic Outlook messages.", { requests: { type: "array", items: { type: "object" }, minItems: 1 } }, ["requests"]),
      tool("mcp_MailTools_graph_mail_sendDraft", "Records a synthetic draft send.", { id: { type: "string" } }, ["id"], { readOnlyHint: false, destructiveHint: false }),
      tool("mcp_MailTools_graph_mail_sendMail", "Records a synthetic mail send.", { message: { type: "object" }, saveToSentItems: { type: "boolean" }, preferHtml: { type: "boolean" }, headers: { type: "object" } }, ["message"], { readOnlyHint: false, destructiveHint: false }),
      tool("mcp_MailTools_graph_mail_updateMessage", "Updates a synthetic message.", { id: { type: "string" }, subject: { type: "string" }, body: { type: "object" }, categories: { type: "array", items: { type: "string" } }, importance: { type: "string", enum: ["Low", "Normal", "High"] }, "If-Match": { type: "string" } }, ["id"], { readOnlyHint: false, destructiveHint: false }),
    ],
  },
};

if (!(profileName in profiles)) {
  console.error(`[mock-oauth-mcp] unknown profile: ${profileName}`);
  process.exit(2);
}
if (!SUPPORTED_FAULTS.has(fault)) {
  console.error(`[mock-oauth-mcp] unknown fault: ${fault}`);
  process.exit(2);
}
if (responseMode !== "json" && responseMode !== "sse") {
  console.error(`[mock-oauth-mcp] response mode must be json or sse`);
  process.exit(2);
}
if (authMode !== "bearer" && authMode !== "none") {
  console.error("[mock-oauth-mcp] auth mode must be bearer or none");
  process.exit(2);
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`[mock-oauth-mcp] invalid port: ${String(port)}`);
  process.exit(2);
}
function isLoopbackAddress(value) {
  const normalized = value.replace(/^\[|\]$/g, "").toLowerCase();
  const version = isIP(normalized);
  if (version === 4) return Number(normalized.split(".")[0]) === 127;
  if (version === 6) return normalized === "::1";
  return false;
}

async function isLoopbackBindHost(value) {
  const normalized = value.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(normalized)) return isLoopbackAddress(normalized);
  if (normalized !== "localhost") return false;
  try {
    const addresses = await lookup(normalized, { all: true, verbatim: true });
    return addresses.length > 0 && addresses.every(({ address }) => isLoopbackAddress(address));
  } catch {
    return false;
  }
}

const loopbackHost = await isLoopbackBindHost(host);
if (!loopbackHost && !unsafeAllowNonLoopback) {
  console.error("[mock-oauth-mcp] refusing non-loopback bind; pass --unsafe-allow-non-loopback explicitly");
  process.exit(2);
}

const profile = {
  ...profiles[profileName],
  endpoint: argValue("--endpoint") || process.env.MCP_MOCK_ENDPOINT || profiles[profileName].endpoint,
};
const resource = `${issuer}${profile.endpoint}`;
const audience = profile.audience || resource;
const authorizationIssuer = profile.identityProvider === "microsoft-entra-tenant"
  ? `${issuer}/mock-entra/${profile.tenantId}/v2.0`
  : issuer;
const disableDcr = disableDcrRequested || (!enableDcrRequested && profile.registrationMode !== "dynamic");
if (!(await Promise.all(preregisteredRedirectUris.map((redirectUri) => validRedirectUri(redirectUri)))).every(Boolean)) {
  console.error("[mock-oauth-mcp] MOCK_REDIRECT_URIS contains an unsafe redirect URI");
  process.exit(2);
}
const clients = new Map();
const approvalTransactions = new Map();
const codes = new Map();
const tokens = new Map();
const refreshTokens = new Map();
const sessions = new Map();
const requests = [];
const drafts = [];
const operationLedger = new Map();
let correlationSequence = 0;
const activeRequestStates = new Set();

function pruneExpiringMap(map, now = Date.now()) {
  for (const [key, value] of map) {
    if (!value?.permanent && typeof value?.expiresAt === "number" && value.expiresAt <= now) map.delete(key);
  }
}

function setBoundedExpiring(map, key, value, maxEntries, ttlMs, options = {}) {
  pruneExpiringMap(map);
  while (map.size >= maxEntries) {
    const evictable = [...map].find(([, entry]) => !entry?.permanent);
    if (!evictable) throw new Error("bounded mock state is full");
    map.delete(evictable[0]);
  }
  map.set(key, {
    ...value,
    expiresAt: options.permanent ? Number.POSITIVE_INFINITY : Date.now() + ttlMs,
    ...(options.permanent ? { permanent: true } : {}),
  });
}

function getLive(map, key) {
  const value = map.get(key);
  if (!value) return null;
  if (!value.permanent && value.expiresAt <= Date.now()) {
    map.delete(key);
    return null;
  }
  return value;
}

function takeLive(map, key) {
  const value = getLive(map, key);
  if (value) map.delete(key);
  return value;
}

function pushBounded(array, value, maxEntries) {
  array.push(value);
  if (array.length > maxEntries) array.splice(0, array.length - maxEntries);
}

function pruneRequestLog(now = Date.now()) {
  while (requests.length > 0 && now - requests[0].recordedAtMs > REQUEST_LOG_TTL_MS) requests.shift();
}

function pruneDraftLog(now = Date.now()) {
  while (drafts.length > 0 && now - drafts[0].recordedAtMs > DRAFT_TTL_MS) drafts.shift();
}

function waitForDelayOrDisconnect(req, res, delayMs) {
  return new Promise((resolveDelay) => {
    let settled = false;
    let timer = null;
    let poll = null;
    const finish = (completed) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (poll) clearInterval(poll);
      req.off("aborted", disconnected);
      res.off("close", disconnected);
      resolveDelay(completed);
    };
    const disconnected = () => finish(false);
    timer = delayMs === null ? null : setTimeout(() => finish(true), delayMs);
    poll = setInterval(() => {
      if (req.destroyed || res.destroyed || res.socket?.destroyed) disconnected();
    }, 10);
    req.once("aborted", disconnected);
    res.once("close", disconnected);
    if (req.destroyed || res.destroyed || res.socket?.destroyed) disconnected();
  });
}

// Deterministic local-only token for protocol probes and Den integration tests.
// The normal browser OAuth flow still issues short-lived random fake tokens.
setBoundedExpiring(tokens, process.env.MOCK_ACCESS_TOKEN || "mock-access-token", {
  resource,
  audience,
  issuer: authorizationIssuer,
  tenantId: profile.tenantId,
  scope: profile.scopes.join(" "),
  clientId: "diagnostic-probe",
  subject: "synthetic-user",
}, MAX_ACCESS_TOKENS, ACCESS_TOKEN_TTL_MS, { permanent: true });
setBoundedExpiring(clients, mockClientId, {
  clientId: mockClientId,
  clientSecret: mockClientSecret,
  tokenEndpointAuthMethod: profile.tokenEndpointAuthMethod || "client_secret_post",
  redirectUris: preregisteredRedirectUris,
}, MAX_CLIENTS, CLIENT_TTL_MS, { permanent: true });

function responseHeaders(correlationId, headers = {}) {
  return {
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-mock-correlation-id": correlationId,
    ...headers,
  };
}

function json(res, status, body, correlationId, headers = {}) {
  res.writeHead(status, responseHeaders(correlationId, { "content-type": "application/json", ...headers }));
  res.end(JSON.stringify(body));
}

function html(res, status, body, correlationId, headers = {}) {
  res.writeHead(status, responseHeaders(correlationId, { "content-type": "text/html; charset=utf-8", ...headers }));
  res.end(body);
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;
    req.on("data", (chunk) => {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_REQUEST_BODY_BYTES) {
        settled = true;
        reject(new Error("request body exceeds mock limit"));
        req.destroy();
        return;
      }
      chunks.push(bytes);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, totalBytes).toString("utf8"));
    });
    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

async function readForm(req) {
  const raw = await readBody(req);
  return Object.fromEntries(new URLSearchParams(raw));
}

function record(req, url) {
  correlationSequence += 1;
  const correlationId = `mock-${profileName}-${String(correlationSequence).padStart(6, "0")}`;
  const redactedUrl = new URL(url);
  for (const key of redactedUrl.searchParams.keys()) {
    const normalized = key.toLowerCase();
    const sensitive = ["code", "client_secret", "code_verifier", "access_token", "refresh_token", "password", "assertion", "api_key", "state", "session", "session_id"].includes(normalized)
      || normalized.endsWith("_token")
      || normalized.endsWith("_secret")
      || normalized.endsWith("_password")
      || normalized.endsWith("_assertion")
      || normalized.endsWith("_state")
      || normalized.endsWith("_session")
      || normalized.endsWith("_session_id");
    if (sensitive) redactedUrl.searchParams.set(key, "[REDACTED]");
  }
  pruneRequestLog();
  const redactedRequestUrl = `${redactedUrl.pathname}${redactedUrl.search}`;
  const entry = {
    id: correlationSequence,
    correlationId,
    method: req.method,
    path: url.pathname,
    url: redactedRequestUrl.length <= 4_096 ? redactedRequestUrl : `${redactedUrl.pathname}?query=[TRUNCATED]`,
    queryKeys: [...url.searchParams.keys()].sort(),
    authenticated: /^Bearer\s+/i.test(req.headers.authorization || ""),
    at: new Date().toISOString(),
    recordedAtMs: Date.now(),
  };
  pushBounded(requests, entry, MAX_REQUEST_LOG_ENTRIES);
  const pathHash = createHash("sha256").update(entry.path).digest("hex").slice(0, 12);
  console.log(`[mock-oauth-mcp] ${correlationId} ${entry.method} path=sha256:${pathHash}`);
  return correlationId;
}

function protectedResourceMetadata() {
  if (fault === "bad_resource_metadata") return { resource: `${issuer}/wrong-resource`, authorization_servers: [] };
  return {
    resource,
    authorization_servers: [authorizationIssuer],
    scopes_supported: profile.scopes,
    bearer_methods_supported: ["header"],
  };
}

function authorizationServerMetadata() {
  return {
    issuer: fault === "issuer_mismatch" ? `${authorizationIssuer}/wrong-issuer` : authorizationIssuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    ...(disableDcr ? {} : { registration_endpoint: `${issuer}/register` }),
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    code_challenge_methods_supported: fault === "no_pkce" ? ["plain"] : ["S256"],
    scopes_supported: profile.scopes,
  };
}

function basicClient(req) {
  const header = req.headers.authorization || "";
  const match = header.match(/^Basic\s+(.+)$/i);
  if (!match) return null;
  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator === -1) return { clientId: decoded, clientSecret: "" };
  return { clientId: decoded.slice(0, separator), clientSecret: decoded.slice(separator + 1) };
}

function oauthError(res, status, error, correlationId, description) {
  json(res, status, { error, ...(description ? { error_description: description } : {}) }, correlationId);
}

function safeSecretEqual(actual, expected) {
  const left = Buffer.from(String(actual ?? ""));
  const right = Buffer.from(String(expected ?? ""));
  return left.length === right.length && timingSafeEqual(left, right);
}

async function validRedirectUri(raw) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2_048) return false;
  try {
    const url = new URL(raw);
    if (url.username || url.password || url.hash) return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && await isLoopbackBindHost(url.hostname);
  } catch {
    return false;
  }
}

function parseSupportedScopes(raw) {
  if (typeof raw !== "string" || raw.trim().length === 0 || raw.length > 2_048) return null;
  const requested = [...new Set(raw.trim().split(/\s+/).filter(Boolean))];
  if (requested.length === 0 || requested.length > 32) return null;
  if (requested.some((scope) => !profile.scopes.includes(scope))) return null;
  return profile.scopes.filter((scope) => requested.includes(scope)).join(" ");
}

function tokenClient(req, form, expectedClientId) {
  const basic = basicClient(req);
  const clientId = basic?.clientId || form.client_id || "";
  if (!clientId || clientId !== expectedClientId) return null;
  const client = getLive(clients, clientId);
  if (!client) return null;
  if (client.tokenEndpointAuthMethod === "none") {
    if (basic || form.client_secret !== undefined || form.client_id !== clientId) return null;
  } else if (client.tokenEndpointAuthMethod === "client_secret_post") {
    if (basic || form.client_id !== clientId || !safeSecretEqual(form.client_secret, client.clientSecret)) return null;
  } else if (client.tokenEndpointAuthMethod === "client_secret_basic") {
    if (!basic || !safeSecretEqual(basic.clientSecret, client.clientSecret)) return null;
  } else {
    return null;
  }
  return client;
}

async function authorizationGrant(params, res, correlationId) {
  if (params.get("response_type") !== "code") {
    oauthError(res, 400, "unsupported_response_type", correlationId);
    return null;
  }
  const clientId = params.get("client_id") || "";
  const client = getLive(clients, clientId);
  if (!client) {
    oauthError(res, 400, "invalid_client", correlationId);
    return null;
  }
  const redirectUri = params.get("redirect_uri") || "";
  if (!(await validRedirectUri(redirectUri)) || !client.redirectUris.includes(redirectUri)) {
    oauthError(res, 400, "invalid_request", correlationId, "redirect URI is not registered for this client");
    return null;
  }
  if (params.get("resource") !== resource) {
    oauthError(res, 400, "invalid_target", correlationId, "resource is required and must match this MCP server");
    return null;
  }
  const scope = parseSupportedScopes(params.get("scope"));
  if (!scope) {
    oauthError(res, 400, "invalid_scope", correlationId);
    return null;
  }
  const codeChallenge = params.get("code_challenge") || "";
  if (params.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge)) {
    oauthError(res, 400, "invalid_request", correlationId, "PKCE S256 is required");
    return null;
  }
  const state = params.get("state") || "";
  if (state.length === 0 || state.length > 4_096) {
    oauthError(res, 400, "invalid_request", correlationId, "bounded state is required");
    return null;
  }
  return { clientId, redirectUri, resource, scope, codeChallenge, state };
}

function issueAuthorizationCode(res, grant, correlationId) {
  const code = `mock-code-${randomUUID()}`;
  setBoundedExpiring(codes, code, grant, MAX_CODES, AUTHORIZATION_CODE_TTL_MS);
  const callback = new URL(grant.redirectUri);
  callback.searchParams.set("code", code);
  callback.searchParams.set("state", grant.state);
  res.writeHead(302, responseHeaders(correlationId, { location: callback.toString() }));
  res.end();
}

async function authorize(res, url, correlationId) {
  const grant = await authorizationGrant(url.searchParams, res, correlationId);
  if (!grant) return;
  if (autoApprove && url.searchParams.get("force_consent") !== "1") {
    issueAuthorizationCode(res, grant, correlationId);
    return;
  }

  const approvalTransaction = `mock-approval-${randomUUID()}`;
  setBoundedExpiring(
    approvalTransactions,
    approvalTransaction,
    grant,
    MAX_APPROVAL_TRANSACTIONS,
    APPROVAL_TRANSACTION_TTL_MS,
  );
  const requestedScopes = grant.scope.split(" ");
  const requestedScopesHtml = `<h2>Requested scopes</h2><ul>${requestedScopes.map((scope) => `<li><code>${escapeHtml(scope)}</code></li>`).join("")}</ul>`;
  html(res, 200, `<!doctype html>
<html><head><title>Mock MCP OAuth</title></head>
<body><h1>Mock MCP OAuth</h1><p>Profile: <strong>${escapeHtml(profileName)}</strong>. Synthetic data only.</p>
${requestedScopesHtml}<form method="post" action="/approve">
<input type="hidden" name="approval_transaction" value="${escapeHtml(approvalTransaction)}">
<button>Approve OpenWork</button></form></body></html>`, correlationId);
}

async function approveAuthorization(req, res, correlationId) {
  const form = await readForm(req);
  const grant = takeLive(approvalTransactions, form.approval_transaction);
  if (!grant) {
    oauthError(res, 400, "invalid_request", correlationId, "approval transaction is missing, expired, or already used");
    return;
  }
  issueAuthorizationCode(res, grant, correlationId);
}

async function registerClient(req, res, correlationId) {
  if (disableDcr) {
    json(res, 404, { error: "not_found" }, correlationId);
    return;
  }
  if (fault === "invalid_client") {
    oauthError(res, 400, "invalid_client", correlationId);
    return;
  }
  const body = await readJson(req).catch(() => null);
  const redirectUris = Array.isArray(body?.redirect_uris) ? [...new Set(body.redirect_uris)] : [];
  const tokenEndpointAuthMethod = body?.token_endpoint_auth_method || "none";
  const redirectUriValidity = await Promise.all(redirectUris.map((redirectUri) => validRedirectUri(redirectUri)));
  if (redirectUris.length === 0
    || redirectUris.length > 10
    || redirectUriValidity.some((isValid) => !isValid)
    || !["none", "client_secret_post", "client_secret_basic"].includes(tokenEndpointAuthMethod)
  ) {
    oauthError(res, 400, "invalid_client_metadata", correlationId);
    return;
  }
  const clientId = `mock-client-${randomUUID()}`;
  const clientSecret = tokenEndpointAuthMethod === "none" ? null : `mock-client-secret-${randomUUID()}`;
  const issuedAt = Math.floor(Date.now() / 1000);
  setBoundedExpiring(clients, clientId, {
    clientId,
    clientSecret,
    tokenEndpointAuthMethod,
    redirectUris,
  }, MAX_CLIENTS, CLIENT_TTL_MS);
  json(res, 201, {
    client_id: clientId,
    client_id_issued_at: issuedAt,
    client_id_expires_at: issuedAt + Math.floor(CLIENT_TTL_MS / 1000),
    ...(clientSecret ? {
      client_secret: clientSecret,
      client_secret_expires_at: issuedAt + Math.floor(CLIENT_TTL_MS / 1000),
    } : {}),
    token_endpoint_auth_method: tokenEndpointAuthMethod,
    redirect_uris: redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    scope: profile.scopes.join(" "),
  }, correlationId);
}

function tokenResponse(res, correlationId, grant) {
  const accessToken = `mock-access-${randomUUID()}`;
  const refreshToken = `mock-refresh-${randomUUID()}`;
  setBoundedExpiring(tokens, accessToken, {
    resource: grant.resource,
    audience: grant.audience || audience,
    issuer: grant.issuer || authorizationIssuer,
    tenantId: grant.tenantId === undefined ? profile.tenantId : grant.tenantId,
    scope: grant.scope,
    clientId: grant.clientId,
    subject: "synthetic-user",
  }, MAX_ACCESS_TOKENS, ACCESS_TOKEN_TTL_MS);
  setBoundedExpiring(refreshTokens, refreshToken, {
    resource: grant.resource,
    audience: grant.audience || audience,
    issuer: grant.issuer || authorizationIssuer,
    tenantId: grant.tenantId === undefined ? profile.tenantId : grant.tenantId,
    scope: grant.scope,
    clientId: grant.clientId,
    subject: "synthetic-user",
  }, MAX_REFRESH_TOKENS, REFRESH_TOKEN_TTL_MS);
  json(res, 200, {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "Bearer",
    expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    scope: grant.scope,
  }, correlationId);
}

async function issueToken(req, res, correlationId) {
  const form = await readForm(req);
  if (fault === "invalid_client") {
    oauthError(res, 400, "invalid_client", correlationId);
    return;
  }
  if (fault === "invalid_grant") {
    oauthError(res, 400, "invalid_grant", correlationId);
    return;
  }

  const grantType = form.grant_type;
  if (grantType === "refresh_token") {
    const grant = getLive(refreshTokens, form.refresh_token);
    if (!grant) {
      oauthError(res, 400, "invalid_grant", correlationId);
      return;
    }
    if (!tokenClient(req, form, grant.clientId)) {
      oauthError(res, 400, "invalid_client", correlationId);
      return;
    }
    if (form.resource !== grant.resource
      || grant.resource !== resource
      || grant.audience !== audience
      || grant.issuer !== authorizationIssuer
      || grant.tenantId !== profile.tenantId
    ) {
      oauthError(res, 400, "invalid_target", correlationId);
      return;
    }
    const refreshScope = form.scope === undefined ? grant.scope : parseSupportedScopes(form.scope);
    const originalScopes = new Set(grant.scope.split(" "));
    if (!refreshScope || refreshScope.split(" ").some((scope) => !originalScopes.has(scope))) {
      oauthError(res, 400, "invalid_scope", correlationId);
      return;
    }
    refreshTokens.delete(form.refresh_token);
    tokenResponse(res, correlationId, { ...grant, scope: refreshScope });
    return;
  }
  if (grantType !== "authorization_code") {
    oauthError(res, 400, "unsupported_grant_type", correlationId);
    return;
  }

  const grant = takeLive(codes, form.code);
  if (!grant) {
    oauthError(res, 400, "invalid_grant", correlationId);
    return;
  }
  if (!tokenClient(req, form, grant.clientId)) {
    oauthError(res, 400, "invalid_client", correlationId);
    return;
  }
  if (form.redirect_uri !== grant.redirectUri) {
    oauthError(res, 400, "invalid_grant", correlationId, "redirect URI mismatch");
    return;
  }
  if (form.resource !== grant.resource || grant.resource !== resource) {
    oauthError(res, 400, "invalid_target", correlationId);
    return;
  }
  if (form.scope !== undefined && form.scope !== grant.scope) {
    oauthError(res, 400, "invalid_scope", correlationId);
    return;
  }
  const verifier = form.code_verifier || "";
  if (verifier.length < 43
    || verifier.length > 128
    || createHash("sha256").update(verifier).digest("base64url") !== grant.codeChallenge
  ) {
    oauthError(res, 400, "invalid_grant", correlationId, "PKCE verification failed");
    return;
  }
  tokenResponse(res, correlationId, {
    ...grant,
    audience: fault === "wrong_audience" ? `${audience}/wrong-audience` : audience,
  });
}

function authorizedToken(req) {
  const match = (req.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const diagnosticOverrides = {
    "mock-wrong-tenant-token": { tenantId: "wrong-mock-tenant" },
    "mock-wrong-issuer-token": { issuer: `${authorizationIssuer}/wrong` },
    "mock-wrong-audience-token": { audience: `${audience}/wrong` },
    "mock-wrong-scope-token": { scope: "mock.invalid.scope" },
  }[match[1]];
  const token = getLive(tokens, match[1]) || (diagnosticOverrides ? {
    resource,
    audience,
    issuer: authorizationIssuer,
    tenantId: profile.tenantId,
    scope: profile.scopes.join(" "),
    clientId: "diagnostic-negative-fixture",
    subject: "synthetic-user",
    ...diagnosticOverrides,
  } : null);
  const grantedScopes = new Set(token?.scope?.split(" ") || []);
  return token?.resource === resource
    && token?.audience === audience
    && token?.issuer === authorizationIssuer
    && token?.tenantId === profile.tenantId
    && profile.scopes.every((scope) => grantedScopes.has(scope))
    ? { value: match[1], ...token }
    : null;
}

function protocolError(id, code, message, data) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data ? { data } : {}) } };
}

function providerError(message, category, providerStatus, providerCode, correlationId, retryAfterSeconds) {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    structuredContent: {
      category,
      providerStatus,
      providerCode,
      requestId: correlationId,
      ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
    },
  };
}

function selectedProtocol(requested) {
  if (fault === "unsupported_version") return "2099-01-01";
  return profile.protocols.includes(requested) ? requested : profile.protocols[0];
}

function listTools(params = {}) {
  let catalog = fault === "empty_tool_catalog" ? [] : profile.tools;
  if (fault === "oversized_catalog_response") {
    catalog = [{ ...profile.tools[0], description: "x".repeat(600 * 1024) }];
  } else if (fault === "deep_tool_schema") {
    let nested = { type: "string" };
    for (let depth = 0; depth < 24; depth += 1) nested = { type: "object", properties: { nested } };
    catalog = [{ ...profile.tools[0], inputSchema: nested }];
  } else if (fault === "oversized_schema_string") {
    catalog = [{ ...profile.tools[0], inputSchema: { ...profile.tools[0].inputSchema, description: "s".repeat(9 * 1024) } }];
  } else if (fault === "oversized_tool_name") {
    catalog = [{ ...profile.tools[0], name: `oversized_${"n".repeat(300)}` }];
  } else if (fault === "too_many_page_tools") {
    catalog = Array.from({ length: 201 }, (_, index) => ({ ...profile.tools[0], name: `bounded_tool_${index}` }));
  } else if (fault === "too_many_total_tools") {
    catalog = Array.from({ length: 1_001 }, (_, index) => ({ ...profile.tools[0], name: `total_tool_${index}` }));
  } else if (fault === "too_many_pages") {
    catalog = Array.from({ length: 26 }, (_, index) => ({ ...profile.tools[0], name: `paged_tool_${index}` }));
  } else if (fault === "total_response_budget") {
    catalog = Array.from({ length: 6 }, (_, index) => ({ ...profile.tools[0], name: `budget_tool_${index}` }));
  }
  const page = typeof params.cursor === "string" && params.cursor.startsWith("page:")
    ? Number(params.cursor.slice("page:".length))
    : 0;
  const safePage = Number.isInteger(page) && page >= 0 ? page : 0;
  const pageSize = fault === "too_many_page_tools"
    ? 201
    : fault === "too_many_total_tools"
      ? 200
      : fault === "too_many_pages" || fault === "total_response_budget" ? 1 : profile.pageSize;
  const start = safePage * pageSize;
  const tools = catalog.slice(start, start + pageSize);
  const hasNext = start + pageSize < catalog.length;
  const nextCursor = fault === "oversized_cursor"
    ? `cursor:${"c".repeat(9 * 1024)}`
    : fault === "cursor_loop" && catalog.length > 0
      ? process.env.MCP_MOCK_CURSOR_VALUE || `page:${safePage}`
    : hasNext ? `page:${safePage + 1}` : undefined;
  return {
    tools,
    ...(nextCursor ? { nextCursor } : {}),
    ...(fault === "total_response_budget" ? { diagnosticPadding: "p".repeat(450 * 1024) } : {}),
  };
}

function requiresApproval(name) {
  return [
    "create_entity",
    "update_entity",
    "delete_entity",
    "do_action",
    "mcp_MailTools_graph_mail_createMessage",
    "mcp_MailTools_graph_mail_deleteMessage",
    "mcp_MailTools_graph_mail_reply",
    "mcp_MailTools_graph_mail_replyAll",
    "mcp_MailTools_graph_mail_sendDraft",
    "mcp_MailTools_graph_mail_sendMail",
    "mcp_MailTools_graph_mail_updateMessage",
  ].includes(name);
}

function callTool(message, correlationId) {
  const name = message.params?.name;
  const toolDefinition = profile.tools.find((entry) => entry.name === name);
  if (!toolDefinition) return { protocolError: protocolError(message.id, -32602, `Unknown tool: ${String(name)}`) };
  if (fault === "provider_denied") {
    return { result: providerError("Synthetic provider denied the operation.", "provider_policy", 403, "insufficient_privilege", correlationId) };
  }
  if (fault === "provider_throttled") {
    return { result: providerError("Synthetic provider throttled the operation.", "provider_api", 429, "rate_limited", correlationId, 2) };
  }
  const toolArgs = message.params?.arguments || {};
  const explicitMockApproval = message.params?._meta?.openworkMockApproval === true || toolArgs.approved === true;
  if (requiresApproval(name) && !explicitMockApproval) {
    return { result: providerError("Explicit mock approval is required.", "provider_policy", 403, "approval_required", correlationId) };
  }
  if (requiresApproval(name)) {
    const idempotencySource = typeof message.params?._meta?.idempotencyKey === "string"
      ? message.params._meta.idempotencyKey
      : typeof toolArgs.idempotency_key === "string" ? toolArgs.idempotency_key : `${name}:${JSON.stringify(toolArgs)}`;
    const idempotencyKey = createHash("sha256").update(idempotencySource).digest("hex");
    const prior = getLive(operationLedger, idempotencyKey);
    if (prior) return { result: prior.result };
    const result = {
      content: [{ type: "text", text: `Synthetic ${name} recorded; no external system was changed.` }],
      structuredContent: { operationId: `mock-operation-${operationLedger.size + 1}`, synthetic: true, correlationId },
    };
    setBoundedExpiring(operationLedger, idempotencyKey, { result }, MAX_LEDGER_ENTRIES, LEDGER_TTL_MS);
    return { result };
  }

  if (profileName === "servicenow") {
    return { result: { content: [{ type: "text", text: JSON.stringify(syntheticIncident) }], structuredContent: { incidents: [syntheticIncident], correlationId } } };
  }
  if (profileName === "microsoft-enterprise") {
    return { result: { content: [{ type: "text", text: JSON.stringify(syntheticUser) }], structuredContent: { user: syntheticUser, correlationId } } };
  }
  if (profileName === "agent365-mail") {
    return { result: { content: [{ type: "text", text: "Synthetic message from sender@example.invalid" }], structuredContent: { messages: [{ id: "mock-message-1", subject: "Synthetic status" }], correlationId } } };
  }
  if (profileName === "workiq") {
    const selectedPath = toolArgs.entityUrls?.[0]
      || toolArgs.parentUrl
      || toolArgs.entityUrl
      || toolArgs.actionUrl
      || toolArgs.functionUrl
      || toolArgs.path
      || "/me";
    return { result: { content: [{ type: "text", text: "Synthetic Work IQ result" }], structuredContent: { path: selectedPath, entity: syntheticUser, correlationId } } };
  }
  return { result: { content: [{ type: "text", text: String(toolArgs.text ?? "mock oauth mcp ok") }], structuredContent: { correlationId } } };
}

function mcpResult(message, correlationId, token) {
  if (message.method === "initialize") {
    const requested = message.params?.protocolVersion;
    const protocolVersion = selectedProtocol(requested);
    const sessionId = process.env.MCP_MOCK_SESSION_ID || randomUUID();
    setBoundedExpiring(sessions, sessionId, {
      protocolVersion,
      token: token.value,
      initialized: false,
      expired: false,
    }, MAX_SESSIONS, SESSION_TTL_MS);
    return {
      response: {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: fault === "malformed_initialize" ? 42 : protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: `openwork-enterprise-mock-${profileName}`, version: "1.0.0" },
          instructions: "Synthetic diagnostic server. Never treat fixtures as customer data.",
        },
      },
      sessionId,
    };
  }
  if (message.method === "tools/list") {
    return { response: { jsonrpc: "2.0", id: message.id, result: listTools(message.params) } };
  }
  if (message.method === "tools/call") {
    const called = callTool(message, correlationId);
    return { response: called.protocolError || { jsonrpc: "2.0", id: message.id, result: called.result } };
  }
  return { response: protocolError(message.id, -32601, `Method not found: ${String(message.method)}`) };
}

function sendMcpResponse(res, response, correlationId, sessionId) {
  const headers = sessionId ? { "mcp-session-id": sessionId } : {};
  if (fault === "wrong_content_type") {
    html(res, 200, "<html><body>synthetic login interception</body></html>", correlationId, headers);
    return;
  }
  if (responseMode === "sse" || fault === "open_sse_after_result") {
    const serialized = JSON.stringify(response);
    res.writeHead(200, responseHeaders(correlationId, { "content-type": "text/event-stream", ...headers }));
    if (fault === "broken_sse") {
      res.end("event: message\ndata: {malformed-json\n\n");
      return;
    }
    res.write(`event: message\nid: ${correlationId}\ndata: ${serialized}\n\n`);
    if (fault !== "open_sse_after_result") res.end();
    return;
  }
  json(res, 200, response, correlationId, headers);
}

async function handleMcp(req, res, correlationId) {
  const token = authMode === "none"
    ? { value: "anonymous", resource, scope: profile.scopes.join(" "), subject: "synthetic-anonymous" }
    : authorizedToken(req);
  if (!token) {
    const headers = fault === "missing_auth_challenge"
      ? {}
      : { "www-authenticate": `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource${profile.endpoint}", scope="${profile.scopes.join(" ")}"` };
    json(res, 401, { error: "missing_mcp_token" }, correlationId, headers);
    return;
  }

  if (req.method === "GET") {
    json(res, 405, { error: "method_not_allowed" }, correlationId);
    return;
  }
  if (req.method === "DELETE") {
    const sessionId = req.headers["mcp-session-id"];
    const session = typeof sessionId === "string" ? getLive(sessions, sessionId) : null;
    if (!session || session.token !== token.value) {
      json(res, 404, { error: "session_not_found" }, correlationId);
      return;
    }
    if (fault === "hung_delete") {
      await waitForDelayOrDisconnect(req, res, null);
      return;
    }
    sessions.delete(sessionId);
    json(res, 200, { ok: true }, correlationId);
    return;
  }
  if (req.method !== "POST") {
    json(res, 405, { error: "method_not_allowed" }, correlationId);
    return;
  }

  const body = await readJson(req).catch(() => null);
  if (!body || typeof body !== "object") {
    sendMcpResponse(res, protocolError(null, -32700, "Parse error"), correlationId);
    return;
  }
  const messages = Array.isArray(body) ? body : [body];
  const isInitialize = messages.length === 1 && messages[0]?.method === "initialize";
  let session;
  let sessionId;
  if (!isInitialize) {
    sessionId = req.headers["mcp-session-id"];
    if (typeof sessionId !== "string") {
      json(res, 400, { error: "missing_session" }, correlationId);
      return;
    }
    session = getLive(sessions, sessionId);
    if (!session || session.token !== token.value || session.expired) {
      json(res, 404, { error: "session_not_found" }, correlationId);
      return;
    }
    const protocolHeader = req.headers["mcp-protocol-version"];
    if (protocolHeader !== session.protocolVersion) {
      json(res, 400, { error: "invalid_protocol_version", expected: session.protocolVersion }, correlationId);
      return;
    }
  }

  if (messages.every((message) => message?.id === undefined)) {
    if (messages.some((message) => message?.method === "notifications/initialized")) {
      if (fault === "notification_rejected") {
        json(res, 400, { error: "initialized_notification_rejected" }, correlationId);
        return;
      }
      if (session) {
        session.initialized = true;
        if (fault === "expired_session") session.expired = true;
      }
    }
    res.writeHead(202, responseHeaders(correlationId));
    res.end();
    return;
  }

  if (!isInitialize && !session?.initialized) {
    sendMcpResponse(res, protocolError(messages[0]?.id, -32002, "Session has not received notifications/initialized"), correlationId);
    return;
  }

  if (fault === "slow_tools_list" && messages.some((message) => message?.method === "tools/list")) {
    const requestedDelay = Number(process.env.MCP_MOCK_SLOW_RESPONSE_MS || 45_000);
    const delayMs = Number.isFinite(requestedDelay) ? Math.max(0, Math.min(requestedDelay, 60_000)) : 45_000;
    const completed = await waitForDelayOrDisconnect(req, res, delayMs);
    if (!completed) return;
  }

  const responses = messages.flatMap((message) => {
    if (!message || typeof message !== "object" || message.id === undefined) return [];
    const result = mcpResult(message, correlationId, token);
    if (result.sessionId) sessionId = result.sessionId;
    return [result.response];
  });
  sendMcpResponse(res, Array.isArray(body) ? responses : responses[0], correlationId, isInitialize ? sessionId : undefined);
}

function protectedMetadataPaths() {
  return new Set([
    "/.well-known/oauth-protected-resource",
    `/.well-known/oauth-protected-resource${profile.endpoint}`,
    `${profile.endpoint}/.well-known/oauth-protected-resource`,
  ]);
}

function authorizationServerMetadataPaths() {
  const paths = new Set([
    "/.well-known/oauth-authorization-server",
    "/.well-known/openid-configuration",
    `/.well-known/oauth-authorization-server${profile.endpoint}`,
  ]);
  if (authorizationIssuer !== issuer) {
    const issuerPath = new URL(authorizationIssuer).pathname.replace(/\/$/, "");
    paths.add(`/.well-known/oauth-authorization-server${issuerPath}`);
    paths.add(`${issuerPath}/.well-known/openid-configuration`);
  }
  return paths;
}

function hasDiagnosticsAccess(req) {
  const supplied = req.headers["x-mock-diagnostics-key"];
  return diagnosticsKey !== null && typeof supplied === "string" && safeSecretEqual(supplied, diagnosticsKey);
}

function pruneAllState() {
  pruneExpiringMap(clients);
  pruneExpiringMap(approvalTransactions);
  pruneExpiringMap(codes);
  pruneExpiringMap(tokens);
  pruneExpiringMap(refreshTokens);
  pruneExpiringMap(sessions);
  pruneExpiringMap(operationLedger);
  pruneRequestLog();
  pruneDraftLog();
}

function diagnosticStateCounts() {
  pruneAllState();
  for (const state of activeRequestStates) {
    if (state.req.destroyed || state.res.destroyed || state.res.writableEnded || state.res.socket?.destroyed) {
      activeRequestStates.delete(state);
    }
  }
  return {
    clients: clients.size,
    approvalTransactions: approvalTransactions.size,
    codes: codes.size,
    accessTokens: tokens.size,
    refreshTokens: refreshTokens.size,
    sessions: sessions.size,
    requests: requests.length,
    drafts: drafts.length,
    ledger: operationLedger.size,
    activeRequests: Math.max(0, activeRequestStates.size - 1),
  };
}

const server = http.createServer(async (req, res) => {
  const activeRequestState = { req, res };
  activeRequestStates.add(activeRequestState);
  let requestSettled = false;
  const settleRequest = () => {
    if (requestSettled) return;
    requestSettled = true;
    activeRequestStates.delete(activeRequestState);
  };
  req.once("aborted", settleRequest);
  res.once("finish", settleRequest);
  res.once("close", settleRequest);
  res.socket?.once("close", settleRequest);
  let correlationId = `mock-${profileName}-unassigned`;
  try {
    const url = new URL(req.url || "/", issuer);
    correlationId = record(req, url);

    if (req.method === "OPTIONS") {
      res.writeHead(204, responseHeaders(correlationId));
      res.end();
      return;
    }
    if (url.pathname === "/__fault/internal" && fault === "internal_error") {
      throw new Error("sensitive internal mock detail");
    }
    if (url.pathname === "/health") {
      pruneAllState();
      json(res, 200, {
        ok: true,
        issuer,
        resource,
        profile: profileName,
        endpoint: profile.endpoint,
        protocols: profile.protocols,
        responseMode,
        authMode,
        fault,
        advertisedFaults: ADVERTISED_FAULTS,
        autoApprove,
        disableDcr,
        fixtureContract: {
          verifiedAt: FIXTURE_VERIFIED_AT,
          registrationMode: profile.registrationMode,
          mockRegistrationMode: disableDcr ? "pre_registered" : "dynamic",
          identityProvider: profile.identityProvider,
          tenantId: profile.tenantId,
          authorizationIssuer,
          resource,
          audience,
          scopes: profile.scopes,
          documentation: profile.documentation,
          preview: profileName === "workiq" || profileName === "agent365-mail" || profileName === "microsoft-enterprise",
        },
        requests: requests.length,
        requestLogEnabled: diagnosticsKey !== null,
      }, correlationId);
      return;
    }
    if (url.pathname === "/requests") {
      if (!hasDiagnosticsAccess(req)) {
        json(res, 404, { error: "not_found" }, correlationId);
        return;
      }
      pruneRequestLog();
      json(res, 200, {
        requests: requests.map(({ recordedAtMs: _recordedAtMs, ...entry }) => entry),
      }, correlationId);
      return;
    }
    if (url.pathname === "/__diagnostics/state") {
      if (!hasDiagnosticsAccess(req)) {
        json(res, 404, { error: "not_found" }, correlationId);
        return;
      }
      json(res, 200, { counts: diagnosticStateCounts() }, correlationId);
      return;
    }
    if (protectedMetadataPaths().has(url.pathname)) {
      json(res, 200, protectedResourceMetadata(), correlationId);
      return;
    }
    if (authorizationServerMetadataPaths().has(url.pathname)) {
      json(res, 200, authorizationServerMetadata(), correlationId);
      return;
    }
    if (url.pathname === "/register" && req.method === "POST") {
      await registerClient(req, res, correlationId);
      return;
    }
    if (url.pathname === "/authorize" && req.method === "GET") {
      await authorize(res, url, correlationId);
      return;
    }
    if (url.pathname === "/approve" && req.method === "POST") {
      await approveAuthorization(req, res, correlationId);
      return;
    }
    if (url.pathname === "/token" && req.method === "POST") {
      await issueToken(req, res, correlationId);
      return;
    }
    if (url.pathname === profile.endpoint) {
      await handleMcp(req, res, correlationId);
      return;
    }

    // Kept for the existing Google Workspace draft proof that shares this mock.
    if (url.pathname === "/gmail/v1/users/me/drafts" && req.method === "POST") {
      if (!authorizedToken(req)) {
        json(res, 401, { error: { code: 401, message: "Invalid Credentials" } }, correlationId);
        return;
      }
      const body = await readJson(req).catch(() => ({}));
      const raw = typeof body?.message?.raw === "string" ? body.message.raw : "";
      pruneDraftLog();
      pushBounded(drafts, {
        rawBytes: Buffer.byteLength(raw, "utf8"),
        rawSha256: createHash("sha256").update(raw).digest("hex"),
        at: new Date().toISOString(),
        recordedAtMs: Date.now(),
      }, MAX_DRAFTS);
      json(res, 200, {
        id: `draft-${randomUUID()}`,
        message: { id: `msg-${randomUUID()}`, threadId: `thread-${randomUUID()}` },
      }, correlationId);
      return;
    }
    if (url.pathname === "/gmail/drafts-log") {
      if (!hasDiagnosticsAccess(req)) {
        json(res, 404, { error: "not_found" }, correlationId);
        return;
      }
      pruneDraftLog();
      json(res, 200, {
        drafts: drafts.map(({ recordedAtMs: _recordedAtMs, ...entry }) => entry),
      }, correlationId);
      return;
    }
    json(res, 404, { error: "not_found" }, correlationId);
  } catch (error) {
    console.error(`[mock-oauth-mcp] ${correlationId} internal_mock_error ${error instanceof Error ? error.name : "UnknownError"}`);
    if (!res.headersSent && !res.destroyed) json(res, 500, { error: "internal_mock_error", correlationId }, correlationId);
    else if (!res.destroyed) res.destroy();
  }
});

server.listen(port, host, () => {
  console.log(`[mock-oauth-mcp] listening on ${issuer}`);
  console.log(`[mock-oauth-mcp] profile: ${profileName}`);
  console.log(`[mock-oauth-mcp] MCP URL: ${resource}`);
  console.log(`[mock-oauth-mcp] protocols: ${profile.protocols.join(", ")}; response: ${responseMode}; fault: ${fault}`);
  console.log(`[mock-oauth-mcp] synthetic fixtures only; no outbound network calls`);
  console.log(`[mock-oauth-mcp] set AUTO_APPROVE=0 to require an approval click`);
});
