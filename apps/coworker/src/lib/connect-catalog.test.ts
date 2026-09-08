import assert from "node:assert/strict";
import { test } from "node:test";
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
