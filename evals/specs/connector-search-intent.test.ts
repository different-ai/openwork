import { createHash } from "node:crypto";
import { expect } from "vitest";
import { denFetch } from "@openwork/behaviors";
import { queryDenDatabase } from "@openwork/env";
import { mcpMock, needs, server, test } from "@openwork/testkit";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected an object");
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
    { name: "misleading_read_scope_fixture", annotations: { readOnlyHint: true, destructiveHint: false } },
    { name: "write_scope_fixture", annotations: { readOnlyHint: false, destructiveHint: false } },
    { name: "unknown_scope_fixture" },
    { name: "contradictory_scope_fixture", annotations: { readOnlyHint: true, destructiveHint: true } },
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
  const database = den.database;
  if (!database) throw new Error("Scope authority fixtures require a cold-booted owned Den database");
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
  expect(quiet.payload.connectors).toBeUndefined();
  expect(quiet.result._meta).toBeUndefined();
  const explicit = await search({ query: "Notes Search Fixture", type: "mcp", intent: "connect" });
  expect(record(explicit.payload.connectionAction).connectionId).toBe(connectionId);
  expect(explicit.payload.connectorCatalog).toBeUndefined();
  expect(explicit.payload.connectors).toBeUndefined();
  expect(explicit.result._meta).toMatchObject({ "openwork/mcpApp": { toolName: "connection_action", arguments: { connectionId } } });
  evidence.recordAssertionEvidence("Blocked connection discovery stays informational until explicit connect intent", "The same blocked Notes connection appeared in both real gateway searches. Default discovery returned neither action nor catalog nor UI metadata; intent connect returned that connection's action and no unrelated catalog.", true);

  const slackQuiet = await search({ query: "slack" });
  expect(slackQuiet.payload.connectorCatalog).toBeUndefined();
  expect(slackQuiet.payload.connectors).toBeUndefined();
  expect(slackQuiet.payload.connectionAction).toBeUndefined();
  expect(slackQuiet.result._meta).toBeUndefined();
  const slack = await search({ query: "slack", intent: "connect" });
  expect(slack.payload.connectors).toBeUndefined();
  expect(slack.payload.connectorCatalog).toMatchObject({ version: 1, selectedIds: ["slack"] });
  expect(slack.payload.connectionAction).toBeUndefined();
  expect(slack.result._meta).toBeUndefined();
  evidence.recordAssertionEvidence("Named setup retains released-client suggestions without inventing a connection", "An unconfigured Slack search with explicit connect intent returned the legacy catalog selecting Slack, without a connection action or UI launch metadata. Ordinary discovery stayed quiet; modern clients suppress catalog presentation.", true);

  const full = await search({ query: "available services", type: "connectors" });
  const catalog = record(full.payload.connectorCatalog);
  expect(catalog.version).toBe(1);
  expect(catalog.selectedIds).toEqual([]);
  const entries = rows(catalog.entries);
  expect(record(slack.payload.connectorCatalog).entries).toEqual(entries);
  for (const type of ["all", "mcp"]) {
    const named = await search({ query: "Slack", type, intent: "connect" });
    expect(named.payload.connectorCatalog).toEqual(slack.payload.connectorCatalog);
  }
  for (const type of ["api", "admin", "marketplace", "skills"]) {
    const excluded = await search({ query: "Slack", type, intent: "connect" });
    expect(excluded.payload.connectorCatalog).toBeUndefined();
  }
  const unknown = await search({ query: "unknown-service", intent: "connect" });
  expect(unknown.payload.connectorCatalog).toBeUndefined();
  const generic = await search({ query: "quick add connectors", intent: "connect" });
  expect(generic.payload.connectorCatalog).toEqual(catalog);
  const ids = entries.map(entry => entry.id);
  expect(ids).toHaveLength(13);
  expect(new Set(ids).size).toBe(13);
  expect(ids).toEqual(expect.arrayContaining(["slack", "google-workspace", "microsoft-365", "linear"]));
  expect(entries.filter(entry => entry.id === "slack")).toEqual([expect.objectContaining({ name: "Slack", setup: "oauth_client" })]);
  for (const entry of entries) {
    expect(typeof entry.name).toBe("string");
    expect(typeof entry.description).toBe("string");
    expect(["suite", "oauth_client", "api_key", "instant", "oauth"]).toContain(entry.setup);
    const setupUrl = new URL(String(entry.setupUrl));
    expect(["http:", "https:"]).toContain(setupUrl.protocol);
    expect(setupUrl.pathname).toBe("/dashboard/mcp-connections");
    expect(setupUrl.searchParams.get("quickAdd")).toBe(entry.id);
  }
  expect(full.payload.connectors).toBeUndefined();
  expect(full.payload.matches).toEqual([]);
  expect(full.payload.connectionAction).toBeUndefined();
  expect(full.result._meta).toBeUndefined();
  expect(await den.mocks.connector.toolCalls()).toEqual([]);
  expect((await den.mocks.connector.requests()).filter(entry => entry.path === "/authorize" || entry.path === "/token")).toEqual([]);
  evidence.recordAssertionEvidence("Explicit connector browsing returns all quick adds as ordinary metadata without authorizing an account", "type connectors returned all 13 setup entries with valid setup URLs, the legacy version 1 catalog envelope with no selected IDs, no executable matches, no connection action or UI metadata, and no provider or OAuth calls.", true);

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
  const restrictedAppToken = record(granted.body).appHostToken;
  if (typeof fullToken !== "string" || typeof appToken !== "string" || typeof restrictedAppToken !== "string") throw new Error("Missing scoped control tokens");
  // The public mint cannot request a write-less App token. Narrow only this
  // unused, genuinely minted token in the owned database; do not change mint policy.
  if (!restrictedAppToken.startsWith("ow_mcp_at_")) throw new Error("Expected an opaque first-party App token");
  const appTokenHash = createHash("sha256").update(restrictedAppToken.slice("ow_mcp_at_".length)).digest("base64url");
  const restrictedScopes = JSON.stringify(["mcp:read", "mcp:app-host"]);
  await queryDenDatabase(database.url, "UPDATE oauthAccessToken SET scopes = ? WHERE token = ? AND reference_id = ?",
    [restrictedScopes, appTokenHash, String(orgId)]);
  expect(await queryDenDatabase(database.url, "SELECT scopes FROM oauthAccessToken WHERE token = ? AND reference_id = ?",
    [appTokenHash, String(orgId)])).toEqual([{ scopes: restrictedScopes }]);
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
  const beforeReadControls = await den.mocks.connector.toolCalls();
  const status = await call(token, "execute_capability", { name: `mcp:${compatibilityId}:*` });
  expect(status.isError).not.toBe(true);
  expect(status.structuredContent).toMatchObject({ connectionId: compatibilityId, state: "connected" });
  for (const bearer of [token, restrictedAppToken]) {
    const discovery = await call(bearer, "search_capabilities", { query: "scope fixture", limit: 20 }, `/mcp/agent/connections/${compatibilityId}`);
    expect(discovery.isError).not.toBe(true);
    const matches = rows(record(discovery.structuredContent).matches);
    expect(matches.map(entry => entry.name).sort()).toEqual(scopeCases.map(entry => entry.name).sort());
    if (bearer === restrictedAppToken) {
      for (const match of matches) expect(match.mcpApp).toMatchObject({ resourceUri: "ui://scope/fixture.html" });
    }
  }
  const nativeRead = rows((await search({ query: "list workers", type: "api", limit: 20 })).payload.matches)
    .find(entry => entry.method === "GET" && entry.path === "/v1/workers");
  if (!nativeRead || typeof nativeRead.name !== "string" || typeof nativeRead.scriptPath !== "string") throw new Error("Missing native API read control");
  expect((await call(token, "execute_capability", { name: nativeRead.name })).isError).not.toBe(true);
  expect((await call(token, "execute_capability_script", { code: `return await ${nativeRead.scriptPath}({})` })).isError).not.toBe(true);
  expect((await call(token, "execute_capability_script", { code: "return 1 + 1" })).content).toEqual([{ type: "text", text: "2" }]);
  expect(await den.mocks.connector.toolCalls()).toEqual(beforeReadControls);
  evidence.recordAssertionEvidence("Read scope still permits discovery, status, and native API reads", "The read-only token discovered external tools, read connected status, invoked GET /v1/workers directly and in Code Mode, and computed a pure script without any external provider tool call. The downscoped App token also discovered App bindings, proving the real authenticated App audience was reached.", true);
  let deniedCalls = 0;
  let acceptedCalls = 0;
  for (const fixture of scopeCases) {
    const match = discovered.find(entry => entry.name === `mcp:${compatibilityId}:${fixture.name}`);
    if (!match || typeof match.name !== "string" || typeof match.scriptPath !== "string") throw new Error(`Missing ${fixture.name}`);
    const capabilityName = match.name;
    const scriptPath = match.scriptPath;
    const invoke: { tokens: string[]; execute: (bearer: string) => Promise<Record<string, unknown>> }[] = [
      { tokens: [token, fullToken], execute: (bearer: string) => call(bearer, "execute_capability", { name: capabilityName, body: { marker: fixture.name } }) },
      { tokens: [token, fullToken], execute: (bearer: string) => call(bearer, "execute_capability", { name: fixture.name, body: { marker: fixture.name } }, `/mcp/agent/connections/${compatibilityId}`) },
      { tokens: [token, fullToken], execute: (bearer: string) => call(bearer, fixture.name, { marker: fixture.name }, `/mcp/agent/connections/${directId}`) },
      { tokens: [token, fullToken], execute: (bearer: string) => call(bearer, "execute_capability_script", { code: `return await ${scriptPath}({ marker: input.marker })`, input: { marker: fixture.name } }) },
      { tokens: [restrictedAppToken, appToken], execute: (bearer: string) => call(bearer, fixture.name, { marker: fixture.name }, `/mcp/agent/connections/${compatibilityId}`) },
      { tokens: [restrictedAppToken, appToken], execute: (bearer: string) => call(bearer, "execute_capability", { name: fixture.name, body: { marker: fixture.name } }, `/mcp/agent/connections/${compatibilityId}`) },
    ];
    for (const { execute, tokens } of invoke) {
      for (const bearer of tokens) {
        const before = await den.mocks.connector.toolCalls();
        const result = await execute(bearer);
        const after = await den.mocks.connector.toolCalls();
        const text = rows(result.content).find(part => part.type === "text")?.text;
        if (typeof text !== "string") throw new Error("Missing execution result");
        if (bearer === token || bearer === restrictedAppToken) {
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
  }
  expect(deniedCalls).toBe(24);
  expect(acceptedCalls).toBe(24);
  evidence.recordAssertionEvidence("Provider read-only hints never grant external execution authority", "Read-only tokens denied all four provider tools, including the misleading readOnlyHint:true tool, through generic, direct, compatibility, Code Mode and both App-host dispatch forms: 24 denials with zero provider calls. A genuinely minted App token was narrowed to mcp:read mcp:app-host in this owned database before first use, not issued by a changed production mint. Full-scope and unchanged App-host tokens produced exactly 24 expected calls.", true);
});
