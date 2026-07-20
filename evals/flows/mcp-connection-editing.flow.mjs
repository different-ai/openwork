import { createServer } from "node:http";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";
import { denApiFetch, openAdminConnections, signInApi, signInViaBrowser } from "./lib/den-web.mjs";

const FLOW_ID = "mcp-connection-editing";
const vo = await loadVoiceoverParagraphs(FLOW_ID);
const ADMIN_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const ADMIN_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const MOCK_PORT = Number(process.env.OPENWORK_EVAL_MCP_EDIT_MOCK_PORT ?? 4541);
const MOCK_ORIGIN = `http://127.0.0.1:${MOCK_PORT}`;
const RUN_TAG = Date.now().toString(36);
const REGULAR_NAME = `Editable Operations ${RUN_TAG}`;
const RENAMED_NAME = `Renamed Operations ${RUN_TAG}`;
const MARKETPLACE_NAME = `Editable Connections Marketplace ${RUN_TAG}`;
const PLUGIN_NAME = `Managed Operations ${RUN_TAG}`;
const MANAGED_SERVER_NAME = "Managed server";
const REGULAR_API_KEY = `regular-edit-key-${RUN_TAG}`;
const MANAGED_API_KEY = `managed-edit-key-${RUN_TAG}`;

const state = {
  adminSession: null,
  orgId: null,
  regularConnectionId: null,
  managedConnectionId: null,
  marketplaceId: null,
  pluginId: null,
  managedConfigObjectId: null,
};

let mockServer = null;
const mockRequests = [];

function requireState(value, label) {
  if (typeof value === "string" && value.trim()) return value;
  throw new Error(`${label} was not prepared.`);
}

function authHeaders() {
  const headers = { authorization: `Bearer ${requireState(state.adminSession, "admin session")}` };
  if (state.orgId) {
    headers["x-openwork-org-id"] = state.orgId;
    headers["x-openwork-legacy-org-id"] = state.orgId;
  }
  return headers;
}

async function orgApi(ctx, path, init = {}) {
  const response = await denApiFetch(path, {
    ...init,
    headers: { ...authHeaders(), ...(init.headers ?? {}) },
  });
  ctx.assert(response.response.ok || response.response.status === 204, `${path} failed: ${response.response.status} ${JSON.stringify(response.body).slice(0, 500)}`);
  return response.body;
}

function jsonResponse(response, status, body, headers = {}) {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(body));
}

async function readRequestBody(request) {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  return raw.trim() ? JSON.parse(raw) : {};
}

async function startMock(ctx) {
  ctx.assert(!mockServer, "The MCP edit mock was already started.");
  mockServer = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", MOCK_ORIGIN);
    if (url.pathname === "/health") return jsonResponse(response, 200, { ok: true });
    if (url.pathname === "/requests") return jsonResponse(response, 200, { requests: mockRequests });
    if (!url.pathname.endsWith("mcp")) return jsonResponse(response, 404, { error: "not_found" });
    const authorization = request.headers.authorization ?? null;
    const payload = await readRequestBody(request).catch(() => ({}));
    mockRequests.push({ path: url.pathname, authorization, method: payload?.method ?? null });
    if (!authorization?.startsWith("Bearer ")) {
      return jsonResponse(response, 401, { error: "missing_api_key" });
    }
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
          serverInfo: { name: "mcp-connection-editing-proof", version: "1.0.0" },
        },
      });
    }
    if (payload.method === "tools/list") {
      return jsonResponse(response, 200, {
        jsonrpc: "2.0",
        id: payload.id,
        result: {
          tools: [{
            name: "connection_editing_proof",
            description: "Proves that the preserved API key still reaches the MCP.",
            inputSchema: { type: "object", properties: {} },
          }],
        },
      });
    }
    return jsonResponse(response, 200, { jsonrpc: "2.0", id: payload.id, result: {} });
  });
  await new Promise((resolve, reject) => {
    mockServer.once("error", reject);
    mockServer.listen(MOCK_PORT, "127.0.0.1", resolve);
  });
  const health = await fetch(`${MOCK_ORIGIN}/health`, { signal: AbortSignal.timeout(2_000) });
  ctx.assert(health.ok, "The local MCP edit mock did not become healthy.");
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
  await orgApi(ctx, "/v1/me/active-organization", {
    method: "POST",
    body: JSON.stringify({ organizationId: state.orgId }),
  });
}

async function seedRegularConnection(ctx) {
  const created = await orgApi(ctx, "/v1/mcp-connections", {
    method: "POST",
    body: JSON.stringify({
      name: REGULAR_NAME,
      url: `${MOCK_ORIGIN}/regular-mcp`,
      authType: "apikey",
      credentialMode: "shared",
      apiKey: REGULAR_API_KEY,
      access: { orgWide: true, memberIds: [], teamIds: [] },
    }),
  });
  state.regularConnectionId = created.id ?? null;
  ctx.assert(Boolean(state.regularConnectionId), "Editable connection creation did not return an id.");
  ctx.assert(created.connected === true, `Editable API-key connection was not validated: ${JSON.stringify(created)}`);
  ctx.assert(!JSON.stringify(created).includes(REGULAR_API_KEY), "Editable connection create response exposed its API key.");
}

async function seedMarketplaceConnection(ctx) {
  const marketplace = await orgApi(ctx, "/v1/marketplaces", {
    method: "POST",
    body: JSON.stringify({ name: MARKETPLACE_NAME, description: "Fraimz-owned marketplace for editable MCP proof." }),
  });
  state.marketplaceId = marketplace.item?.id ?? null;
  ctx.assert(Boolean(state.marketplaceId), "Marketplace creation did not return an id.");

  const payload = { mcpServers: { [MANAGED_SERVER_NAME]: { type: "remote", url: `${MOCK_ORIGIN}/managed-mcp` } } };
  const plugin = await orgApi(ctx, "/v1/plugins", {
    method: "POST",
    body: JSON.stringify({
      name: PLUGIN_NAME,
      description: "Marketplace-managed MCP identity for edit proof.",
      marketplaceId: state.marketplaceId,
      components: [{
        type: "mcp",
        input: {
          rawSourceText: JSON.stringify(payload, null, 2),
          normalizedPayloadJson: payload,
          metadata: { name: MANAGED_SERVER_NAME, title: MANAGED_SERVER_NAME, description: "Marketplace-owned MCP server." },
        },
      }],
    }),
  });
  state.pluginId = plugin.item?.id ?? null;
  ctx.assert(Boolean(state.pluginId), "Marketplace plugin creation did not return an id.");

  const resolved = await orgApi(ctx, `/v1/plugins/${requireState(state.pluginId, "plugin id")}/resolved`);
  state.managedConfigObjectId = (resolved.items ?? [])
    .map((item) => item.configObject)
    .find((item) => item?.objectType === "mcp")?.id ?? null;
  ctx.assert(Boolean(state.managedConfigObjectId), "Marketplace plugin did not resolve an MCP config object.");

  const configured = await orgApi(ctx, `/v1/plugins/${requireState(state.pluginId, "plugin id")}/mcp-connections`, {
    method: "POST",
    body: JSON.stringify({
      configObjectId: state.managedConfigObjectId,
      serverName: MANAGED_SERVER_NAME,
      authType: "apikey",
      credentialMode: "shared",
      apiKey: MANAGED_API_KEY,
    }),
  });
  state.managedConnectionId = configured.item?.connection?.id ?? null;
  ctx.assert(Boolean(state.managedConnectionId), `Marketplace MCP configuration did not return a connection: ${JSON.stringify(configured).slice(0, 500)}`);
  ctx.assert(!JSON.stringify(configured).includes(MANAGED_API_KEY), "Marketplace configuration response exposed its API key.");
}

async function setBrowserActiveOrganization(ctx) {
  await ctx.eval(`fetch('/api/den/v1/me/active-organization', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ organizationId: ${JSON.stringify(requireState(state.orgId, "organization id"))} }),
  }).then((response) => response.ok)`, { awaitPromise: true });
}

async function openEditDialog(ctx, connectionId) {
  await ctx.waitFor(`Boolean(document.querySelector('[data-testid="edit-mcp-connection-${connectionId}"]'))`, { timeoutMs: 30_000, label: `edit action for ${connectionId}` });
  const clicked = await ctx.eval(`(() => {
    const button = document.querySelector('[data-testid="edit-mcp-connection-${connectionId}"]');
    button?.click();
    return Boolean(button);
  })()`);
  ctx.assert(clicked, `Could not open edit dialog for ${connectionId}.`);
  await ctx.waitFor(`Boolean(document.querySelector('[data-testid="edit-mcp-connection-dialog"]'))`, { timeoutMs: 10_000, label: "MCP edit dialog" });
}

async function clickDialogButton(ctx, label) {
  const clicked = await ctx.eval(`(() => {
    const dialog = document.querySelector('[data-testid="edit-mcp-connection-dialog"]');
    const button = dialog ? [...dialog.querySelectorAll('button')].find((entry) => (entry.textContent ?? '').trim() === ${JSON.stringify(label)}) : null;
    button?.click();
    return Boolean(button);
  })()`);
  ctx.assert(clicked, `Could not click ${label} in the edit dialog.`);
}

async function manageableConnection(ctx, connectionId) {
  const listed = await orgApi(ctx, "/v1/mcp-connections?scope=manageable");
  const connection = (listed.connections ?? []).find((entry) => entry.id === connectionId);
  ctx.assert(Boolean(connection), `Connection ${connectionId} was not returned by the manageable list.`);
  return connection;
}

async function cleanup(ctx) {
  for (const connectionId of [state.regularConnectionId, state.managedConnectionId]) {
    if (!connectionId) continue;
    const removed = await denApiFetch(`/v1/mcp-connections/${connectionId}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    ctx.assert(removed.response.ok || removed.response.status === 404, `Connection cleanup failed for ${connectionId}: ${removed.response.status}`);
  }
  if (state.marketplaceId && state.pluginId) {
    await denApiFetch(`/v1/marketplaces/${state.marketplaceId}/plugins/${state.pluginId}`, { method: "DELETE", headers: authHeaders() });
  }
  if (state.pluginId) {
    await denApiFetch(`/v1/plugins/${state.pluginId}/archive`, { method: "POST", headers: authHeaders() });
  }
  if (state.marketplaceId) {
    await denApiFetch(`/v1/marketplaces/${state.marketplaceId}/archive`, { method: "POST", headers: authHeaders() });
  }
  await new Promise((resolve) => mockServer?.close(resolve));
  mockServer = null;
}

export default {
  id: FLOW_ID,
  title: "Admins safely edit existing MCP connections",
  kind: "user-facing",
  preserveTheme: true,
  spec: "evals/voiceovers/mcp-connection-editing.md",
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_WEB_URL"],
  steps: [
    {
      name: "Setup",
      run: async (ctx) => {
        await startMock(ctx);
        await ensureAdminContext(ctx);
        await seedRegularConnection(ctx);
        await seedMarketplaceConnection(ctx);
      },
    },
    {
      name: "Frame 1",
      run: async (ctx) => {
        await ctx.prove("The admin opens a prefilled edit form without receiving the saved API key", {
          voiceover: vo[0],
          action: async () => {
            await signInViaBrowser(ctx, ADMIN_EMAIL, ADMIN_PASSWORD);
            await setBrowserActiveOrganization(ctx);
            await openAdminConnections(ctx);
            await ctx.waitForText(REGULAR_NAME, { timeoutMs: 30_000 });
            await openEditDialog(ctx, requireState(state.regularConnectionId, "regular connection id"));
          },
          assert: async () => {
            const form = await ctx.eval(`(() => {
              const dialog = document.querySelector('[data-testid="edit-mcp-connection-dialog"]');
              const key = dialog?.querySelector('[data-testid="edit-mcp-api-key"]');
              const name = dialog?.querySelector('[data-testid="edit-mcp-name"]');
              const url = dialog?.querySelector('[data-testid="edit-mcp-url"]');
              return {
                text: dialog?.innerText ?? '',
                keyValue: key?.value ?? null,
                nameValue: name?.value ?? null,
                urlValue: url?.value ?? null,
              };
            })()`);
            ctx.assert(form.nameValue === REGULAR_NAME, `Edit name was not prefilled: ${JSON.stringify(form)}`);
            ctx.assert(form.urlValue === `${MOCK_ORIGIN}/regular-mcp`, `Edit URL was not prefilled: ${JSON.stringify(form)}`);
            ctx.assert(form.keyValue === "", "Saved API key appeared in the browser.");
            ctx.assert(form.text.includes("API key") && form.text.includes("One org account"), `Authentication/account mode were not visible: ${form.text}`);
            ctx.assert(form.text.includes("Everyone"), "Assignment summary was not visible in the form.");
          },
          screenshot: {
            name: "frame-1-prefilled-secret-safe-edit",
            claim: "The edit form is prefilled with public connection settings and an empty optional replacement secret.",
            requireText: ["Edit MCP connection", REGULAR_NAME, "Server URL", "Authentication", "Replacement API key (optional)", "One org account", "Who can use this?"],
            rejectText: [REGULAR_API_KEY, "access_token", "refresh_token", "client_secret"],
          },
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await ctx.prove("A rename keeps the MCP connected and its existing API key operational", {
          voiceover: vo[1],
          action: async () => {
            await ctx.fill('[data-testid="edit-mcp-name"]', RENAMED_NAME);
            await clickDialogButton(ctx, "Save changes");
            await ctx.waitForText(`${RENAMED_NAME} was updated without disconnecting it.`, { timeoutMs: 30_000 });
          },
          assert: async () => {
            const connection = await manageableConnection(ctx, state.regularConnectionId);
            ctx.assert(connection.name === RENAMED_NAME && connection.connected === true, `Rename disconnected or failed: ${JSON.stringify(connection)}`);
            const tools = await denApiFetch(`/v1/mcp-connections/${state.regularConnectionId}/tools`, { headers: authHeaders() });
            ctx.assert(tools.response.ok, `Preserved API key no longer reached tools/list: ${tools.response.status} ${JSON.stringify(tools.body)}`);
            ctx.assert((tools.body.tools ?? []).some((tool) => tool.name === "connection_editing_proof"), "Preserved credential did not return the proof tool.");
          },
          screenshot: {
            name: "frame-2-rename-stays-connected",
            claim: "The renamed MCP remains connected and the saved credential still works.",
            requireText: [RENAMED_NAME, "Connected", "updated without disconnecting"],
            rejectText: [REGULAR_API_KEY, "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        await ctx.prove("A sensitive identity change requires confirmation and invalidates the old credential", {
          voiceover: vo[2],
          action: async () => {
            await openEditDialog(ctx, requireState(state.regularConnectionId, "regular connection id"));
            await ctx.fill('[data-testid="edit-mcp-url"]', `${MOCK_ORIGIN}/replacement-oauth-mcp`);
            await clickDialogButton(ctx, "OAuth");
            await clickDialogButton(ctx, "Review identity change");
            await ctx.waitForText("Confirm that you want to invalidate the old identity.", { timeoutMs: 10_000 });
            await ctx.screenshot("frame-3-identity-change-warning", {
              claim: "OpenWork names every credential class that the identity change will invalidate before confirmation.",
              voiceover: vo[2],
              requireText: ["This changes the connection identity", "shared and individual sessions", "pending OAuth state", "Confirm and save"],
              rejectText: [REGULAR_API_KEY, "access_token", "refresh_token"],
            });
            await clickDialogButton(ctx, "Confirm and save");
            await ctx.waitForText("Reconnect it before the new identity can be used.", { timeoutMs: 30_000 });
          },
          assert: async () => {
            const connection = await manageableConnection(ctx, state.regularConnectionId);
            ctx.assert(connection.url === `${MOCK_ORIGIN}/replacement-oauth-mcp`, `URL identity was not replaced: ${JSON.stringify(connection)}`);
            ctx.assert(connection.authType === "oauth" && connection.connected === false, `OAuth replacement was not disconnected: ${JSON.stringify(connection)}`);
            const tools = await denApiFetch(`/v1/mcp-connections/${state.regularConnectionId}/tools`, { headers: authHeaders() });
            ctx.assert(tools.response.status === 409 && tools.body?.error === "connection_not_ready", `Old API key remained usable: ${tools.response.status} ${JSON.stringify(tools.body)}`);
          },
          screenshot: {
            name: "frame-3-reconnection-required",
            claim: "After confirmation the same connection id is disconnected and explicitly requires reconnection.",
            requireText: [RENAMED_NAME, "Not connected", "Reconnect it before the new identity can be used"],
            rejectText: [REGULAR_API_KEY, "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 4",
      run: async (ctx) => {
        await ctx.prove("Marketplace ownership locks identity fields while direct assignments remain editable", {
          voiceover: vo[3],
          action: async () => {
            await openEditDialog(ctx, requireState(state.managedConnectionId, "managed connection id"));
            await clickDialogButton(ctx, "Everyone");
            const locked = await ctx.eval(`(() => {
              const dialog = document.querySelector('[data-testid="edit-mcp-connection-dialog"]');
              const url = dialog?.querySelector('[data-testid="edit-mcp-url"]');
              const authButtons = [...(dialog?.querySelectorAll('button') ?? [])].filter((button) => ['OAuth', 'API key', 'None'].includes((button.textContent ?? '').trim()));
              return { urlDisabled: Boolean(url?.disabled), authDisabled: authButtons.length === 3 && authButtons.every((button) => button.disabled) };
            })()`);
            ctx.assert(locked.urlDisabled && locked.authDisabled, `Marketplace identity controls were editable: ${JSON.stringify(locked)}`);
            await ctx.screenshot("frame-4-marketplace-identity-owned", {
              claim: "The plugin source is named, identity controls are disabled, and Everyone remains selectable.",
              voiceover: vo[3],
              requireText: ["managed by", PLUGIN_NAME, "marketplace plugin definition", "Everyone", "Save changes"],
              rejectText: [MANAGED_API_KEY, "Something went wrong"],
            });
            await clickDialogButton(ctx, "Save changes");
            await ctx.waitForText("was updated without disconnecting it.", { timeoutMs: 30_000 });
          },
          assert: async () => {
            const connection = await manageableConnection(ctx, state.managedConnectionId);
            ctx.assert(connection.connected === true, `Marketplace connection disconnected during access edit: ${JSON.stringify(connection)}`);
            ctx.assert(connection.access?.orgWide === true, `Direct Everyone assignment was not saved: ${JSON.stringify(connection.access)}`);
            ctx.assert((connection.requiredBy ?? []).some((owner) => owner.name === PLUGIN_NAME), `requiredBy projection regressed: ${JSON.stringify(connection.requiredBy)}`);
            ctx.assert((connection.identityManagedBy ?? []).some((owner) => owner.name === PLUGIN_NAME), `Marketplace identity ownership was not server-derived: ${JSON.stringify(connection.identityManagedBy)}`);
          },
          screenshot: {
            name: "frame-4-marketplace-assignment-saved",
            claim: "The marketplace MCP stays connected after its direct Everyone assignment is saved.",
            requireText: [PLUGIN_NAME, "Connected", "Everyone in the org", "updated without disconnecting"],
            rejectText: [MANAGED_API_KEY, "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Cleanup",
      run: async (ctx) => cleanup(ctx),
    },
  ],
};
