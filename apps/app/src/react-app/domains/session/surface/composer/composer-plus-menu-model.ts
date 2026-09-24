import type { CloudImportedPlugin, CloudImportedPluginFile } from "@/app/cloud/import-state";
import type { SkillCard, SlashCommandOption } from "@/app/types";
import {
  normalizeComposerQuery,
  rankComposerSearch,
  type ComposerSearchEntry,
  type ComposerSearchMatch,
  type ComposerSearchTier,
} from "./composer-search";

export type PlusMenuSection = "skills" | "connectors" | "plugins" | "agents-commands";

export const PLUS_MENU_SECTIONS: readonly PlusMenuSection[] = ["skills", "connectors", "plugins", "agents-commands"];

export type PlusMenuView =
  | { kind: "root" }
  | { kind: "section"; section: PlusMenuSection }
  | { kind: "plugin"; pluginId: string };

export type PlusMenuConnector = {
  key: string;
  name: string;
  serviceUrl?: string;
  /** Present when the member must sign in before the connector works. */
  signIn: { connectionId: string; reconnect: boolean } | null;
  connecting: boolean;
  /** Short reason shown only when the connector cannot be used as is. */
  note: string | null;
};

export type PlusMenuAgent = { name: string | null; label: string; description?: string; selected: boolean };

type ItemBase = { id: string; label: string; highlights: number[] };

export type PlusMenuItem =
  | (ItemBase & { kind: "attach" })
  | (ItemBase & { kind: "section"; section: PlusMenuSection; count: number })
  | (ItemBase & { kind: "skill"; skill: SkillCard })
  | (ItemBase & { kind: "connector"; connector: PlusMenuConnector })
  | (ItemBase & { kind: "plugin"; plugin: CloudImportedPlugin })
  | (ItemBase & { kind: "plugin-file"; file: CloudImportedPluginFile })
  | (ItemBase & { kind: "agent"; agent: PlusMenuAgent })
  | (ItemBase & { kind: "command"; command: SlashCommandOption })
  | (ItemBase & { kind: "file"; path: string })
  | (ItemBase & { kind: "manage"; section: PlusMenuSection });

export type PlusMenuGroupId =
  | "attach"
  | "recent"
  | "browse"
  | "connectors"
  | "skills"
  | "plugins"
  | "agents"
  | "commands"
  | "files"
  | "plugin-files"
  | "manage";

export type PlusMenuGroup = { id: PlusMenuGroupId; items: PlusMenuItem[] };

export type PlusMenuModel = {
  groups: PlusMenuGroup[];
  /** True when a query matched nothing; the browse list is shown instead. */
  noMatches: boolean;
};

export type PlusMenuInput = {
  view: PlusMenuView;
  query: string;
  skills: SkillCard[];
  connectors: PlusMenuConnector[];
  plugins: CloudImportedPlugin[];
  agents: PlusMenuAgent[];
  commands: SlashCommandOption[];
  files: string[];
  recentIds: string[];
};

const QUERY_GROUP_LIMIT = 5;
const RECENT_LIMIT = 3;

const TIER_ORDER: Record<ComposerSearchTier, number> = {
  exact: 6,
  prefix: 5,
  "word-start": 4,
  fuzzy: 3,
  keyword: 2,
  typo: 1,
};

/** "customer-briefing" reads as "Customer briefing"; names with capitals are kept. */
export function humanizeCapabilityName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || /[A-Z\s]/.test(trimmed)) return trimmed;
  const spaced = trimmed.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function fileLabel(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

export function plusMenuSkillId(skill: SkillCard): string {
  return `skill:${skill.origin ?? "local"}:${skill.path || skill.name}`;
}

function skillItem(skill: SkillCard, highlights: number[] = []): PlusMenuItem {
  return { kind: "skill", id: plusMenuSkillId(skill), label: humanizeCapabilityName(skill.name), highlights, skill };
}

function connectorItem(connector: PlusMenuConnector, highlights: number[] = []): PlusMenuItem {
  return { kind: "connector", id: `connector:${connector.key}`, label: connector.name, highlights, connector };
}

function pluginItem(plugin: CloudImportedPlugin, highlights: number[] = []): PlusMenuItem {
  return { kind: "plugin", id: `plugin:${plugin.pluginId}`, label: plugin.name, highlights, plugin };
}

function pluginFileItem(file: CloudImportedPluginFile, highlights: number[] = []): PlusMenuItem {
  return { kind: "plugin-file", id: `plugin-file:${file.configObjectId}:${file.path}`, label: file.title, highlights, file };
}

function agentItem(agent: PlusMenuAgent, highlights: number[] = []): PlusMenuItem {
  return { kind: "agent", id: `agent:${agent.name ?? "default"}`, label: agent.label, highlights, agent };
}

function commandItem(command: SlashCommandOption, highlights: number[] = []): PlusMenuItem {
  return { kind: "command", id: `command:${command.id}`, label: command.name, highlights, command };
}

function fileItem(path: string, highlights: number[] = []): PlusMenuItem {
  return { kind: "file", id: `file:${path}`, label: fileLabel(path), highlights, path };
}

function attachItem(): PlusMenuItem {
  return { kind: "attach", id: "attach", label: "", highlights: [] };
}

function manageItem(section: PlusMenuSection): PlusMenuItem {
  return { kind: "manage", id: `manage:${section}`, label: "", highlights: [], section };
}

function sectionCount(input: PlusMenuInput, section: PlusMenuSection): number {
  switch (section) {
    case "skills":
      return input.skills.length;
    case "connectors":
      return input.connectors.length;
    case "plugins":
      return input.plugins.length;
    case "agents-commands":
      return input.agents.filter((agent) => agent.name !== null).length + input.commands.length;
  }
}

function browseGroup(input: PlusMenuInput): PlusMenuGroup {
  return {
    id: "browse",
    items: PLUS_MENU_SECTIONS.map((section) => ({
      kind: "section",
      id: `section:${section}`,
      label: "",
      highlights: [],
      section,
      count: sectionCount(input, section),
    })),
  };
}

type Ranked = { items: PlusMenuItem[]; best: ComposerSearchMatch<unknown> | null };

function rank<T>(
  query: string,
  values: T[],
  toEntry: (value: T) => ComposerSearchEntry<T>,
  toItem: (value: T, highlights: number[]) => PlusMenuItem,
  limit?: number,
): Ranked {
  const matches = rankComposerSearch(query, values.map(toEntry), { limit });
  return {
    items: matches.map((match) => toItem(match.entry.value, match.highlights)),
    best: matches[0] ?? null,
  };
}

function skillEntry(skill: SkillCard): ComposerSearchEntry<SkillCard> {
  return {
    id: plusMenuSkillId(skill),
    label: humanizeCapabilityName(skill.name),
    keywords: [skill.name, skill.description ?? "", skill.pluginName ?? ""],
    value: skill,
  };
}

function connectorEntry(connector: PlusMenuConnector): ComposerSearchEntry<PlusMenuConnector> {
  return { id: connector.key, label: connector.name, value: connector };
}

function pluginEntry(plugin: CloudImportedPlugin): ComposerSearchEntry<CloudImportedPlugin> {
  return { id: plugin.pluginId, label: plugin.name, keywords: [plugin.description ?? ""], value: plugin };
}

function pluginFileEntry(file: CloudImportedPluginFile): ComposerSearchEntry<CloudImportedPluginFile> {
  return { id: `${file.configObjectId}:${file.path}`, label: file.title, keywords: [file.skillName ?? ""], value: file };
}

function agentEntry(agent: PlusMenuAgent): ComposerSearchEntry<PlusMenuAgent> {
  return { id: agent.name ?? "default", label: agent.label, keywords: [agent.description ?? ""], value: agent };
}

function commandEntry(command: SlashCommandOption): ComposerSearchEntry<SlashCommandOption> {
  return { id: command.id, label: command.name, keywords: [command.description ?? ""], value: command };
}

function fileEntry(path: string): ComposerSearchEntry<string> {
  return { id: path, label: fileLabel(path), keywords: [path], value: path };
}

function compareBest(a: Ranked, b: Ranked): number {
  if (!a.best || !b.best) return a.best ? -1 : b.best ? 1 : 0;
  const tier = TIER_ORDER[b.best.tier] - TIER_ORDER[a.best.tier];
  if (tier !== 0) return tier;
  return b.best.score - a.best.score;
}

function recentGroup(input: PlusMenuInput): PlusMenuGroup {
  const candidates = new Map<string, PlusMenuItem>();
  for (const skill of input.skills) candidates.set(plusMenuSkillId(skill), skillItem(skill));
  for (const connector of input.connectors) candidates.set(`connector:${connector.key}`, connectorItem(connector));
  for (const command of input.commands) candidates.set(`command:${command.id}`, commandItem(command));
  for (const file of input.files) candidates.set(`file:${file}`, fileItem(file));
  const items = input.recentIds.flatMap((id) => {
    const item = candidates.get(id);
    return item ? [item] : [];
  });
  return { id: "recent", items: items.slice(0, RECENT_LIMIT) };
}

function rootModel(input: PlusMenuInput, query: string): PlusMenuModel {
  if (!query) {
    const groups: PlusMenuGroup[] = [{ id: "attach", items: [attachItem()] }, recentGroup(input), browseGroup(input)];
    return { noMatches: false, groups: groups.filter((group) => group.items.length > 0) };
  }
  const ranked: { id: PlusMenuGroupId; ranked: Ranked }[] = [
    { id: "connectors", ranked: rank(query, input.connectors, connectorEntry, connectorItem, QUERY_GROUP_LIMIT) },
    { id: "skills", ranked: rank(query, input.skills, skillEntry, skillItem, QUERY_GROUP_LIMIT) },
    { id: "plugins", ranked: rank(query, input.plugins, pluginEntry, pluginItem, QUERY_GROUP_LIMIT) },
    { id: "agents", ranked: rank(query, input.agents, agentEntry, agentItem, QUERY_GROUP_LIMIT) },
    { id: "commands", ranked: rank(query, input.commands, commandEntry, commandItem, QUERY_GROUP_LIMIT) },
  ];
  const files = rank(query, [...new Set(input.files)], fileEntry, fileItem, QUERY_GROUP_LIMIT);
  const matched = ranked.filter((group) => group.ranked.items.length > 0);
  if (matched.length === 0 && files.items.length === 0) {
    return { noMatches: true, groups: [browseGroup(input)] };
  }
  const ordered = [...matched].sort((a, b) => compareBest(a.ranked, b.ranked));
  return {
    noMatches: false,
    groups: [
      ...ordered.map((group): PlusMenuGroup => ({ id: group.id, items: group.ranked.items })),
      { id: "files", items: [...files.items, attachItem()] },
    ],
  };
}

function sectionModel(input: PlusMenuInput, section: PlusMenuSection, query: string): PlusMenuModel {
  const manage: PlusMenuGroup = { id: "manage", items: [manageItem(section)] };
  const all = <T>(values: T[], toItem: (value: T) => PlusMenuItem) => values.map((value) => toItem(value));
  let groups: PlusMenuGroup[];
  switch (section) {
    case "skills":
      groups = [{ id: "skills", items: query ? rank(query, input.skills, skillEntry, skillItem).items : all(input.skills, skillItem) }];
      break;
    case "connectors":
      groups = [{
        id: "connectors",
        items: query ? rank(query, input.connectors, connectorEntry, connectorItem).items : all(input.connectors, connectorItem),
      }];
      break;
    case "plugins":
      groups = [{ id: "plugins", items: query ? rank(query, input.plugins, pluginEntry, pluginItem).items : all(input.plugins, pluginItem) }];
      break;
    case "agents-commands":
      groups = [
        { id: "agents", items: query ? rank(query, input.agents, agentEntry, agentItem).items : all(input.agents, agentItem) },
        { id: "commands", items: query ? rank(query, input.commands, commandEntry, commandItem).items : all(input.commands, commandItem) },
      ];
      break;
  }
  const nonEmpty = groups.filter((group) => group.items.length > 0);
  return { noMatches: Boolean(query) && nonEmpty.length === 0, groups: [...nonEmpty, manage] };
}

function pluginModel(input: PlusMenuInput, pluginId: string, query: string): PlusMenuModel {
  const plugin = input.plugins.find((entry) => entry.pluginId === pluginId);
  const files = plugin?.files ?? [];
  const items = query ? rank(query, files, pluginFileEntry, pluginFileItem).items : files.map((file) => pluginFileItem(file));
  const groups: PlusMenuGroup[] = items.length ? [{ id: "plugin-files", items }] : [];
  return { noMatches: Boolean(query) && items.length === 0, groups: [...groups, { id: "manage", items: [manageItem("plugins")] }] };
}

export function buildPlusMenuModel(input: PlusMenuInput): PlusMenuModel {
  const query = normalizeComposerQuery(input.query);
  switch (input.view.kind) {
    case "root":
      return rootModel(input, query);
    case "section":
      return sectionModel(input, input.view.section, query);
    case "plugin":
      return pluginModel(input, input.view.pluginId, query);
  }
}

export function plusMenuParentView(view: PlusMenuView): PlusMenuView | null {
  if (view.kind === "plugin") return { kind: "section", section: "plugins" };
  if (view.kind === "section") return { kind: "root" };
  return null;
}
