/**
 * The Apps & tools view as levels a person walks: the root rows, the groups
 * under them, and one item per screen. Each level is a crumb in the panel's
 * route; this module turns crumbs into screens and items into the crumb
 * trails that reach them (so a search result or a receipt opens an item as if
 * it had been navigated to). Pure, so the levels, the search scoping and
 * grouping, and the deep-link targets are unit-tested.
 */
import { CONNECT_MCP_NAME } from "./connect.ts";
import type { ConnectConnection, ConnectPlugin, ConnectSkill } from "./connect-catalog.ts";
import type { CoworkerMcpAppCatalogApp, CoworkerMcpAppCatalogServer } from "./mcp.ts";
import type { PanelCrumb } from "./panel-route.ts";

export const APPS_TOOLS_TITLE = "Apps & tools";

/** The app's own tools for the coworker (documents), registered in every workspace; not something a person set up. */
export const APP_OWN_TOOLS_NAME = "coworker";

/** Servers the person set up, as opposed to the gateway and the app's own tools. */
export function isPersonalTool(item: { name: string }): boolean {
  return item.name !== CONNECT_MCP_NAME && item.name !== APP_OWN_TOOLS_NAME;
}

/** The fixed levels. Items add their own crumb after one of these. */
export const APPS_TOOLS_CRUMBS = {
  connected: { id: "connected", title: "Connected with OpenWork" },
  apps: { id: "apps", title: "Apps" },
  local: { id: "local", title: "Tools on this Mac" },
  connectedApps: { id: "connected-apps", title: "Apps" },
  skills: { id: "skills", title: "Skills" },
  plugins: { id: "plugins", title: "Plugins & marketplaces" },
  connections: { id: "connections", title: "Connections" },
} as const satisfies Record<string, PanelCrumb>;

export type AppsToolsScreen =
  | { kind: "root" }
  | { kind: "connected" }
  | { kind: "connected-apps" }
  | { kind: "skills" }
  | { kind: "plugins" }
  | { kind: "connections" }
  | { kind: "apps" }
  | { kind: "local" }
  | { kind: "app"; key: string }
  | { kind: "tool"; name: string }
  | { kind: "skill"; capability: string }
  | { kind: "plugin"; name: string }
  | { kind: "connection"; id: string }
  /** A tool named by a receipt, not yet matched to an item; the view resolves it once its catalog is read. */
  | { kind: "tool-ref"; tool: string };

/** Which screen a route's path shows: the last crumb decides. */
export function appsToolsScreen(path: PanelCrumb[]): AppsToolsScreen {
  const last = path[path.length - 1];
  if (!last) return { kind: "root" };
  const separator = last.id.indexOf(":");
  const prefix = separator === -1 ? last.id : last.id.slice(0, separator);
  const rest = separator === -1 ? "" : last.id.slice(separator + 1);
  switch (prefix) {
    case "connected": return { kind: "connected" };
    case "connected-apps": return { kind: "connected-apps" };
    case "skills": return { kind: "skills" };
    case "plugins": return { kind: "plugins" };
    case "connections": return { kind: "connections" };
    case "apps": return { kind: "apps" };
    case "local": return { kind: "local" };
    case "app": return { kind: "app", key: rest };
    case "tool": return { kind: "tool", name: rest };
    case "skill": return { kind: "skill", capability: rest };
    case "plugin": return { kind: "plugin", name: rest };
    case "connection": return { kind: "connection", id: rest };
    case "tool-ref": return { kind: "tool-ref", tool: rest };
    default: return { kind: "root" };
  }
}

export type AppSource = "connect" | "local";

/** One App that renders inline, from any source, with what the rows and the detail show. */
export type CatalogApp = {
  key: string;
  title: string;
  description: string;
  source: AppSource;
  /** "OpenWork Connect" or "<tool name> on this Mac". */
  sourceLabel: string;
  /** The server's own display name, or its identifier. */
  serverLabel: string;
  reachable: boolean;
  catalog: CoworkerMcpAppCatalogApp;
  server: CoworkerMcpAppCatalogServer;
};

export function serverLabel(server: Pick<CoworkerMcpAppCatalogServer, "serverName" | "displayName">): string {
  if (server.serverName === CONNECT_MCP_NAME) return "OpenWork Connect";
  return server.displayName?.trim() || server.serverName;
}

/** A server reached through the organization's gateway, rather than set up on this Mac. */
export function isConnectServer(server: Pick<CoworkerMcpAppCatalogServer, "serverName" | "connectionId">): boolean {
  return server.serverName === CONNECT_MCP_NAME || Boolean(server.connectionId);
}

export function appKey(app: Pick<CoworkerMcpAppCatalogApp, "serverName" | "toolName" | "resourceUri">): string {
  return `${app.serverName}:${app.toolName}:${app.resourceUri}`;
}

/** Every App the catalog advertises, flattened, connected ones first. */
export function catalogApps(servers: CoworkerMcpAppCatalogServer[]): CatalogApp[] {
  const apps = servers.flatMap((server) => server.apps.map((catalog): CatalogApp => {
    const source: AppSource = isConnectServer(server) ? "connect" : "local";
    return {
      key: appKey(catalog),
      title: catalog.title?.trim() || catalog.toolName,
      description: catalog.description?.trim() ?? "",
      source,
      sourceLabel: source === "connect" ? "OpenWork Connect" : `${serverLabel(server)} on this Mac`,
      serverLabel: serverLabel(server),
      reachable: server.reachable,
      catalog,
      server,
    };
  }));
  return apps.sort((a, b) => (a.source === b.source ? a.title.localeCompare(b.title) : a.source === "connect" ? -1 : 1));
}

/** Local servers, by name, that advertise inline Apps. */
export function appsForServer(apps: CatalogApp[], serverName: string): CatalogApp[] {
  return apps.filter((app) => app.server.serverName === serverName);
}

/** Every App, whatever its source, is reached through the root's Apps level. */
export function appPath(app: Pick<CatalogApp, "key" | "title">): PanelCrumb[] {
  return [APPS_TOOLS_CRUMBS.apps, { id: `app:${app.key}`, title: app.title }];
}

export function toolPath(name: string): PanelCrumb[] {
  return [APPS_TOOLS_CRUMBS.local, { id: `tool:${name}`, title: name }];
}

export function skillPath(skill: Pick<ConnectSkill, "capability" | "title">): PanelCrumb[] {
  return [APPS_TOOLS_CRUMBS.connected, APPS_TOOLS_CRUMBS.skills, { id: `skill:${skill.capability}`, title: skill.title }];
}

export function pluginPath(plugin: Pick<ConnectPlugin, "name">): PanelCrumb[] {
  return [APPS_TOOLS_CRUMBS.connected, APPS_TOOLS_CRUMBS.plugins, { id: `plugin:${plugin.name}`, title: plugin.name }];
}

export function connectionPath(connection: Pick<ConnectConnection, "id" | "name">): PanelCrumb[] {
  return [APPS_TOOLS_CRUMBS.connected, APPS_TOOLS_CRUMBS.connections, { id: `connection:${connection.id}`, title: connection.name }];
}

/**
 * The trail a receipt opens before the catalog is known: one crumb naming the
 * tool as the receipt did. The view swaps it for the item's real trail.
 */
export function toolRefPath(tool: string, label: string): PanelCrumb[] {
  return [{ id: `tool-ref:${tool}`, title: label }];
}

/** Built-in tools of the AI service never lead to Apps & tools; only a server's tools do. */
export function isServerTool(tool: string): boolean {
  return tool.includes("_") && !/^(?:browser|openwork|coworker)_/.test(tool);
}

/** The tool identifiers the AI service projects for one server: "<server>_<tool>". */
export function toolIdsForServer(toolIds: readonly string[], serverName: string): string[] {
  const prefix = `${serverName.replace(/[^a-zA-Z0-9_-]/g, "_")}_`;
  return toolIds.filter((id) => id.startsWith(prefix)).map((id) => id.slice(prefix.length)).filter(Boolean).sort();
}

/** "open_team_pulse" → "Open team pulse". */
export function humanizeToolName(name: string): string {
  const spaced = name.replaceAll(/[_-]+/g, " ").replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2").trim().toLowerCase();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : name;
}

export type SearchGroup = "apps" | "skills" | "plugins" | "connections" | "local";

export const SEARCH_GROUP_TITLES: Record<SearchGroup, string> = {
  apps: "Apps",
  skills: "Skills",
  plugins: "Plugins & marketplaces",
  connections: "Connections",
  local: "Tools on this Mac",
};

const SEARCH_GROUP_ORDER: SearchGroup[] = ["apps", "skills", "plugins", "connections", "local"];

export type SearchableItem = {
  id: string;
  group: SearchGroup;
  title: string;
  subtitle: string;
  keywords: string[];
  /** The crumb trail that reaches the item, as if navigated. */
  path: PanelCrumb[];
};

/** What a search field means at each level: everything at the root, one group inside it. */
export function searchScope(path: PanelCrumb[]): SearchGroup[] {
  const screen = appsToolsScreen(path);
  switch (screen.kind) {
    case "root": return SEARCH_GROUP_ORDER;
    case "connected": return ["apps", "skills", "plugins", "connections"];
    case "connected-apps":
    case "apps":
    case "app":
      return ["apps"];
    case "skills":
    case "skill":
      return ["skills"];
    case "plugins":
    case "plugin":
      return ["plugins"];
    case "connections":
    case "connection":
      return ["connections"];
    case "local":
    case "tool":
      return ["local"];
    case "tool-ref":
      return SEARCH_GROUP_ORDER;
  }
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

export type SearchResults = Array<{ group: SearchGroup; title: string; items: SearchableItem[] }>;

/** Items matching the query, grouped in a fixed order and limited to the scope. */
export function searchItems(items: readonly SearchableItem[], query: string, scope: readonly SearchGroup[]): SearchResults {
  const needle = normalize(query);
  if (!needle) return [];
  const terms = needle.split(/\s+/).filter(Boolean);
  const matches = items.filter((item) => scope.includes(item.group) && terms.every((term) => [item.title, item.subtitle, ...item.keywords].some((value) => normalize(value).includes(term))));
  return SEARCH_GROUP_ORDER
    .filter((group) => scope.includes(group))
    .map((group) => ({ group, title: SEARCH_GROUP_TITLES[group], items: matches.filter((item) => item.group === group) }))
    .filter((entry) => entry.items.length > 0);
}

/** Only the connected-with-OpenWork groups sit under the Connected level. */
export function isConnectGroup(group: SearchGroup): boolean {
  return group !== "local";
}

/**
 * Where a receipt's tool leads: an App's detail when the tool is one of the
 * catalog's Apps, a local tool's detail when its server is set up on this Mac,
 * the Connected screen for anything through OpenWork Connect. Plain built-in
 * tools lead nowhere.
 */
export function pathForTool(tool: string, index: { apps: readonly CatalogApp[]; localServers: readonly string[] }): PanelCrumb[] | null {
  const trimmed = tool.trim();
  if (!trimmed) return null;
  if (trimmed === CONNECT_MCP_NAME || trimmed.startsWith(`${CONNECT_MCP_NAME}_`)) return [APPS_TOOLS_CRUMBS.connected];
  const app = index.apps.find((candidate) => trimmed === candidate.catalog.projectedToolName
    || trimmed === `${candidate.server.serverName.replace(/[^a-zA-Z0-9_-]/g, "_")}_${candidate.catalog.toolName}`);
  if (app) return appPath(app);
  const server = [...index.localServers]
    .sort((a, b) => b.length - a.length)
    .find((name) => trimmed === name || trimmed.startsWith(`${name.replace(/[^a-zA-Z0-9_-]/g, "_")}_`));
  return server ? toolPath(server) : null;
}

/** Where an App used in a reply leads, by its title as the receipt names it. */
export function pathForAppTitle(title: string, apps: readonly CatalogApp[]): PanelCrumb[] | null {
  const needle = normalize(title);
  if (!needle) return null;
  const app = apps.find((candidate) => normalize(candidate.title) === needle);
  return app ? appPath(app) : null;
}
