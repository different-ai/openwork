import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { pluginEditorWithConnector } from "../worlds/library.ts";

type ConnectionFact = {
  id: string;
  name: string;
  requiredBy: string[];
  identityManagedBy: string[];
};

type ResolvedPluginFact = {
  pluginId: string;
  name: string;
  state: string;
  connectionIds: Array<string | null>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function pluginNames(value: unknown): string[] {
  return records(value).flatMap((entry) => typeof entry.name === "string" ? [entry.name] : []);
}

function connectionFacts(body: unknown): ConnectionFact[] {
  const connections = isRecord(body) ? records(body.connections) : [];
  return connections.map((connection) => ({
    id: typeof connection.id === "string" ? connection.id : "",
    name: typeof connection.name === "string" ? connection.name : "",
    requiredBy: pluginNames(connection.requiredBy),
    identityManagedBy: pluginNames(connection.identityManagedBy),
  }));
}

function resolvedPluginFact(body: unknown, pluginName: string): ResolvedPluginFact | null {
  const item = isRecord(body) && isRecord(body.item) ? body.item : null;
  const plugin = item ? records(item.plugins).find((entry) => entry.name === pluginName) : undefined;
  if (!plugin) return null;
  const readiness = isRecord(plugin.cloudReadiness) ? plugin.cloudReadiness : null;
  return {
    pluginId: typeof plugin.id === "string" ? plugin.id : "",
    name: typeof plugin.name === "string" ? plugin.name : "",
    state: readiness && typeof readiness.state === "string" ? readiness.state : "",
    connectionIds: readiness
      ? records(readiness.connections).map((connection) => typeof connection.id === "string" ? connection.id : null)
      : [],
  };
}

function errorCode(body: unknown): string {
  return isRecord(body) && typeof body.error === "string" ? body.error : "";
}

const test = spec.world(pluginEditorWithConnector, { timeout: 420_000 });

test("an admin creates a collection-ready plugin by picking an existing connector", async ({ world, seed, user, probe, step, evidence }) => {
  const beforeManageable = await probe.api(world.den.admin, "/v1/mcp-connections?scope=manageable");
  expect(beforeManageable.response.status).toBe(200);
  const beforeConnections = connectionFacts(beforeManageable.body);
  const baselineConnectionCount = beforeConnections.length;

  let editorWitness = {
    connectorVisible: false,
    authentication: false,
    apiKey: false,
    accountOwner: false,
    urlPlaceholder: false,
  };
  await step("pick the organization's existing connector", async () => {
    await user.see({ text: "Create a plugin" }, { timeoutMs: 90_000 });
    await user.type({ placeholder: "e.g. Sales call prep" }, world.pluginName);
    await user.click("Connector");
    await user.see({ text: world.connection.name });
    await user.notSee({ text: "Authentication" });
    await user.notSee({ text: "API key" });
    await user.notSee({ text: "Whose account does the AI use?" });
    await user.notSee({ placeholder: "https://mcp.example.com/mcp" });
    const editorText = await probe.text();
    editorWitness = {
      connectorVisible: editorText.includes(world.connection.name),
      authentication: editorText.includes("Authentication"),
      apiKey: editorText.includes("API key"),
      accountOwner: editorText.includes("Whose account does the AI use?"),
      urlPlaceholder: false,
    };
    await user.screenshot();
    await user.click({ testId: `plugin-connector-option-${world.connection.id}` });
    await user.click("Create plugin");
  });
  evidence.recordAssertionEvidence(
    "The plugin editor offers an existing organization connector without legacy URL or authentication entry",
    `Connector=${JSON.stringify(world.connection.name)}; editor witness=${JSON.stringify(editorWitness)}`,
    editorWitness.connectorVisible
      && !editorWitness.authentication
      && !editorWitness.apiKey
      && !editorWitness.accountOwner
      && !editorWitness.urlPlaceholder,
  );

  await step("see the created plugin and its selected MCP server", async () => {
    await user.see({ text: world.pluginName }, { timeoutMs: 90_000 });
    await user.see({ text: "MCP Servers" });
    await user.see({ text: world.connection.name });
    await user.see({ text: "Connector" });
    await user.notSee({ text: "Imported from a connected repository." });
    await user.screenshot();
  });

  const resolved = await probe.eventually(async () => {
    const result = await probe.api(world.den.admin, `/v1/marketplaces/${world.marketplaceId}/resolved`);
    return {
      responseStatus: result.response.status,
      plugin: resolvedPluginFact(result.body, world.pluginName),
    };
  }, {
    within: 60_000,
    intervalMs: 1_000,
    label: "plugin ready in its collection with the selected connector",
    until: (result) => result.responseStatus === 200
      && result.plugin?.state === "ready"
      && result.plugin.connectionIds[0] === world.connection.id,
  });
  expect(resolved.responseStatus).toBe(200);
  expect(resolved.plugin?.name).toBe(world.pluginName);
  expect(resolved.plugin?.state).toBe("ready");
  expect(resolved.plugin?.connectionIds[0]).toBe(world.connection.id);
  evidence.recordAssertionEvidence(
    "The created plugin is immediately ready in its selected collection with the existing connector",
    `Detail page listed the server under MCP Servers with a "Connector" badge and no "Imported from a connected repository." fallback copy. Collection=${JSON.stringify({ id: world.marketplaceId, name: world.marketplaceName })}; resolved plugin=${JSON.stringify(resolved.plugin)}`,
    resolved.responseStatus === 200
      && resolved.plugin?.name === world.pluginName
      && resolved.plugin.state === "ready"
      && resolved.plugin.connectionIds[0] === world.connection.id,
  );

  const afterManageable = await probe.eventually(async () => {
    const result = await probe.api(world.den.admin, "/v1/mcp-connections?scope=manageable");
    const connections = connectionFacts(result.body);
    const selected = connections.find((connection) => connection.id === world.connection.id) ?? null;
    return {
      responseStatus: result.response.status,
      count: connections.length,
      selected,
      duplicateNames: connections
        .map((connection) => connection.name)
        .filter((name) => name.startsWith(`${world.pluginName} /`)),
    };
  }, {
    within: 60_000,
    intervalMs: 1_000,
    label: "existing connector records the plugin without a duplicate connector",
    until: (result) => result.responseStatus === 200
      && result.count === baselineConnectionCount
      && result.selected?.requiredBy.includes(world.pluginName) === true
      && result.selected.identityManagedBy.includes(world.pluginName) === false
      && result.duplicateNames.length === 0,
  });
  expect(afterManageable.responseStatus).toBe(200);
  expect(afterManageable.count).toBe(baselineConnectionCount);
  expect(afterManageable.selected?.requiredBy).toContain(world.pluginName);
  expect(afterManageable.selected?.identityManagedBy).not.toContain(world.pluginName);
  expect(afterManageable.duplicateNames).toEqual([]);

  const unknownConnection = await seed.api(world.den.admin, "/v1/plugins", {
    method: "POST",
    body: JSON.stringify({
      name: `${world.pluginName} unknown connector`,
      orgWide: true,
      components: [{ type: "mcp", connectionId: "emc_does_not_exist" }],
    }),
  });
  const conflictingConnection = await seed.api(world.den.admin, "/v1/plugins", {
    method: "POST",
    body: JSON.stringify({
      name: `${world.pluginName} conflicting connector`,
      orgWide: true,
      components: [{
        type: "mcp",
        connectionId: world.connection.id,
        connection: { authType: "none", credentialMode: "shared" },
      }],
    }),
  });
  expect(unknownConnection.response.status).toBe(404);
  expect(errorCode(unknownConnection.body)).toBe("mcp_connection_not_found");
  expect(conflictingConnection.response.status).toBe(400);
  expect(errorCode(conflictingConnection.body)).toBe("invalid_request");

  const connectorReuseWitness = {
    baselineConnectionCount,
    finalConnectionCount: afterManageable.count,
    selected: afterManageable.selected,
    duplicateNames: afterManageable.duplicateNames,
    unknownConnection: {
      status: unknownConnection.response.status,
      error: errorCode(unknownConnection.body),
    },
    conflictingConnection: {
      status: conflictingConnection.response.status,
      error: errorCode(conflictingConnection.body),
    },
  };
  evidence.recordAssertionEvidence(
    "Creating from a connector reuses it without owning or duplicating it, and invalid connection references are rejected",
    JSON.stringify(connectorReuseWitness),
    afterManageable.count === baselineConnectionCount
      && afterManageable.selected?.requiredBy.includes(world.pluginName) === true
      && afterManageable.selected.identityManagedBy.includes(world.pluginName) === false
      && afterManageable.duplicateNames.length === 0
      && unknownConnection.response.status === 404
      && errorCode(unknownConnection.body) === "mcp_connection_not_found"
      && conflictingConnection.response.status === 400
      && errorCode(conflictingConnection.body) === "invalid_request",
  );
});
