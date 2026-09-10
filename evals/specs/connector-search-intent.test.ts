import { expect } from "vitest";
import { denFetch } from "@openwork/behaviors";
import { mcpMock, needs, server, test } from "@openwork/testkit";

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected an object");
  return value;
}

function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Expected a list");
  return value.map(record);
}

// This is a distinct gateway journey: discovering a blocked connection must be
// informational until the caller explicitly requests connection setup.
test("gateway discovery preserves setup intent and execution scopes", { timeout: 300_000 }, async ({ evidence, place }) => {
  needs({ commands: ["bun", "pnpm"] });
  const scopeCases = [
    { name: "read_scope_fixture", annotations: { readOnlyHint: true, destructiveHint: false }, requiresWrite: false },
    { name: "write_scope_fixture", annotations: { readOnlyHint: false, destructiveHint: false }, requiresWrite: true },
    { name: "unknown_scope_fixture", requiresWrite: true },
    { name: "contradictory_scope_fixture", annotations: { readOnlyHint: true, destructiveHint: true }, requiresWrite: true },
  ];
  const orgName = `Connector Search ${Date.now()}`;
  await using den = await server({
    place,
    web: false,
    org: { name: orgName, members: {} },
    mocks: { connector: mcpMock({ port: 3986, allowUnauthenticatedMcp: true, tools: scopeCases.map(({ name, annotations }) => ({
      name, annotations, description: `Scope fixture ${name}`, inputSchema: { type: "object" },
      _meta: { ui: { resourceUri: "ui://scope/fixture.html", visibility: ["model", "app"] } },
      result: { content: [{ type: "text", text: "scope result" }] },
    })) }) },
  });
  const orgs = await denFetch(den.admin, "/v1/me/orgs", { headers: { authorization: `Bearer ${den.admin.token}` } });
  expect(orgs.response.status).toBe(200);
  const orgId = rows(record(orgs.body).orgs).find(org => org.name === orgName)?.id;
  expect(typeof orgId).toBe("string");
  const headers = { authorization: `Bearer ${den.admin.token}`, "x-openwork-org-id": String(orgId) };
  const created = await denFetch(den.admin, "/v1/mcp-connections/by-key/search-intent-notes", {
    method: "PUT", headers,
    body: JSON.stringify({ name: "Notes Search Fixture", url: den.mocks.connector.mcpUrl, authType: "oauth", credentialMode: "per_member", access: { orgWide: true } }),
  });
  expect(created.response.status, created.text).toBe(201);
  const connectionId = record(created.body).id;
  const minted = await denFetch(den.admin, "/v1/mcp/token", { method: "POST", headers, body: "{}" });
  expect(minted.response.status).toBe(200);
  const token = record(minted.body).token;
  if (typeof token !== "string") throw new Error("Missing read-scoped token");
  expect(record(minted.body).scopes).toEqual(["mcp:read"]);
  let requestId = 0;
  async function search(args: Record<string, unknown>) {
    const response = await fetch(`${den.ref.apiUrl}/mcp/agent`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method: "tools/call", params: { name: "search_capabilities", arguments: args } }),
      signal: AbortSignal.timeout(60_000),
    });
    expect(response.status).toBe(200);
    const raw = await response.text();
    const line = raw.split("\n").find(value => value.startsWith("data:"));
    const rpc = record(JSON.parse(line ? line.slice(5) : raw));
    expect(rpc.error).toBeUndefined();
    const result = record(rpc.result);
    expect(result.isError).not.toBe(true);
    const content = rows(result.content);
    const text = content[0]?.text;
    if (typeof text !== "string") throw new Error("Missing search text");
    const payload = record(JSON.parse(text));
    expect(result.structuredContent).toEqual(payload);
    return { result, payload };
  }

  const quiet = await search({ query: "Notes Search Fixture", type: "mcp" });
  expect(rows(quiet.payload.matches).some(match => String(match.name).startsWith(`mcp:${connectionId}:`))).toBe(true);
  expect(quiet.payload.connectionAction).toBeUndefined();
  expect(quiet.payload.connectorCatalog).toBeUndefined();
  expect(quiet.result._meta).toBeUndefined();
  const explicit = await search({ query: "Notes Search Fixture", type: "mcp", intent: "connect" });
  expect(record(explicit.payload.connectionAction).connectionId).toBe(connectionId);
  expect(explicit.payload.connectorCatalog).toBeUndefined();
  evidence.recordAssertionEvidence("Blocked connection discovery stays informational until explicit connect intent", "The same blocked Notes connection appeared in both real gateway searches. Default discovery returned neither action nor catalog nor UI metadata; intent connect returned that connection's action and no unrelated catalog.", true);

  const slackQuiet = await search({ query: "slack" });
  expect(slackQuiet.payload.connectorCatalog).toBeUndefined();
  expect(slackQuiet.payload.connectionAction).toBeUndefined();
  const slack = await search({ query: "slack", intent: "connect" });
  const catalog = record(slack.payload.connectorCatalog);
  expect(catalog.version).toBe(1);
  expect(catalog.selectedIds).toEqual(["slack"]);
  expect(slack.payload.connectionAction).toBeUndefined();
  const entries = rows(catalog.entries);
  const ids = entries.map(entry => entry.id);
  expect(ids).toHaveLength(13);
  expect(new Set(ids).size).toBe(13);
  expect(ids).toEqual(expect.arrayContaining(["slack", "google-workspace", "microsoft-365", "linear"]));
  for (const entry of entries) {
    expect(typeof entry.name).toBe("string");
    const setupUrl = new URL(String(entry.setupUrl));
    expect(["http:", "https:"]).toContain(setupUrl.protocol);
    expect(setupUrl.searchParams.get("quickAdd")).toBe(entry.id);
  }
  evidence.recordAssertionEvidence("Explicit named setup exposes the complete curated catalog without pretending a tool is connected", "Ordinary Slack search returned no setup UI. Explicit connect selected Slack in a versioned 13-entry catalog, including both suites and Linear, with a matching quickAdd setup URL for every entry and no connection action.", true);

  const full = await search({ query: "available services", type: "connectors" });
  const fullCatalog = record(full.payload.connectorCatalog);
  expect(fullCatalog.selectedIds).toEqual([]);
  expect(fullCatalog.entries).toEqual(entries);
  expect(full.payload.matches).toEqual([]);
  expect(full.payload.connectionAction).toBeUndefined();
  evidence.recordAssertionEvidence("Explicit catalog browsing returns all quick adds without selecting or authorizing an account", "type connectors returned all 13 entries, no selected IDs, no executable capability matches, and no connection action.", true);

  // Discovery does not grant mutation authority. Use the same read-scoped
  // token against a healthy synthetic connector, not the private App token.
  const connectionIds: string[] = [];
  for (const exposeDirectly of [false, true]) {
    const response = await denFetch(den.admin, `/v1/mcp-connections/by-key/scope-fixture-${exposeDirectly}`, {
      method: "PUT", headers,
      body: JSON.stringify({ name: `Scope Fixture ${exposeDirectly}`, url: den.mocks.connector.mcpUrl,
        authType: "none", credentialMode: "shared", exposeDirectly, access: { orgWide: true } }),
    });
    expect(response.response.status, response.text).toBe(201);
    const id = record(response.body).id;
    if (typeof id !== "string") throw new Error("Missing scope fixture connection");
    connectionIds.push(id);
  }
  const [compatibilityId, directId] = connectionIds;
  const granted = await denFetch(den.admin, "/v1/mcp/token", {
    method: "POST", headers, body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }),
  });
  expect(granted.response.status, granted.text).toBe(200);
  expect(record(granted.body).scopes).toEqual(["mcp:read", "mcp:write"]);
  const fullToken = record(granted.body).token;
  const appToken = record(minted.body).appHostToken;
  if (typeof fullToken !== "string" || typeof appToken !== "string") throw new Error("Missing scoped control tokens");
  async function call(bearer: string, name: string, args: Record<string, unknown>, endpoint = "/mcp/agent") {
    const response = await fetch(`${den.ref.apiUrl}${endpoint}`, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method: "tools/call", params: { name, arguments: args } }),
      signal: AbortSignal.timeout(60_000),
    });
    const raw = await response.text();
    expect(response.status, raw).toBe(200);
    const line = raw.split("\n").find(value => value.startsWith("data:"));
    const rpc = record(JSON.parse(line ? line.slice(5) : raw));
    expect(rpc.error, JSON.stringify(rpc.error)).toBeUndefined();
    return record(rpc.result);
  }
  const discovered = rows((await search({ query: "Scope Fixture false", type: "mcp", limit: 20 })).payload.matches);
  let deniedCalls = 0;
  let acceptedCalls = 0;
  for (const fixture of scopeCases) {
    const match = discovered.find(entry => entry.name === `mcp:${compatibilityId}:${fixture.name}`);
    if (!match || typeof match.name !== "string" || typeof match.scriptPath !== "string") throw new Error(`Missing ${fixture.name}`);
    const capabilityName = match.name;
    const scriptPath = match.scriptPath;
    const invoke = [
      (bearer: string) => call(bearer, "execute_capability", { name: capabilityName, body: { marker: fixture.name } }),
      (bearer: string) => call(bearer, "execute_capability", { name: fixture.name, body: { marker: fixture.name } }, `/mcp/agent/connections/${compatibilityId}`),
      (bearer: string) => call(bearer, fixture.name, { marker: fixture.name }, `/mcp/agent/connections/${directId}`),
      (bearer: string) => call(bearer, "execute_capability_script", { code: `return await ${scriptPath}({ marker: input.marker })`, input: { marker: fixture.name } }),
    ];
    for (const execute of invoke) {
      for (const bearer of [token, fullToken]) {
        const before = await den.mocks.connector.toolCalls();
        const result = await execute(bearer);
        const after = await den.mocks.connector.toolCalls();
        const text = rows(result.content).find(part => part.type === "text")?.text;
        if (typeof text !== "string") throw new Error("Missing execution result");
        if (bearer === token && fixture.requiresWrite) {
          expect(result.isError).toBe(true);
          expect(text).toContain("mcp:write");
          expect(["insufficient_mcp_scope", "script_failed"]).toContain(record(JSON.parse(text)).error);
          expect(after).toEqual(before);
          deniedCalls += 1;
        } else {
          expect(result.isError, text).not.toBe(true);
          expect(text).toContain("scope result");
          expect(after.slice(before.length)).toEqual([expect.objectContaining({ name: fixture.name, args: { marker: fixture.name } })]);
          acceptedCalls += 1;
        }
      }
    }
    // The separately minted first-party App token deliberately carries both
    // scopes. App-host access must neither bypass scopes nor lose this authority.
    const before = await den.mocks.connector.toolCalls();
    const appResult = await call(appToken, fixture.name, { marker: "app" }, `/mcp/agent/connections/${compatibilityId}`);
    expect(appResult.isError).not.toBe(true);
    expect((await den.mocks.connector.toolCalls()).slice(before.length))
      .toEqual([expect.objectContaining({ name: fixture.name, args: { marker: "app" } })]);
    acceptedCalls += 1;
  }
  expect(deniedCalls).toBe(12);
  expect(acceptedCalls).toBe(24);
  evidence.recordAssertionEvidence("Scoped external execution denies writes without invoking the provider", "A genuinely minted mcp:read token denied explicit, unclassified and contradictory writes through generic, direct, compatibility and Code Mode execution: 12 denials with zero provider calls. Read-only and full-scope controls plus the separately authorized App host produced exactly 24 expected calls.", true);
});
