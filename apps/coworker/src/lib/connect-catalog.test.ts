import assert from "node:assert/strict";
import { test } from "node:test";
import { CoworkerMcpError, createCoworkerMcpClient, createCoworkerMcpAppActions, preservedMcpAppResult, type CoworkerMcpAppResource } from "./mcp.ts";
import {
  mergeSearchMatches,
  parseSearchMatches,
  parseSkillIndex,
} from "./connect-catalog.ts";

const statusMatch = {
  name: "mcp:conn_notion:*",
  method: "MCP",
  path: "https://mcp.notion.example",
  score: 3,
  summary: "[Notion] Not connected for this member.",
  pathParams: [],
  queryParams: [],
  hasBody: false,
  kind: "connection_status",
  status: "needs_connection",
  hint: "Execute this exact capability name once.",
  connectionStatus: {
    version: 1,
    kind: "connection_action",
    source: "openwork-cloud",
    connectionId: "conn_notion",
    connectionName: "Notion",
    authType: "oauth",
    credentialMode: "per_member",
    state: "needs_connection",
    actor: "member",
    action: { type: "connect", label: "Connect Notion", surface: "openwork_your_connections", retry: "search_capabilities" },
    message: "Notion is not connected for you yet.",
  },
};

const pluginMatch = {
  name: "plugin:plg_1:cob_1",
  method: "PLUGIN",
  path: "Engineering Marketplace/Release",
  score: 2,
  summary: "[Engineering Marketplace / Release] Release: Versioning and tagging.",
  pathParams: [],
  queryParams: [],
  hasBody: false,
  kind: "skill",
  plugin: "Release",
  marketplace: "Engineering Marketplace",
  status: "needs_admin_setup",
  hint: "Release needs an org admin to configure its required MCP connection.",
  mcpRequirements: [{
    configObjectId: "cob_1",
    pluginId: "plg_1",
    pluginName: "Release",
    serverName: "github",
    name: "GitHub",
    state: "needs_admin_setup",
    action: { type: "setup_connection", label: "Set up GitHub", surface: "openwork_organization_connections", retry: "search_capabilities" },
  }],
};

const appMatch = {
  name: "mcp:conn_pulse:open_team_pulse",
  method: "MCP",
  path: "https://pulse.example/mcp",
  score: 1,
  summary: "[Team pulse] A calm interactive summary.",
  pathParams: [],
  queryParams: [],
  hasBody: true,
  kind: "mcp_app",
  mcpApp: { resourceUri: "ui://pulse/team.html" },
};

test("search results parse from structured content, or from the text fallback, and merge without repeats", () => {
  const structured = parseSearchMatches({ content: [], structuredContent: { matches: [statusMatch, pluginMatch, appMatch, { nope: true }] } });
  assert.deepEqual(structured.map((match) => match.name), [statusMatch.name, pluginMatch.name, appMatch.name]);
  assert.equal(structured[0]?.connectionStatus?.connectionName, "Notion");
  assert.equal(structured[1]?.requirements[0]?.serverName, "github");
  assert.equal(structured[1]?.requirements[0]?.actionSurface, "openwork_organization_connections");
  assert.equal(structured[2]?.resourceUri, "ui://pulse/team.html");
  const fromText = parseSearchMatches({ content: [{ type: "text", text: JSON.stringify({ matches: [appMatch] }) }] });
  assert.equal(fromText.length, 1);
  assert.equal(parseSearchMatches({ content: [{ type: "text", text: "nothing found" }] }).length, 0);
  const merged = mergeSearchMatches([structured, fromText, [structured[0]!]]);
  assert.equal(merged.length, 3);
});

test("the skill index reads into titled skills, built-in ones apart", () => {
  const skills = parseSkillIndex({
    ok: true,
    skills: [
      { name: "release", type: "skill-md", title: "Release", description: "Versioning and tagging.", marketplaceName: "Engineering Marketplace", pluginName: "Release", url: "skill://release", capability: "plugin:plg_1:cob_1" },
      { name: "create-skill", type: "skill-md", title: "Create Skill", description: "Create a new skill.", url: "skill://create-skill", capability: "skill:create-skill" },
      { name: "bad", type: "skill-md", description: "no capability", url: "skill://bad" },
    ],
  });
  assert.deepEqual(skills.map((skill) => [skill.title, skill.builtIn, skill.pluginName]), [["Create Skill", true, ""], ["Release", false, "Release"]]);
  assert.deepEqual(parseSkillIndex(null), []);
  assert.deepEqual(parseSkillIndex({ skills: "x" }), []);
});

const appResource: CoworkerMcpAppResource = {
  launchId: "launch-original",
  context: { sessionId: "session-original", engine: "v1", readOnly: false },
  serverName: "fixture", toolName: "open_fixture", resourceUri: "ui://fixture/view.html", html: "",
  csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] }, prefersBorder: false,
};

test("App launch and action results preserve error flags, typed content and view metadata", async () => {
  for (const isError of [true, false, undefined]) {
    const result = {
      content: [{ type: "audio", data: "Zml4dHVyZQ==", mimeType: "audio/wav" }, { type: "resource_link", uri: "https://example.com/fixture", name: "Fixture" }],
      structuredContent: { status: "fixture" },
      _meta: { viewOnly: "fixture" },
      ...(isError === undefined ? {} : { isError }),
    };
    assert.deepEqual(preservedMcpAppResult({ output: "fallback", metadata: { openworkMcpResult: result } }), result);
    const actions = createCoworkerMcpAppActions({ callAppTool: async () => result }, appResource, () => false);
    assert.deepEqual(await actions.callTool("read_detail"), result);
  }
});

test("App resolution captures host context; discovery and release use their own routes", async (t) => {
  const requests: Array<{ url: string; body: unknown }> = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    requests.push({ url, body: JSON.parse(String(init.body)) });
    return Response.json(url.endsWith("/resolve") ? { app: appResource } : { content: [], released: true });
  });
  const client = createCoworkerMcpClient({ serverUrl: "http://127.0.0.1:1234", workspaceId: "workspace-original", token: "synthetic" });
  const context = { sessionId: "catalog", engine: "v1" as const, readOnly: false };
  const pending = client.resolveApp("fixture_open_fixture", context);
  context.sessionId = "changed-after-resolution-started";
  const { app } = await pending;
  assert.equal(app?.context.sessionId, "catalog", "provider-returned and subsequently mutated context cannot replace the origin");
  await client.searchCapabilities("calendar");
  await client.releaseApp("launch-original");
  assert.deepEqual(requests.map((request) => new URL(request.url).pathname), [
    "/workspace/workspace-original/mcp-apps/resolve",
    "/workspace/workspace-original/mcp/openwork-cloud/search",
    "/workspace/workspace-original/mcp-apps/release",
  ]);
  assert.deepEqual(requests[0]?.body, { projectedToolName: "fixture_open_fixture", context: { sessionId: "catalog", engine: "v1", readOnly: false } });
  assert.deepEqual(requests[1]?.body, { query: "calendar" });
  assert.deepEqual(requests[2]?.body, { launchId: "launch-original" });
});

test("App actions retain the launch, session and server across approval and reject disposed actions", async () => {
  const requests: unknown[] = [];
  const actions = createCoworkerMcpAppActions({ callAppTool: async (request) => {
    requests.push(request);
    if (!request.approved) throw new CoworkerMcpError(403, "tool_requires_approval", "Approval required");
    return { content: [] };
  } }, appResource, () => true);
  await actions.callTool("save", { value: 1 });
  const request = { launchId: "launch-original", sessionId: "session-original", engine: "v1", serverName: "fixture", resourceUri: "ui://fixture/view.html", name: "save", arguments: { value: 1 } };
  assert.deepEqual(requests, [request, { ...request, approved: true }]);
  actions.dispose();
  await assert.rejects(actions.callTool("save"), /closed or changed/);
  assert.equal(requests.length, 2);
});

test("read-only and unleased Apps cannot dispatch; disposing during approval prevents its retry", async () => {
  let calls = 0;
  const client = { callAppTool: async () => {
    calls += 1;
    throw new CoworkerMcpError(403, "tool_requires_approval", "Approval required");
  } };
  const readOnly = createCoworkerMcpAppActions(client, { ...appResource, context: { ...appResource.context, readOnly: true } }, () => true);
  await assert.rejects(readOnly.callTool("save"), /read-only/);
  const unleased = createCoworkerMcpAppActions(client, { ...appResource, launchId: undefined }, () => true);
  await assert.rejects(unleased.callTool("save"), /no live launch context/);
  assert.equal(calls, 0);
  const pending = createCoworkerMcpAppActions(client, appResource, async () => { pending.dispose(); return true; });
  await assert.rejects(pending.callTool("save"), /closed or changed/);
  assert.equal(calls, 1);
});

test("a result arriving after disposal is not accepted or retried", async () => {
  let calls = 0;
  const actions = createCoworkerMcpAppActions({ callAppTool: async () => {
    calls += 1;
    actions.dispose();
    return { content: [] };
  } }, { ...appResource, context: { sessionId: null, engine: "v1", readOnly: false } }, () => true);
  await assert.rejects(actions.callTool("read"), /closed or changed/);
  assert.equal(calls, 1);
});
