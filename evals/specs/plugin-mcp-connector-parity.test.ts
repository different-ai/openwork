import { expect } from "vitest";
import { denFetch } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import { localMysqlIsRunning, localRedisIsRunning, server, test } from "@openwork/testkit";

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

  await using den = await server({ place, org: { name: organizationName, members: {} } });
  const admin = den.admin;
  const orgId = await organizationId(admin, organizationName);
  const headers = orgHeaders(admin, orgId);

  async function manageableConnections(): Promise<Record<string, unknown>[]> {
    const result = await denFetch(admin, "/v1/mcp-connections?scope=manageable", { headers });
    expect(result.response.status, result.text).toBe(200);
    return isRecord(result.body) && Array.isArray(result.body.connections) ? result.body.connections.filter(isRecord) : [];
  }

  async function createPlugin(name: string, component: Record<string, unknown>): Promise<string> {
    const result = await denFetch(admin, "/v1/plugins", {
      method: "POST",
      headers,
      body: JSON.stringify({ name, orgWide: true, components: [component] }),
    });
    expect(result.response.status, result.text).toBe(201);
    const item = isRecord(result.body) && isRecord(result.body.item) ? result.body.item : null;
    const id = item && typeof item.id === "string" ? item.id : "";
    expect(id, result.text).toBeTruthy();
    return id;
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
    "A plugin-owned connector follows the plugin's archive and restore",
    "After POST /v1/plugins/:id/archive the manageable Connectors list no longer contained the plugin-owned connection; after POST /v1/plugins/:id/restore it was listed again with the plugin as its identity manager.",
    true,
  );
});
