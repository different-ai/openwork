import { createServer } from "node:http";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";
import { denApiFetch, openAdminConnections, openYourConnections, signInApi, signInViaBrowser } from "./lib/den-web.mjs";

// Narration is loaded from the approved script (evals/voiceovers/disconnect-cloud-connections.md).
// The runner fails this flow if the narration drifts from that script.
const vo = await loadVoiceoverParagraphs("disconnect-cloud-connections");

const ADMIN_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const ADMIN_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const MEMBER_EMAIL = process.env.OPENWORK_EVAL_MEMBER_EMAIL?.trim() || ADMIN_EMAIL;
const MEMBER_PASSWORD = process.env.OPENWORK_EVAL_MEMBER_PASSWORD?.trim() || ADMIN_PASSWORD;
const MOCK_OAUTH_MCP_URL = (process.env.MOCK_OAUTH_MCP_URL ?? "http://127.0.0.1:3978").trim().replace(/\/+$/, "");
const MOCK_PORT = Number(process.env.OPENWORK_EVAL_DISCONNECT_MCP_PORT ?? 4552);
const MOCK_ORIGIN = `http://127.0.0.1:${MOCK_PORT}`;
const RUN_TAG = Date.now().toString(36);
const API_KEY_NAME = `Disconnect API key ${RUN_TAG}`;
const MEMBER_NAME = `Disconnect member MCP ${RUN_TAG}`;
const SHARED_OAUTH_NAME = `Disconnect shared OAuth ${RUN_TAG}`;

const state = {
  adminSession: null,
  memberSession: null,
  orgId: null,
  apiKeyConnectionId: null,
  memberConnectionId: null,
  sharedOAuthConnectionId: null,
};

let mockServer = null;

function requireState(value, label) {
  if (typeof value === "string" && value.trim()) return value;
  throw new Error(`${label} was not prepared.`);
}

function authHeaders(token = requireState(state.adminSession, "admin session")) {
  const headers = { authorization: `Bearer ${token}` };
  if (state.orgId) {
    headers["x-openwork-org-id"] = state.orgId;
    headers["x-openwork-legacy-org-id"] = state.orgId;
  }
  return headers;
}

async function orgApi(ctx, path, init = {}, token) {
  const response = await denApiFetch(path, {
    ...init,
    headers: { ...authHeaders(token), ...(init.headers ?? {}) },
  });
  ctx.assert(response.response.ok || response.response.status === 204, `${path} failed: ${response.response.status} ${JSON.stringify(response.body).slice(0, 500)}`);
  return response.body;
}

function jsonResponse(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readRequestBody(request) {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  return raw.trim() ? JSON.parse(raw) : {};
}

async function startApiKeyMock(ctx) {
  if (mockServer) return;
  mockServer = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", MOCK_ORIGIN);
    if (url.pathname === "/health") return jsonResponse(response, 200, { ok: true });
    if (!url.pathname.endsWith("mcp")) return jsonResponse(response, 404, { error: "not_found" });
    const authorization = request.headers.authorization ?? null;
    const payload = await readRequestBody(request).catch(() => ({}));
    if (!authorization?.startsWith("Bearer ")) return jsonResponse(response, 401, { error: "missing_api_key" });
    if (payload?.id === undefined) {
      response.writeHead(202);
      response.end();
      return;
    }
    if (payload.method === "initialize") {
      return jsonResponse(response, 200, {
        jsonrpc: "2.0",
        id: payload.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "disconnect-cloud-connections-proof", version: "1.0.0" },
        },
      });
    }
    if (payload.method === "tools/list") {
      return jsonResponse(response, 200, { jsonrpc: "2.0", id: payload.id, result: { tools: [] } });
    }
    return jsonResponse(response, 200, { jsonrpc: "2.0", id: payload.id, result: {} });
  });
  await new Promise((resolve, reject) => {
    mockServer.once("error", reject);
    mockServer.listen(MOCK_PORT, "127.0.0.1", resolve);
  });
  mockServer.unref();
  const health = await fetch(`${MOCK_ORIGIN}/health`, { signal: AbortSignal.timeout(2_000) });
  ctx.assert(health.ok, "The local disconnect MCP mock did not become healthy.");
}

async function ensureAdminContext(ctx) {
  state.adminSession = await signInApi(ADMIN_EMAIL, ADMIN_PASSWORD);
  ctx.assert(Boolean(state.adminSession), `Den API sign-in failed for ${ADMIN_EMAIL}.`);
  const listed = await denApiFetch("/v1/me/orgs", { headers: { authorization: `Bearer ${state.adminSession}` } });
  ctx.assert(listed.response.ok, `Could not list admin organizations: ${listed.response.status}`);
  const orgs = Array.isArray(listed.body?.orgs) ? listed.body.orgs : [];
  const selected = orgs.find((org) => String(org.name ?? "").includes("Acme Robotics"))
    ?? orgs.find((org) => ["owner", "admin"].includes(String(org.role ?? "").toLowerCase()))
    ?? orgs[0];
  ctx.assert(selected && typeof selected.id === "string", `No organization found for ${ADMIN_EMAIL}.`);
  state.orgId = selected.id;
  await orgApi(ctx, "/v1/me/active-organization", { method: "POST", body: JSON.stringify({ organizationId: state.orgId }) });
}

async function ensureMemberContext(ctx) {
  state.memberSession = await signInApi(MEMBER_EMAIL, MEMBER_PASSWORD);
  ctx.assert(Boolean(state.memberSession), `Member sign-in failed for ${MEMBER_EMAIL}. Set OPENWORK_EVAL_MEMBER_EMAIL/PASSWORD to an existing member or omit them to reuse the admin account.`);
  await orgApi(ctx, "/v1/me/active-organization", { method: "POST", body: JSON.stringify({ organizationId: requireState(state.orgId, "organization id") }) }, state.memberSession);
}

async function cleanupNamedConnections(ctx) {
  const listed = await orgApi(ctx, "/v1/mcp-connections?scope=manageable");
  for (const connection of listed.connections ?? []) {
    if (![API_KEY_NAME, MEMBER_NAME, SHARED_OAUTH_NAME].includes(connection.name)) continue;
    await denApiFetch(`/v1/mcp-connections/${connection.id}`, { method: "DELETE", headers: authHeaders() });
  }
}

async function seedApiKeyConnection(ctx) {
  if (state.apiKeyConnectionId) return;
  const created = await orgApi(ctx, "/v1/mcp-connections", {
    method: "POST",
    body: JSON.stringify({
      name: API_KEY_NAME,
      url: `${MOCK_ORIGIN}/apikey-mcp`,
      authType: "apikey",
      credentialMode: "shared",
      apiKey: `fraimz-api-key-${RUN_TAG}`,
      access: { orgWide: true, memberIds: [], teamIds: [] },
    }),
  });
  state.apiKeyConnectionId = created.id ?? null;
  ctx.assert(Boolean(state.apiKeyConnectionId), "API-key connection creation did not return an id.");
}

async function createOAuthConnection(ctx, name, credentialMode) {
  const created = await orgApi(ctx, "/v1/mcp-connections", {
    method: "POST",
    body: JSON.stringify({
      name,
      url: `${MOCK_OAUTH_MCP_URL}/mcp`,
      authType: "oauth",
      credentialMode,
      access: { orgWide: true, memberIds: [], teamIds: [] },
    }),
  });
  ctx.assert(typeof created.id === "string", `${name} creation did not return an id.`);
  return created.id;
}

async function completeOAuth(ctx, connectionId, token) {
  const start = await orgApi(ctx, `/v1/mcp-connections/${connectionId}/connect/start`, {}, token);
  ctx.assert(start.status === "needs_auth" && typeof start.authorizeUrl === "string", `OAuth did not return an authorize URL: ${JSON.stringify(start).slice(0, 300)}`);
  const authorizeResponse = await fetch(start.authorizeUrl, { redirect: "manual" });
  const callbackUrl = authorizeResponse.headers.get("location");
  ctx.assert(Boolean(callbackUrl), "OAuth authorize did not redirect to the callback.");
  const callback = await fetch(callbackUrl);
  ctx.assert(callback.ok, `OAuth callback failed: ${callback.status}`);
}

async function seedMemberConnection(ctx) {
  const health = await fetch(`${MOCK_OAUTH_MCP_URL}/health`).catch(() => null);
  ctx.assert(Boolean(health?.ok), `Mock OAuth MCP server not reachable at ${MOCK_OAUTH_MCP_URL}.`);
  if (!state.memberConnectionId) state.memberConnectionId = await createOAuthConnection(ctx, MEMBER_NAME, "per_member");
  const connection = await usableConnection(ctx, requireState(state.memberConnectionId, "member connection id"));
  if (!connection.connectedForMe) {
    await completeOAuth(ctx, requireState(state.memberConnectionId, "member connection id"), requireState(state.memberSession, "member session"));
  }
}

async function seedSharedOAuthConnection(ctx) {
  const health = await fetch(`${MOCK_OAUTH_MCP_URL}/health`).catch(() => null);
  ctx.assert(Boolean(health?.ok), `Mock OAuth MCP server not reachable at ${MOCK_OAUTH_MCP_URL}.`);
  if (!state.sharedOAuthConnectionId) state.sharedOAuthConnectionId = await createOAuthConnection(ctx, SHARED_OAUTH_NAME, "shared");
  const connection = await manageableConnection(ctx, requireState(state.sharedOAuthConnectionId, "shared OAuth connection id"));
  if (!connection.connected) {
    await completeOAuth(ctx, requireState(state.sharedOAuthConnectionId, "shared OAuth connection id"), requireState(state.adminSession, "admin session"));
  }
}

async function setBrowserActiveOrganization(ctx) {
  await ctx.eval(`fetch('/api/den/v1/me/active-organization', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ organizationId: ${JSON.stringify(requireState(state.orgId, "organization id"))} }),
  }).then((response) => response.ok)`, { awaitPromise: true });
}

async function rowTextByName(ctx, name, connectionId) {
  return ctx.eval(`(() => {
    const row = document.querySelector('[data-testid="mcp-connection-row-${connectionId}"]');
    if (row) return row.innerText ?? '';
    const target = ${JSON.stringify(name)};
    const rows = [...document.querySelectorAll('[data-testid^="mcp-connection-row-"]')].filter((node) => (node.innerText ?? '').includes(target));
    return rows[0]?.innerText ?? '';
  })()`);
}

async function clickConnectionAction(ctx, connectionId, action) {
  const clicked = await ctx.eval(`(() => {
    const button = document.querySelector('[data-testid="${action}-mcp-connection-${connectionId}"]');
    button?.click();
    return Boolean(button);
  })()`);
  ctx.assert(clicked, `Could not click ${action} for connection ${connectionId}.`);
}

async function manageableConnection(ctx, connectionId) {
  const listed = await orgApi(ctx, "/v1/mcp-connections?scope=manageable");
  const connection = (listed.connections ?? []).find((entry) => entry.id === connectionId);
  ctx.assert(Boolean(connection), `Manageable list did not include ${connectionId}.`);
  return connection;
}

async function usableConnection(ctx, connectionId) {
  const listed = await orgApi(ctx, "/v1/mcp-connections?scope=usable", {}, requireState(state.memberSession, "member session"));
  const connection = (listed.connections ?? []).find((entry) => entry.id === connectionId);
  ctx.assert(Boolean(connection), `Usable list did not include ${connectionId}.`);
  return connection;
}

async function waitForUsableConnectedForMe(ctx, connectionId, connectedForMe) {
  const deadline = Date.now() + 30_000;
  let connection = await usableConnection(ctx, connectionId);
  while (connection.connectedForMe !== connectedForMe && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    connection = await usableConnection(ctx, connectionId);
  }
  ctx.assert(connection.connectedForMe === connectedForMe, `Usable connection ${connectionId} connectedForMe remained ${connection.connectedForMe}.`);
  return connection;
}

export default {
  id: "disconnect-cloud-connections",
  title: "Cloud connector disconnect signs accounts out without deleting setup",
  kind: "user-facing",
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_WEB_URL"],
  steps: [
    {
      name: "Frame 1",
      run: async (ctx) => {
        await ctx.prove("Admins see connected external MCP rows with creator attribution", {
          voiceover: vo[0],
          action: async () => {
            await ensureAdminContext(ctx);
            await cleanupNamedConnections(ctx);
            await seedSharedOAuthConnection(ctx);
            await signInViaBrowser(ctx, ADMIN_EMAIL, ADMIN_PASSWORD);
            await setBrowserActiveOrganization(ctx);
            await openAdminConnections(ctx);
            await ctx.waitForText(SHARED_OAUTH_NAME, { timeoutMs: 30_000 });
          },
          assert: async () => {
            const rowText = await rowTextByName(ctx, SHARED_OAUTH_NAME, requireState(state.sharedOAuthConnectionId, "shared OAuth connection id"));
            ctx.assert(rowText.includes("Connected"), `Shared OAuth row was not connected: ${rowText}`);
            ctx.assert(rowText.includes("Added by"), `Shared OAuth row did not show creator attribution: ${rowText}`);
            const connection = await manageableConnection(ctx, requireState(state.sharedOAuthConnectionId, "shared OAuth connection id"));
            ctx.assert(typeof connection.createdByName === "string" && connection.createdByName.length > 0, `API did not return createdByName: ${JSON.stringify(connection)}`);
          },
          screenshot: { name: "admin-connections-creator", requireText: [SHARED_OAUTH_NAME, "Added by", "Connected"] },
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await ctx.prove("A connected row offers Disconnect separately from Remove", {
          voiceover: vo[1],
          action: async () => {
            await openAdminConnections(ctx);
            await ctx.waitForText(SHARED_OAUTH_NAME, { timeoutMs: 30_000 });
          },
          assert: async () => {
            const rowText = await rowTextByName(ctx, SHARED_OAUTH_NAME, requireState(state.sharedOAuthConnectionId, "shared OAuth connection id"));
            ctx.assert(rowText.includes("Disconnect"), `Disconnect action missing: ${rowText}`);
            ctx.assert(rowText.includes("Remove"), `Remove action missing: ${rowText}`);
          },
          screenshot: { name: "admin-disconnect-and-remove", requireText: [SHARED_OAUTH_NAME, "Disconnect", "Remove"] },
        });
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        await ctx.prove("Disconnect confirmation explains accounts are signed out while setup is kept", {
          voiceover: vo[2],
          action: async () => {
            await ctx.eval("window.__disconnectConfirmMessage = null; window.__originalConfirm = window.confirm; window.confirm = (message) => { window.__disconnectConfirmMessage = String(message); return false; };");
            await clickConnectionAction(ctx, requireState(state.sharedOAuthConnectionId, "shared OAuth connection id"), "disconnect");
          },
          assert: async () => {
            const message = await ctx.eval("window.__disconnectConfirmMessage || ''");
            ctx.assert(message.includes("signs out every associated account"), `Confirmation did not explain sign-out: ${message}`);
            ctx.assert(message.includes("keeps the MCP server setup"), `Confirmation did not explain retained setup: ${message}`);
            ctx.assert(message.includes("access rules"), `Confirmation did not mention access rules: ${message}`);
            ctx.assert(message.includes("bindings"), `Confirmation did not mention bindings: ${message}`);
          },
          screenshot: { name: "disconnect-confirmation-copy", requireText: [SHARED_OAUTH_NAME, "Disconnect"] },
        });
      },
    },
    {
      name: "Frame 4",
      run: async (ctx) => {
        await ctx.prove("After disconnect the row remains not connected with creator attribution and reconnect affordance where applicable", {
          voiceover: vo[3],
          action: async () => {
            const connectionId = requireState(state.sharedOAuthConnectionId, "shared OAuth connection id");
            await ctx.eval("window.confirm = () => true;");
            await clickConnectionAction(ctx, connectionId, "disconnect");
            await ctx.waitFor(`(() => {
              return !document.querySelector('[data-testid="disconnect-mcp-connection-${connectionId}"]');
            })()`, { timeoutMs: 30_000, label: "disconnect action removed from shared OAuth row" });
            await ctx.eval("if (window.__originalConfirm) window.confirm = window.__originalConfirm;");
          },
          assert: async () => {
            const rowText = await rowTextByName(ctx, SHARED_OAUTH_NAME, requireState(state.sharedOAuthConnectionId, "shared OAuth connection id"));
            ctx.assert(rowText.includes("Not connected"), `Disconnected row did not show Not connected: ${rowText}`);
            ctx.assert(rowText.includes("Added by"), `Creator attribution disappeared: ${rowText}`);
            ctx.assert(rowText.includes("Connect"), `Disconnected row did not offer Connect: ${rowText}`);
            const connection = await manageableConnection(ctx, requireState(state.sharedOAuthConnectionId, "shared OAuth connection id"));
            ctx.assert(connection.connected === false, `Shared OAuth connection still reported connected: ${JSON.stringify(connection)}`);
            ctx.assert(typeof connection.createdByName === "string" && connection.createdByName.length > 0, "Creator attribution was not retained in the API response.");
          },
          screenshot: { name: "admin-row-after-disconnect", requireText: [SHARED_OAUTH_NAME, "Not connected", "Added by", "Connect"] },
        });
      },
    },
    {
      name: "Frame 5",
      run: async (ctx) => {
        await ctx.prove("Members can disconnect their own per-member external MCP account only", {
          voiceover: vo[4],
          action: async () => {
            await ensureMemberContext(ctx);
            await seedMemberConnection(ctx);
            await signInViaBrowser(ctx, MEMBER_EMAIL, MEMBER_PASSWORD);
            await setBrowserActiveOrganization(ctx);
            await openYourConnections(ctx);
            await ctx.waitForText(MEMBER_NAME, { timeoutMs: 30_000 });
            await ctx.waitForText("Connected as you", { timeoutMs: 30_000 });
            const connectionId = requireState(state.memberConnectionId, "member connection id");
            const selector = `[data-testid="disconnect-my-mcp-account-${connectionId}"]`;
            await ctx.waitFor(`Boolean(document.querySelector(${JSON.stringify(selector)}))`, { timeoutMs: 30_000, label: "member disconnect action" });
            const clicked = await ctx.eval(`(() => {
              const button = document.querySelector(${JSON.stringify(selector)});
              button?.click();
              return Boolean(button);
            })()`);
            ctx.assert(clicked, `Could not click member disconnect action for ${connectionId}.`);
            await waitForUsableConnectedForMe(ctx, connectionId, false);
            await ctx.waitFor(`!document.querySelector(${JSON.stringify(selector)})`, { timeoutMs: 30_000, label: "member disconnect action removed" });
          },
          assert: async () => {
            const connection = await usableConnection(ctx, requireState(state.memberConnectionId, "member connection id"));
            ctx.assert(connection.connectedForMe === false, `Member account still reported connected: ${JSON.stringify(connection)}`);
            const selector = `[data-testid="disconnect-my-mcp-account-${requireState(state.memberConnectionId, "member connection id")}"]`;
            const disconnectButtonGone = await ctx.eval(`!document.querySelector(${JSON.stringify(selector)})`);
            ctx.assert(disconnectButtonGone, "Member disconnect action was still visible after disconnect.");
          },
          screenshot: { name: "member-disconnected-own-account", requireText: [MEMBER_NAME, "Connect your account", "Connect"] },
        });
      },
    },
    {
      name: "Frame 6",
      run: async (ctx) => {
        await ctx.prove("API-key, shared OAuth, and per-member disconnects preserve rows and setup", {
          voiceover: vo[5],
          action: async () => {
            await signInViaBrowser(ctx, ADMIN_EMAIL, ADMIN_PASSWORD);
            await setBrowserActiveOrganization(ctx);
            await startApiKeyMock(ctx);
            await seedApiKeyConnection(ctx);
            await seedSharedOAuthConnection(ctx);
            await ensureMemberContext(ctx);
            await seedMemberConnection(ctx);
            await orgApi(ctx, `/v1/mcp-connections/${requireState(state.apiKeyConnectionId, "API-key connection id")}/disconnect`, { method: "POST" });
            await orgApi(ctx, `/v1/mcp-connections/${requireState(state.sharedOAuthConnectionId, "shared OAuth connection id")}/disconnect`, { method: "POST" });
            await orgApi(ctx, `/v1/mcp-connections/${requireState(state.memberConnectionId, "member connection id")}/disconnect`, { method: "POST" });
            await openAdminConnections(ctx);
            await ctx.waitForText(SHARED_OAUTH_NAME, { timeoutMs: 30_000 });
          },
          assert: async () => {
            const apiKey = await manageableConnection(ctx, requireState(state.apiKeyConnectionId, "API-key connection id"));
            const shared = await manageableConnection(ctx, requireState(state.sharedOAuthConnectionId, "shared OAuth connection id"));
            const member = await manageableConnection(ctx, requireState(state.memberConnectionId, "member connection id"));
            ctx.assert(apiKey.authType === "apikey" && apiKey.connected === false, `API-key disconnect did not hold: ${JSON.stringify(apiKey)}`);
            ctx.assert(shared.authType === "oauth" && shared.credentialMode === "shared" && shared.connected === false, `Shared OAuth disconnect did not hold: ${JSON.stringify(shared)}`);
            ctx.assert(member.credentialMode === "per_member" && member.connected === false, `Per-member aggregate disconnect did not hold: ${JSON.stringify(member)}`);
            ctx.assert(apiKey.access?.orgWide === true && shared.access?.orgWide === true && member.access?.orgWide === true, "Access grants were not retained for every connection.");
            ctx.output("disconnect-rules-summary", JSON.stringify({ apiKey, shared, member }, null, 2));
          },
          screenshot: { name: "all-disconnect-rules", requireText: [API_KEY_NAME, SHARED_OAUTH_NAME, MEMBER_NAME, "Not connected"] },
        });
      },
    },
  ],
};
