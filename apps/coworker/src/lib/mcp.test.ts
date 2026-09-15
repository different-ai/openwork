import assert from "node:assert/strict";
import { test } from "node:test";
import { createCoworkerMcpClient, createCoworkerMcpAppActions, mcpFailureMessage, preservedMcpAppResult, type CoworkerMcpAppContext } from "./mcp.ts";
import { parseSearchMatches } from "./connect-catalog.ts";

const options = { serverUrl: "http://fixture.invalid", workspaceId: "ws_fixture", token: "fixture" };
const app = { serverName: "fixture", toolName: "view", resourceUri: "ui://fixture/view", html: "<p>Fixture</p>", csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] }, prefersBorder: false };

test("gateway search uses the dedicated host route and preserves results and policy failures without an App lease", async (t) => {
  const requests: unknown[] = [];
  const result = { content: [{ type: "text", text: "Available capabilities" }], structuredContent: { matches: [{ name: "fixture:search", kind: "api", summary: "Fixture search" }] }, _meta: { fixture: "preserved" }, isError: false };
  const policyError = { code: "tool_denied", message: "Gateway search is denied by workspace policy.", details: { tool: "openwork-cloud_search_capabilities" } };
  const toolError = { content: [{ type: "text", text: JSON.stringify({ message: "Ask your organization administrator to restore access." }) }], structuredContent: { message: "Connection access is disabled." }, _meta: { fixture: "error-preserved" }, isError: true };
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    assert.equal(request.method, "POST");
    assert.equal(new URL(request.url).pathname, "/workspace/ws_fixture/mcp/openwork-cloud/search");
    assert.equal(request.headers.get("authorization"), "Bearer fixture");
    assert.equal(request.redirect, "error");
    requests.push(await request.json());
    return requests.length === 1 ? Response.json(result) : requests.length === 2 ? Response.json(policyError, { status: 403 }) : Response.json(toolError);
  });
  const client = createCoworkerMcpClient(options);
  const response = await client.searchCapabilities("connection");
  assert.deepEqual(response, result);
  assert.equal(parseSearchMatches(response)[0]?.name, "fixture:search");
  await assert.rejects(client.searchCapabilities("plugin"), { status: 403, ...policyError });
  const failed = await client.searchCapabilities("skill");
  assert.deepEqual(failed, toolError);
  assert.equal(mcpFailureMessage(failed), "Connection access is disabled.\nAsk your organization administrator to restore access.");
  assert.deepEqual(requests, [{ query: "connection" }, { query: "plugin" }, { query: "skill" }]);
});

test("native MCP status and host tool inventory never fall back to v1 or fabricated emptiness", async (t) => {
  const paths: string[] = [];
  let malformed = false;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    paths.push(path);
    if (path.endsWith("/opencode2/api/mcp")) return Response.json({ data: [{ name: "fixture", status: { status: "pending" } }] });
    if (path.endsWith("/mcp/fixture/tools")) return Response.json(malformed ? {} : { tools: [{ name: "search", title: "Search", resourceUri: null }] });
    throw new Error(`Unexpected route: ${path}`);
  });
  const client = createCoworkerMcpClient(options);
  assert.deepEqual(await client.engineStatus(), { fixture: { status: "pending" } });
  assert.deepEqual(await client.listServerTools("fixture"), [{ name: "search", title: "Search", description: null, resourceUri: null }]);
  malformed = true;
  await assert.rejects(client.listServerTools("fixture"), /inventory could not be read/);
  assert.ok(paths.every((path) => !path.includes("/opencode/") && !path.includes("experimental")));
});

test("App leases retain each captured native context, including sessionless and read-only views", async (t) => {
  const requests: Array<{ path: string; body: unknown }> = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    assert.equal(request.redirect, "error");
    const body: unknown = await request.json();
    const path = new URL(request.url).pathname;
    requests.push({ path, body });
    if (path.endsWith("/resolve")) return Response.json({ app: { ...app, launchId: `lease_${requests.length}`, context: { sessionId: "provider-supplied", engine: "v1", readOnly: false } } });
    if (path.endsWith("/release")) return Response.json({ released: true });
    if (path.endsWith("/call")) return Response.json({ content: [{ type: "text", text: "Fixture" }] });
    throw new Error(`Unexpected route: ${path}`);
  });
  const client = createCoworkerMcpClient(options);
  const context: CoworkerMcpAppContext = { sessionId: "ses_original", engine: "v2", readOnly: false };
  const pending = client.resolveApp("fixture_view", context);
  context.sessionId = "changed-after-resolution-started";
  const resolved = (await pending).app;
  const catalogApp = (await client.resolveApp("fixture_view", { sessionId: null, engine: "v2", readOnly: false })).app;
  const readOnly = (await client.resolveApp("fixture_view", { sessionId: "ses_other", engine: "v2", readOnly: true })).app;
  assert.ok(resolved?.launchId && catalogApp?.launchId && readOnly?.launchId);
  assert.deepEqual(resolved.context, { sessionId: "ses_original", engine: "v2", readOnly: false });
  assert.deepEqual(readOnly.context, { sessionId: "ses_other", engine: "v2", readOnly: true });
  const actions = createCoworkerMcpAppActions(client, resolved, () => false);
  const catalogActions = createCoworkerMcpAppActions(client, catalogApp, () => false);
  await catalogActions.callTool("refresh");
  await actions.callTool("refresh");
  const call = { serverName: resolved.serverName, resourceUri: resolved.resourceUri, name: "refresh", engine: "v2" };
  assert.deepEqual(requests.filter((request) => request.path.endsWith("/call")).map((request) => request.body), [
    { ...call, launchId: catalogApp.launchId, sessionId: null },
    { ...call, launchId: resolved.launchId, sessionId: "ses_original" },
  ]);
  actions.dispose();
  const releasing = client.releaseApp(resolved.launchId);
  const before = requests.filter((request) => request.path.endsWith("/call")).length;
  await assert.rejects(actions.callTool("refresh"), /closed or changed/);
  await assert.rejects(createCoworkerMcpAppActions(client, readOnly, () => true).callTool("refresh"), /read-only/);
  assert.equal(requests.filter((request) => request.path.endsWith("/call")).length, before);
  await releasing;
  assert.deepEqual(requests.at(-1)?.body, { launchId: resolved.launchId });
});

test("native content alone cannot manufacture a preserved MCP App envelope", () => {
  const content = [{ type: "text", text: "Fixture" }];
  assert.equal(preservedMcpAppResult({ output: content, metadata: {} }), null);
  const envelope = { content, _meta: { "openwork/mcpApp": { toolName: "view", resourceUri: "ui://fixture/view", arguments: {} } } };
  assert.deepEqual(preservedMcpAppResult({ output: content, metadata: { openworkMcpResult: envelope } }), envelope);
});
