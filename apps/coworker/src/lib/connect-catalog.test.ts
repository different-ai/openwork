import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildConnectCatalog,
  collectConnections,
  groupPlugins,
  mergeSearchMatches,
  parseSearchMatches,
  parseSkillIndex,
  type GatewaySearchMatch,
} from "./connect-catalog.ts";
import type { CoworkerMcpAppCatalogServer } from "./mcp.ts";

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

test("plugins group their skills and carry each declared service's readiness in plain words", () => {
  const skills = parseSkillIndex({
    skills: [
      { name: "release", title: "Release", description: "", marketplaceName: "Engineering Marketplace", pluginName: "Release", url: "skill://release", capability: "plugin:plg_1:cob_1" },
      { name: "notes", title: "Notes", description: "", marketplaceName: "Engineering Marketplace", pluginName: "Release", url: "skill://notes", capability: "plugin:plg_1:cob_2" },
      { name: "ship", title: "Ship", description: "", pluginName: "Shipping", url: "skill://ship", capability: "plugin:plg_2:cob_3" },
      { name: "create-skill", title: "Create Skill", description: "", url: "skill://create-skill", capability: "skill:create-skill" },
    ],
  });
  const matches: GatewaySearchMatch[] = parseSearchMatches({ content: [], structuredContent: { matches: [pluginMatch] } });
  const plugins = groupPlugins(skills, matches);
  assert.deepEqual(plugins.map((plugin) => plugin.name), ["Release", "Shipping"]);
  const release = plugins[0]!;
  assert.deepEqual(release.skills.map((skill) => skill.title), ["Notes", "Release"]);
  assert.equal(release.marketplaceName, "Engineering Marketplace");
  assert.equal(release.readiness.label, "Needs setup by an admin");
  assert.deepEqual(release.servers.map((server) => [server.name, server.title, server.readiness.label]), [["github", "GitHub", "Needs setup by an admin"]]);
  assert.equal(release.servers[0]?.humanAction, "Ask an organization admin to set up GitHub on the organization's Connections dashboard in OpenWork.");
  // A plugin the search never mentioned is simply ready.
  assert.equal(plugins[1]?.readiness.label, "Ready");
  assert.deepEqual(plugins[1]?.servers, []);
});

test("connections combine the catalog's reachable ones with the search's statuses, live status winning", () => {
  const servers: CoworkerMcpAppCatalogServer[] = [
    { serverName: "openwork-cloud", reachable: true, apps: [] },
    { serverName: "openwork-cloud__conn_pulse", displayName: "Team pulse", connectionId: "conn_pulse", reachable: true, apps: [{ serverName: "x", toolName: "t", projectedToolName: "x_t", resourceUri: "ui://x", title: "T", description: null, requiresInput: false, requiresApproval: false }] },
    { serverName: "openwork-cloud__conn_notion", displayName: "Notion", connectionId: "conn_notion", reachable: true, apps: [] },
    { serverName: "chapter-notes", reachable: true, apps: [] },
  ];
  const matches = parseSearchMatches({ content: [], structuredContent: { matches: [statusMatch, pluginMatch] } });
  const connections = collectConnections(servers, matches);
  assert.deepEqual(connections.map((connection) => [connection.name, connection.words.label, connection.appCount]), [
    ["Notion", "Needs sign-in", 0],
    ["Team pulse", "Connected", 1],
  ]);
  assert.equal(connections[0]?.words.humanAction, "Connect Notion on your Connections page in OpenWork.");
  // Unreachable catalog servers read Not connected with the admin dashboard as the place to look.
  const down = collectConnections([{ serverName: "openwork-cloud__conn_x", displayName: "Drive", connectionId: "conn_x", reachable: false, error: "503", apps: [] }], []);
  assert.equal(down[0]?.words.label, "Not connected");
  assert.equal(down[0]?.words.humanAction, "Check Drive on the organization's Connections dashboard in OpenWork.");
  const catalog = buildConnectCatalog({ skills: [], matches, servers });
  assert.equal(catalog.connections.length, 2);
  assert.equal(catalog.plugins.length, 1);
});
