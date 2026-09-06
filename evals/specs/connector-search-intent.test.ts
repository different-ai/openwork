import { expect } from "vitest";
import { denFetch } from "@openwork/behaviors";
import { mcpMock, server, test } from "@openwork/testkit";

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
test("gateway discovery stays quiet until connection setup is explicitly requested", { timeout: 300_000 }, async ({ evidence, place }) => {
  const orgName = `Connector Search ${Date.now()}`;
  await using den = await server({
    place,
    web: false,
    org: { name: orgName, members: {} },
    mocks: { connector: mcpMock({ port: 3986 }) },
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
  expect(typeof token).toBe("string");
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
  expect(entries.find(entry => entry.id === "slack")?.description).toContain("Agents settings");
  expect(entries.find(entry => entry.id === "slack")?.description).toContain("OAuth authorization alone does not make MCP ready");
  expect(entries.find(entry => entry.id === "linear")?.description).not.toContain("Agents settings");
  evidence.recordAssertionEvidence("Slack catalog setup distinguishes authorization from MCP readiness", "Slack describes the Agents prerequisite and OAuth distinction; Linear does not receive Slack guidance.", true);
  const ids = entries.map(entry => entry.id);
  expect(ids).toHaveLength(12);
  expect(new Set(ids).size).toBe(12);
  expect(ids).toEqual(expect.arrayContaining(["slack", "google-workspace", "microsoft-365", "linear"]));
  for (const entry of entries) {
    expect(typeof entry.name).toBe("string");
    const setupUrl = new URL(String(entry.setupUrl));
    expect(["http:", "https:"]).toContain(setupUrl.protocol);
    expect(setupUrl.searchParams.get("quickAdd")).toBe(entry.id);
  }
  evidence.recordAssertionEvidence("Explicit named setup exposes the complete curated catalog without pretending a tool is connected", "Ordinary Slack search returned no setup UI. Explicit connect selected Slack in a versioned 12-entry catalog, including both suites and Linear, with a matching quickAdd setup URL for every entry and no connection action.", true);

  const full = await search({ query: "available services", type: "connectors" });
  const fullCatalog = record(full.payload.connectorCatalog);
  expect(fullCatalog.selectedIds).toEqual([]);
  expect(fullCatalog.entries).toEqual(entries);
  expect(full.payload.matches).toEqual([]);
  expect(full.payload.connectionAction).toBeUndefined();
  evidence.recordAssertionEvidence("Explicit catalog browsing returns all quick adds without selecting or authorizing an account", "type connectors returned all 12 entries, no selected IDs, no executable capability matches, and no connection action.", true);
});
