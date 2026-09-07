import assert from "node:assert/strict";
import { test } from "node:test";
import {
  APPS_TOOLS_CRUMBS,
  appPath,
  appsToolsScreen,
  catalogApps,
  connectionPath,
  humanizeToolName,
  isServerTool,
  pathForAppTitle,
  pathForTool,
  pluginPath,
  searchItems,
  searchScope,
  skillPath,
  toolIdsForServer,
  toolPath,
  toolRefPath,
  type SearchableItem,
} from "./apps-tools.ts";
import type { CoworkerMcpAppCatalogServer } from "./mcp.ts";

const servers: CoworkerMcpAppCatalogServer[] = [
  {
    serverName: "chapter-notes",
    reachable: true,
    apps: [{ serverName: "chapter-notes", toolName: "open_team_pulse", projectedToolName: "chapter-notes_open_team_pulse", resourceUri: "ui://openwork/coworker/team-pulse.html", title: "Team pulse", description: "A calm summary.", requiresInput: false, requiresApproval: false }],
  },
  {
    serverName: "openwork-cloud__conn_1",
    displayName: "Skill studio",
    connectionId: "conn_1",
    reachable: true,
    apps: [{ serverName: "openwork-cloud__conn_1", connectionId: "conn_1", toolName: "skill_studio", projectedToolName: "openwork-cloud__conn_1_skill_studio", resourceUri: "ui://openwork-connect/skill-studio", title: null, description: null, requiresInput: false, requiresApproval: false }],
  },
];

test("the last crumb decides the screen", () => {
  assert.deepEqual(appsToolsScreen([]), { kind: "root" });
  assert.deepEqual(appsToolsScreen([APPS_TOOLS_CRUMBS.connected]), { kind: "connected" });
  assert.deepEqual(appsToolsScreen([APPS_TOOLS_CRUMBS.connected, APPS_TOOLS_CRUMBS.skills]), { kind: "skills" });
  assert.deepEqual(appsToolsScreen(skillPath({ capability: "skill:create-skill", title: "Create Skill" })), { kind: "skill", capability: "skill:create-skill" });
  assert.deepEqual(appsToolsScreen(appPath({ key: "a:b:ui://c", title: "T" })), { kind: "app", key: "a:b:ui://c" });
  assert.deepEqual(appsToolsScreen(toolPath("chapter-notes")), { kind: "tool", name: "chapter-notes" });
  assert.deepEqual(appsToolsScreen(pluginPath({ name: "Release" })), { kind: "plugin", name: "Release" });
  assert.deepEqual(appsToolsScreen(connectionPath({ id: "conn_1", name: "Notion" })), { kind: "connection", id: "conn_1" });
  assert.deepEqual(appsToolsScreen([{ id: "mystery", title: "?" }]), { kind: "root" });
  assert.deepEqual(appsToolsScreen(toolRefPath("chapter-notes_open_team_pulse", "Used Team pulse")), { kind: "tool-ref", tool: "chapter-notes_open_team_pulse" });
});

test("only a server's tools lead from a receipt into Apps & tools", () => {
  assert.ok(isServerTool("chapter-notes_open_team_pulse"));
  assert.ok(isServerTool("openwork-cloud_search_capabilities"));
  assert.ok(!isServerTool("read"));
  assert.ok(!isServerTool("browser_click"));
  assert.ok(!isServerTool("openwork_context"));
  assert.ok(!isServerTool("coworker_document_create"));
});

test("the catalog flattens into Apps with a source line, connected ones first", () => {
  const apps = catalogApps(servers);
  assert.deepEqual(apps.map((app) => [app.title, app.source, app.sourceLabel]), [
    ["skill_studio", "connect", "OpenWork Connect"],
    ["Team pulse", "local", "chapter-notes on this Mac"],
  ]);
  assert.equal(apps[1]?.key, "chapter-notes:open_team_pulse:ui://openwork/coworker/team-pulse.html");
  assert.deepEqual(appPath(apps[1]!).map((crumb) => crumb.title), ["Apps", "Team pulse"]);
});

test("item trails read as if navigated: root → group → item", () => {
  assert.deepEqual(skillPath({ capability: "skill:create-skill", title: "Create Skill" }).map((crumb) => crumb.title), ["Connected with OpenWork", "Skills", "Create Skill"]);
  assert.deepEqual(pluginPath({ name: "Release" }).map((crumb) => crumb.id), ["connected", "plugins", "plugin:Release"]);
  assert.deepEqual(connectionPath({ id: "conn_1", name: "Notion" }).map((crumb) => crumb.title), ["Connected with OpenWork", "Connections", "Notion"]);
  assert.deepEqual(toolPath("chapter-notes").map((crumb) => crumb.title), ["Tools on this Mac", "chapter-notes"]);
});

test("tool identifiers are grouped per server and read in plain words", () => {
  const ids = ["chapter-notes_open_team_pulse", "chapter-notes_list_chapters", "my_server_run", "read", "openwork-cloud_search_capabilities"];
  assert.deepEqual(toolIdsForServer(ids, "chapter-notes"), ["list_chapters", "open_team_pulse"]);
  assert.deepEqual(toolIdsForServer(ids, "my server"), ["run"]);
  assert.deepEqual(toolIdsForServer(ids, "nothing"), []);
  assert.equal(humanizeToolName("open_team_pulse"), "Open team pulse");
  assert.equal(humanizeToolName("listChapters"), "List chapters");
  assert.equal(humanizeToolName("search-capabilities"), "Search capabilities");
});

const items: SearchableItem[] = [
  { id: "app:pulse", group: "apps", title: "Team pulse", subtitle: "chapter-notes on this Mac", keywords: ["team activity"], path: appPath({ key: "k", title: "Team pulse" }) },
  { id: "skill:create-skill", group: "skills", title: "Create Skill", subtitle: "Built in", keywords: [], path: skillPath({ capability: "skill:create-skill", title: "Create Skill" }) },
  { id: "plugin:Release", group: "plugins", title: "Release", subtitle: "Engineering Marketplace", keywords: ["versioning"], path: pluginPath({ name: "Release" }) },
  { id: "connection:notion", group: "connections", title: "Notion", subtitle: "Needs sign-in", keywords: [], path: connectionPath({ id: "notion", name: "Notion" }) },
  { id: "tool:chapter-notes", group: "local", title: "chapter-notes", subtitle: "Connected", keywords: ["team pulse"], path: toolPath("chapter-notes") },
];

test("search scopes to the level it sits in and groups what it finds in a fixed order", () => {
  assert.deepEqual(searchScope([]), ["apps", "skills", "plugins", "connections", "local"]);
  assert.deepEqual(searchScope([APPS_TOOLS_CRUMBS.connected]), ["apps", "skills", "plugins", "connections"]);
  assert.deepEqual(searchScope([APPS_TOOLS_CRUMBS.connected, APPS_TOOLS_CRUMBS.skills]), ["skills"]);
  assert.deepEqual(searchScope(toolPath("x")), ["local"]);
  assert.deepEqual(searchScope([APPS_TOOLS_CRUMBS.apps]), ["apps"]);

  const everywhere = searchItems(items, "pulse", searchScope([]));
  assert.deepEqual(everywhere.map((group) => [group.title, group.items.map((item) => item.title)]), [["Apps", ["Team pulse"]], ["Tools on this Mac", ["chapter-notes"]]]);
  const localOnly = searchItems(items, "pulse", searchScope([APPS_TOOLS_CRUMBS.local]));
  assert.deepEqual(localOnly.map((group) => group.group), ["local"]);
  assert.deepEqual(searchItems(items, "team activity", searchScope([])).map((group) => group.group), ["apps"]);
  assert.deepEqual(searchItems(items, "release versioning", searchScope([APPS_TOOLS_CRUMBS.connected])).map((group) => group.group), ["plugins"]);
  assert.deepEqual(searchItems(items, "", searchScope([])), []);
  assert.deepEqual(searchItems(items, "zzz", searchScope([])), []);
  // A result carries the crumb trail as if navigated.
  assert.deepEqual(everywhere[0]?.items[0]?.path.map((crumb) => crumb.title), ["Apps", "Team pulse"]);
});

test("a receipt's tool leads to the App, the local tool, or the Connected screen", () => {
  const apps = catalogApps(servers);
  const index = { apps, localServers: ["chapter-notes", "my server"] };
  assert.deepEqual(pathForTool("chapter-notes_open_team_pulse", index)?.map((crumb) => crumb.title), ["Apps", "Team pulse"]);
  assert.deepEqual(pathForTool("chapter-notes_list_chapters", index)?.map((crumb) => crumb.title), ["Tools on this Mac", "chapter-notes"]);
  assert.deepEqual(pathForTool("my_server_run", index)?.map((crumb) => crumb.id), ["local", "tool:my server"]);
  assert.deepEqual(pathForTool("openwork-cloud_execute_capability", index)?.map((crumb) => crumb.id), ["connected"]);
  assert.equal(pathForTool("read", index), null);
  assert.equal(pathForTool("", index), null);
  assert.deepEqual(pathForAppTitle("team pulse", apps)?.map((crumb) => crumb.title), ["Apps", "Team pulse"]);
  assert.equal(pathForAppTitle("Nothing", apps), null);
});
