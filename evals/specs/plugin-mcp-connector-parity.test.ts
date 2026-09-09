import { expect } from "vitest";
import { denFetch } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import { queryDenDatabase } from "@openwork/env";
import { localMysqlIsRunning, localRedisIsRunning, needs, server, test } from "@openwork/testkit";
import {
  denLibraryPluginCreateRequest,
  emptyLibraryMcpConnectionForm,
} from "../../apps/app/src/react-app/domains/settings/library";

const daytona = process.env.OPENWORK_EVAL_DAYTONA?.trim() === "1";
const attached = Boolean(process.env.OPENWORK_EVAL_DEN_API_URL?.trim());
const mysqlOpen = daytona || attached || await localMysqlIsRunning();
const redisOpen = daytona || attached || await localRedisIsRunning();
const title = !mysqlOpen
  ? "plugin MCP connector parity skipped — needs MySQL on 127.0.0.1:3306"
  : !redisOpen
    ? "plugin MCP connector parity skipped — needs Redis on 127.0.0.1:6379"
    : "a plugin's MCP server is configured like a connector and leaves the Connectors list with the plugin";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function orgHeaders(session: DenSession, orgId: string): Record<string, string> {
  return { authorization: `Bearer ${session.token}`, "x-openwork-org-id": orgId };
}

async function organizationId(admin: DenSession, organizationName: string): Promise<string> {
  const result = await denFetch(admin, "/v1/me/orgs", { headers: { authorization: `Bearer ${admin.token}` } });
  const organizations = isRecord(result.body) && Array.isArray(result.body.orgs) ? result.body.orgs.filter(isRecord) : [];
  const organization = organizations.find((entry) => entry.name === organizationName);
  const id = organization && typeof organization.id === "string" ? organization.id : "";
  if (!result.response.ok || !id) {
    throw new Error(`Finding the test organization failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return id;
}

function mcpComponent(url: string, connection?: Record<string, unknown>) {
  return {
    type: "mcp",
    input: {
      normalizedPayloadJson: { mcpServers: { crm: { type: "remote", url } } },
      metadata: { name: "CRM" },
    },
    ...(connection ? { connection } : {}),
  };
}

function pluginNames(row: Record<string, unknown> | undefined): string[] {
  const entries = row?.identityManagedBy;
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => isRecord(entry) && typeof entry.name === "string" ? [entry.name] : []);
}

test.skipIf(!mysqlOpen || !redisOpen)(title, { timeout: 300_000 }, async ({ evidence, place }) => {
  const runId = `${Date.now().toString(36)}${process.pid.toString(36)}`;
  const organizationName = `Plugin MCP Parity ${runId}`;
  const configuredPluginName = `Configured CRM ${runId}`;
  const configuredUrl = `https://crm-configured-${runId}.example.test/mcp`;
  const declaredUrl = `https://crm-declared-${runId}.example.test/mcp`;
  const desktopPluginName = `Desktop Linear ${runId}`;
  const desktopUrl = `https://linear-desktop-${runId}.example.test/mcp`;

  await using den = await server({ place, org: { name: organizationName, members: {} } });
  const admin = den.admin;
  const orgId = await organizationId(admin, organizationName);
  const headers = orgHeaders(admin, orgId);

  async function manageableConnections(): Promise<Record<string, unknown>[]> {
    const result = await denFetch(admin, "/v1/mcp-connections?scope=manageable", { headers });
    expect(result.response.status, result.text).toBe(200);
    return isRecord(result.body) && Array.isArray(result.body.connections) ? result.body.connections.filter(isRecord) : [];
  }

  async function postPlugin(body: Record<string, unknown>): Promise<string> {
    const result = await denFetch(admin, "/v1/plugins", { method: "POST", headers, body: JSON.stringify(body) });
    expect(result.response.status, result.text).toBe(201);
    const item = isRecord(result.body) && isRecord(result.body.item) ? result.body.item : null;
    const id = item && typeof item.id === "string" ? item.id : "";
    expect(id, result.text).toBeTruthy();
    return id;
  }

  function createPlugin(name: string, component: Record<string, unknown>): Promise<string> {
    return postPlugin({ name, orgWide: true, components: [component] });
  }

  // Claim: the connector setup given while adding the MCP server to the plugin
  // (authentication and whose account the AI uses) configures the connection
  // immediately, and the Connectors list shows it under the plugin.
  const pluginId = await createPlugin(configuredPluginName, mcpComponent(configuredUrl, { authType: "oauth", credentialMode: "shared" }));
  const listed = await manageableConnections();
  const configured = listed.find((row) => row.url === configuredUrl);
  expect(configured, JSON.stringify(listed)).toMatchObject({
    authType: "oauth",
    credentialMode: "shared",
    name: `${configuredPluginName} / crm`,
  });
  expect(pluginNames(configured)).toEqual([configuredPluginName]);

  // Negative half: an MCP declaration without connector setup stays a declaration.
  await createPlugin(`Declared CRM ${runId}`, mcpComponent(declaredUrl));
  expect((await manageableConnections()).some((row) => row.url === declaredUrl)).toBe(false);

  // Claim: the Desktop Library's "Add organization MCP" builds the same request
  // shape, so an admin adding an MCP server from the app gets a configured
  // connector too. Den validates non-OAuth setups against the server itself,
  // so the OAuth-with-pre-registered-app path is the one that stays hermetic.
  const desktopBody = denLibraryPluginCreateRequest("mcp", {
    name: desktopPluginName,
    description: "",
    instructions: desktopUrl,
    orgWide: true,
    connection: {
      ...emptyLibraryMcpConnectionForm(),
      credentialMode: "shared",
      useOAuthClient: true,
      oauthClientId: "desktop-client-id",
      oauthClientSecret: "desktop-client-secret",
    },
  });
  expect(desktopBody.components[0]?.connection).toEqual({
    authType: "oauth",
    credentialMode: "shared",
    oauthClient: { clientId: "desktop-client-id", clientSecret: "desktop-client-secret" },
  });
  await postPlugin({ ...desktopBody });
  const desktopRow = (await manageableConnections()).find((row) => row.url === desktopUrl);
  expect(desktopRow, JSON.stringify(desktopRow)).toMatchObject({
    authType: "oauth",
    credentialMode: "shared",
    oauthClientConfigured: true,
    oauthClientId: "desktop-client-id",
  });
  expect(pluginNames(desktopRow)).toEqual([desktopPluginName]);

  // Claim: archiving the plugin removes its connector from the Connectors list;
  // restoring the plugin lists it again with the same provenance.
  const archived = await denFetch(admin, `/v1/plugins/${encodeURIComponent(pluginId)}/archive`, { method: "POST", headers });
  expect(archived.response.status, archived.text).toBe(200);
  const afterArchive = await manageableConnections();
  expect(afterArchive.some((row) => row.url === configuredUrl), JSON.stringify(afterArchive)).toBe(false);

  const restored = await denFetch(admin, `/v1/plugins/${encodeURIComponent(pluginId)}/restore`, { method: "POST", headers });
  expect(restored.response.status, restored.text).toBe(200);
  const afterRestore = await manageableConnections();
  const restoredRow = afterRestore.find((row) => row.url === configuredUrl);
  expect(restoredRow, JSON.stringify(afterRestore)).toBeDefined();
  expect(pluginNames(restoredRow)).toEqual([configuredPluginName]);

  evidence.recordAssertionEvidence(
    "Adding an MCP server to a plugin configures its connection with the connector setup",
    `POST /v1/plugins with an mcp component carrying { authType: oauth, credentialMode: shared } created "${configuredPluginName} / crm" as an OAuth, one-org-account connection owned by the plugin; scope=manageable listed it under that plugin. A declaration without connection setup created no connection.`,
    true,
  );
  evidence.recordAssertionEvidence(
    "The Desktop Library posts the same connector setup Den's plugin editor does",
    `denLibraryPluginCreateRequest("mcp", …) — the body the app's "Add organization MCP" dialog sends — carried { authType: oauth, credentialMode: shared, oauthClient } for "${desktopPluginName}"; Den accepted it and listed the connection as OAuth, one org account, with the pre-registered client id configured and the plugin as identity manager.`,
    true,
  );
  evidence.recordAssertionEvidence(
    "A plugin-owned connector follows the plugin's archive and restore",
    "After POST /v1/plugins/:id/archive the manageable Connectors list no longer contained the plugin-owned connection; after POST /v1/plugins/:id/restore it was listed again with the plugin as its identity manager.",
    true,
  );
});

test("persisted GitHub no-auth bindings stay discoverable without allowing new anonymous setup or overriding OAuth", { timeout: 300_000 }, async ({ evidence, place, skip }) => {
  needs({ placement: "local" });
  if (!await localMysqlIsRunning() || !await localRedisIsRunning()) skip("needs: local MySQL and Redis");
  const organizationName = `Legacy Connector ${Date.now().toString(36)}`;
  await using den = await server({ place, web: false, org: { name: organizationName, members: {} } });
  if (!den.database) throw new Error("Persisted legacy connector coverage requires an isolated database");
  const orgId = await organizationId(den.admin, organizationName);
  const headers = orgHeaders(den.admin, orgId);
  const url = "https://api.githubcopilot.com/mcp/";
  const databaseUrl = den.database.url;

  async function createPlugin(authType: "none" | "oauth") {
    return denFetch(den.admin, "/v1/plugins", {
      method: "POST", headers,
      body: JSON.stringify({ name: "Legacy GitHub", orgWide: true, components: [mcpComponent(url, { authType, credentialMode: "shared" })] }),
    });
  }

  const rejected = await createPlugin("none");
  expect(rejected.response.status, rejected.text).toBe(409);
  expect(rejected.body).toMatchObject({ error: "mcp_auth_type_mismatch" });
  const created = await createPlugin("oauth");
  expect(created.response.status, created.text).toBe(201);
  const plugin = isRecord(created.body) && isRecord(created.body.item) ? created.body.item : null;
  if (!plugin || typeof plugin.id !== "string") throw new Error("Missing created plugin");
  const bindings = await queryDenDatabase(databaseUrl,
    "SELECT external_mcp_connection_id AS connectionId, config_object_id AS configObjectId FROM plugin_mcp_requirement_binding WHERE organization_id = ? AND plugin_id = ?",
    [orgId, plugin.id],
  );
  const binding = bindings[0];
  if (!isRecord(binding) || typeof binding.connectionId !== "string" || typeof binding.configObjectId !== "string") throw new Error("Missing created binding");
  const connectionId = binding.connectionId;

  // Only the isolated fixture bypasses current setup validation to model a row
  // accepted before the GitHub preset existed. No provider request is needed.
  await queryDenDatabase(databaseUrl,
    "UPDATE external_mcp_connection SET auth_type = 'none', connected_at = NOW() WHERE organization_id = ? AND id = ?",
    [orgId, connectionId],
  );

  const minted = await denFetch(den.admin, "/v1/mcp/token", {
    method: "POST", headers, body: JSON.stringify({ scopes: ["mcp:read"] }),
  });
  expect(minted.response.status, minted.text).toBe(200);
  if (!isRecord(minted.body) || typeof minted.body.appHostToken !== "string") throw new Error("Missing desktop MCP token");
  const token = minted.body.appHostToken;

  async function desktopServerIndex() {
    const response = await fetch(`${den.ref.apiUrl}/mcp/agent`, {
      method: "POST", signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream", "content-type": "application/json", "x-openwork-mcp-client-capabilities": "mcp-app-host-v1" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "openwork://connect/mcp-servers/index.json" } }),
    });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    const data = text.split("\n").find((line) => line.startsWith("data:"));
    const rpc: unknown = JSON.parse(data ? data.slice(5) : text);
    if (!isRecord(rpc) || !isRecord(rpc.result) || !Array.isArray(rpc.result.contents)) throw new Error(`Missing MCP index: ${text}`);
    const content = rpc.result.contents[0];
    if (!isRecord(content) || typeof content.text !== "string") throw new Error("Missing MCP index content");
    const index: unknown = JSON.parse(content.text);
    if (!isRecord(index) || !Array.isArray(index.servers)) throw new Error("Invalid MCP index");
    return index.servers.filter(isRecord).map((entry) => entry.connectionId);
  }

  for (const requiredAuthType of [null, "none", "oauth"]) {
    if (requiredAuthType === "oauth") {
      const versioned = await denFetch(den.admin, `/v1/config-objects/${binding.configObjectId}/versions`, {
        method: "POST", headers,
        body: JSON.stringify({ input: { normalizedPayloadJson: { mcpServers: { crm: { type: "remote", url, oauth: true } } } } }),
      });
      expect(versioned.response.status, versioned.text).toBe(201);
    }
    await queryDenDatabase(databaseUrl,
      "UPDATE plugin_mcp_requirement_binding SET required_auth_type = ? WHERE organization_id = ? AND plugin_id = ?",
      [requiredAuthType, orgId, plugin.id],
    );
    const listed = await denFetch(den.admin, "/v1/mcp-connections?scope=usable", { headers });
    expect(listed.response.status, listed.text).toBe(200);
    const rows = isRecord(listed.body) && Array.isArray(listed.body.connections) ? listed.body.connections.filter(isRecord) : [];
    expect(rows.find((row) => row.id === connectionId)).toMatchObject({
      authType: "none", connected: true, authPolicyConfirmed: true,
      authTypeMismatch: requiredAuthType === "oauth", setupRequired: requiredAuthType === "oauth",
    });
    const index = await desktopServerIndex();
    expect(index.includes(connectionId), `required auth: ${requiredAuthType}`).toBe(requiredAuthType !== "oauth");
  }
  expect(await queryDenDatabase(databaseUrl,
    "SELECT auth_type AS authType FROM external_mcp_connection WHERE organization_id = ? AND id = ?", [orgId, connectionId],
  )).toEqual([{ authType: "none" }]);
  evidence.recordAssertionEvidence(
    "Legacy GitHub discovery does not relax new setup or explicit OAuth",
    "New anonymous plugin configuration was rejected. A persisted connected none binding, with either no required auth or required none, remained setup-ready and present in the desktop MCP index. Explicit OAuth blocked it without rewriting the stored auth type. No GitHub endpoint was contacted.",
    true,
  );
});
