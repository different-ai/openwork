/**
 * What OpenWork Connect brings to a coworker, as browsable lists: the skills
 * the member can use (from the gateway's skill index), the plugins and
 * marketplaces those skills come from, and the organization's connections
 * with their live status. The gateway has no "list everything" call, so the
 * connections and plugin readiness come from its search with a few keyword
 * variants, merged and deduplicated here. Pure parsing and grouping, so the
 * shapes the panel renders are unit-tested against recorded gateway results.
 */
import { CONNECT_MCP_NAME } from "./connect.ts";
import {
  connectionStatusWords,
  parseCloudConnectionStatus,
  readinessWords,
  type CloudConnectionStatus,
  type ConnectionWords,
  type PlainStatus,
} from "./connection-words.ts";
import type { CoworkerMcpAppCatalogServer, PreservedMcpAppResult } from "./mcp.ts";

/** Keyword variants that together cover what a browsing person expects to find. */
export const CONNECT_SEARCH_VARIANTS = ["connection", "skill", "plugin", "app"] as const;

/** One service a marketplace plugin declares, and whether the member can use it in OpenWork Cloud. */
export type GatewayRequirement = {
  serverName: string;
  /** How the plugin names the service, falling back to the server identifier. */
  title: string;
  /** The connection the organization set up for it, when there is one. */
  connectionName: string;
  state: string;
  /** What the gateway says a person should do, verbatim. */
  actionLabel: string;
  actionSurface: string;
};

export type GatewaySearchMatch = {
  name: string;
  kind: string;
  summary: string;
  status: string;
  hint: string;
  plugin: string;
  marketplace: string;
  resourceUri: string;
  requirements: GatewayRequirement[];
  connectionStatus: CloudConnectionStatus | null;
};

function readAsRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function requirementFrom(value: unknown): GatewayRequirement | null {
  const record = readAsRecord(value);
  if (!record) return null;
  const serverName = text(record.serverName) || text(record.name);
  if (!serverName) return null;
  const action = readAsRecord(record.action);
  return {
    serverName,
    title: text(record.name) || serverName,
    connectionName: text(record.connectionName),
    state: text(record.state),
    actionLabel: text(action?.label),
    actionSurface: text(action?.surface),
  };
}

function matchFrom(value: unknown): GatewaySearchMatch | null {
  const record = readAsRecord(value);
  if (!record || typeof record.name !== "string" || !record.name.trim()) return null;
  const mcpApp = readAsRecord(record.mcpApp);
  const requirements = Array.isArray(record.mcpRequirements)
    ? record.mcpRequirements.map(requirementFrom).filter((entry): entry is GatewayRequirement => entry !== null)
    : [];
  return {
    name: record.name.trim(),
    kind: text(record.kind),
    summary: text(record.summary),
    status: text(record.status),
    hint: text(record.hint),
    plugin: text(record.plugin),
    marketplace: text(record.marketplace),
    resourceUri: text(mcpApp?.resourceUri),
    requirements,
    connectionStatus: parseCloudConnectionStatus(record.connectionStatus),
  };
}

/** The matches inside one `search_capabilities` result, from its structured content or its text. */
export function parseSearchMatches(result: PreservedMcpAppResult): GatewaySearchMatch[] {
  const fromStructured = Array.isArray(result.structuredContent?.matches) ? result.structuredContent.matches : null;
  let raw: unknown[] = fromStructured ?? [];
  if (!fromStructured) {
    for (const item of result.content) {
      if (item.type !== "text" || typeof item.text !== "string") continue;
      try {
        const parsed: unknown = JSON.parse(item.text);
        const record = readAsRecord(parsed);
        if (record && Array.isArray(record.matches)) {
          raw = record.matches;
          break;
        }
      } catch {
        // A plain-text answer carries no matches.
      }
    }
  }
  return raw.map(matchFrom).filter((match): match is GatewaySearchMatch => match !== null);
}

/** Merge several searches, keeping the first sight of each capability. */
export function mergeSearchMatches(results: GatewaySearchMatch[][]): GatewaySearchMatch[] {
  const seen = new Map<string, GatewaySearchMatch>();
  for (const batch of results) {
    for (const match of batch) if (!seen.has(match.name)) seen.set(match.name, match);
  }
  return [...seen.values()];
}

export type ConnectSkill = {
  /** The stable machine name, e.g. "create-skill". */
  name: string;
  title: string;
  description: string;
  pluginName: string;
  marketplaceName: string;
  /** The exact capability to execute, e.g. "skill:create-skill" or "plugin:plg_…:cob_…". */
  capability: string;
  builtIn: boolean;
};

/** The skill index the embedded server reads through the coworker's gateway (`GET /experimental/connect/skills`). */
export function parseSkillIndex(payload: unknown): ConnectSkill[] {
  const record = readAsRecord(payload);
  if (!record || !Array.isArray(record.skills)) return [];
  const skills: ConnectSkill[] = [];
  for (const entry of record.skills) {
    const skill = readAsRecord(entry);
    if (!skill) continue;
    const name = text(skill.name);
    const capability = text(skill.capability);
    if (!name || !capability) continue;
    skills.push({
      name,
      title: text(skill.title) || name,
      description: text(skill.description),
      pluginName: text(skill.pluginName),
      marketplaceName: text(skill.marketplaceName),
      capability,
      builtIn: capability.startsWith("skill:"),
    });
  }
  return skills.sort((a, b) => a.title.localeCompare(b.title));
}

export type ConnectPluginServer = {
  /** The server identifier, for Technical details. */
  name: string;
  /** How the plugin names the service. */
  title: string;
  /** The organization connection standing in for it, when set up. */
  connectionName: string;
  readiness: PlainStatus;
  /** The step that unblocks it, in plain words; empty when it is ready. */
  humanAction: string;
};

export type ConnectPlugin = {
  name: string;
  marketplaceName: string;
  skills: ConnectSkill[];
  /** Other things the plugin offers that the search saw (commands, workflows, tools), by kind. */
  otherKinds: string[];
  servers: ConnectPluginServer[];
  /** The plugin as a whole: as ready as its least ready server. */
  readiness: PlainStatus;
};

function readinessRank(status: PlainStatus): number {
  if (status.tone === "mint") return 0;
  if (status.tone === "mist") return 1;
  return 2;
}

function worst(statuses: PlainStatus[]): PlainStatus {
  return statuses.reduce<PlainStatus>((current, next) => (readinessRank(next) > readinessRank(current) ? next : current), readinessWords("ready"));
}

const REQUIREMENT_SURFACES: Record<string, string> = {
  openwork_your_connections: "your Connections page in OpenWork",
  openwork_organization_connections: "the organization's Connections dashboard in OpenWork",
};

function requirementAction(requirement: GatewayRequirement): string {
  const words = readinessWords(requirement.state);
  if (words.tone === "mint") return "";
  const where = REQUIREMENT_SURFACES[requirement.actionSurface];
  const label = requirement.actionLabel || (requirement.state === "needs_admin_setup" ? "Set it up" : "Connect it");
  if (requirement.state === "needs_admin_setup") return `Ask an organization admin to set up ${requirement.title}${where ? ` on ${where}` : ""}.`;
  return `${label}${where ? ` on ${where}` : ""}.`;
}

/**
 * The organization's plugins: every plugin the skill index names, enriched
 * with what the search reported about the same plugin (its readiness and the
 * services it declares). Built-in skills form no plugin.
 */
export function groupPlugins(skills: ConnectSkill[], matches: GatewaySearchMatch[]): ConnectPlugin[] {
  const plugins = new Map<string, ConnectPlugin>();
  const ensure = (name: string, marketplaceName: string): ConnectPlugin => {
    const existing = plugins.get(name);
    if (existing) {
      if (!existing.marketplaceName && marketplaceName) existing.marketplaceName = marketplaceName;
      return existing;
    }
    const created: ConnectPlugin = { name, marketplaceName, skills: [], otherKinds: [], servers: [], readiness: readinessWords("ready") };
    plugins.set(name, created);
    return created;
  };
  for (const skill of skills) {
    if (skill.builtIn || !skill.pluginName) continue;
    ensure(skill.pluginName, skill.marketplaceName).skills.push(skill);
  }
  const statuses = new Map<string, PlainStatus[]>();
  for (const match of matches) {
    if (!match.plugin || !match.name.startsWith("plugin:")) continue;
    const plugin = ensure(match.plugin, match.marketplace);
    if (match.kind && match.kind !== "skill" && !plugin.otherKinds.includes(match.kind)) plugin.otherKinds.push(match.kind);
    const words = readinessWords(match.status || undefined);
    statuses.set(plugin.name, [...(statuses.get(plugin.name) ?? []), words]);
    for (const requirement of match.requirements) {
      if (plugin.servers.some((server) => server.name === requirement.serverName)) continue;
      plugin.servers.push({
        name: requirement.serverName,
        title: requirement.title,
        connectionName: requirement.connectionName,
        readiness: readinessWords(requirement.state),
        humanAction: requirementAction(requirement),
      });
    }
  }
  for (const plugin of plugins.values()) {
    const known = statuses.get(plugin.name);
    plugin.readiness = known ? worst(known) : readinessWords("ready");
    plugin.skills.sort((a, b) => a.title.localeCompare(b.title));
    plugin.servers.sort((a, b) => a.name.localeCompare(b.name));
    plugin.otherKinds.sort();
  }
  return [...plugins.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export type ConnectConnection = {
  id: string;
  name: string;
  description: string;
  words: ConnectionWords;
  /** Present when the connection is usable and advertises inline Apps. */
  appCount: number;
};

/**
 * The organization's connections: the usable ones the App catalog already
 * reached (Connected), plus every one the search says needs a person, with
 * the exact human step that unblocks it.
 */
export function collectConnections(servers: CoworkerMcpAppCatalogServer[], matches: GatewaySearchMatch[]): ConnectConnection[] {
  const connections = new Map<string, ConnectConnection>();
  for (const server of servers) {
    if (!server.connectionId || server.serverName === CONNECT_MCP_NAME) continue;
    const name = server.displayName?.trim() || server.serverName;
    connections.set(server.connectionId, {
      id: server.connectionId,
      name,
      description: "",
      words: server.reachable
        ? { label: "Connected", tone: "mint", detail: "", humanAction: "" }
        : { label: "Not connected", tone: "rose", detail: server.error ?? "", humanAction: `Check ${name} on the organization's Connections dashboard in OpenWork.` },
      appCount: server.apps.length,
    });
  }
  for (const match of matches) {
    if (!match.connectionStatus) continue;
    const status = match.connectionStatus;
    const existing = connections.get(status.connectionId);
    const words = connectionStatusWords(status);
    if (existing) {
      // The live status wins over a stale catalog entry: never claim ready when the gateway says otherwise.
      existing.words = words;
      if (!existing.description) existing.description = match.summary;
      continue;
    }
    connections.set(status.connectionId, {
      id: status.connectionId,
      name: status.connectionName,
      description: match.summary.replace(/^\[[^\]]*\]\s*/, ""),
      words,
      appCount: 0,
    });
  }
  return [...connections.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export type ConnectCatalog = {
  skills: ConnectSkill[];
  plugins: ConnectPlugin[];
  connections: ConnectConnection[];
};

export function buildConnectCatalog(input: {
  skills: ConnectSkill[];
  matches: GatewaySearchMatch[];
  servers: CoworkerMcpAppCatalogServer[];
}): ConnectCatalog {
  return {
    skills: input.skills,
    plugins: groupPlugins(input.skills, input.matches),
    connections: collectConnections(input.servers, input.matches),
  };
}

export const emptyConnectCatalog: ConnectCatalog = { skills: [], plugins: [], connections: [] };
