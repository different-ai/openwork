import { parse } from "jsonc-parser";

import type { OpencodeConfigFile } from "../lib/tauri";

type PluginListValue = string | string[] | null | undefined;

type PluginConfig = {
  content: string | null;
} | null;

export function normalizePluginList(value: PluginListValue) {
  if (!value) return [] as string[];
  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter((entry) => entry.length > 0);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  return [] as string[];
}

export function stripPluginVersion(spec: string) {
  const trimmed = spec.trim();
  if (!trimmed) return "";

  const looksLikeVersion = (suffix: string) =>
    /^(latest|next|beta|alpha|canary|rc|stable|\d)/i.test(suffix);

  if (trimmed.startsWith("@")) {
    const slashIndex = trimmed.indexOf("/");
    if (slashIndex === -1) return trimmed;

    const atIndex = trimmed.indexOf("@", slashIndex + 1);
    if (atIndex === -1) return trimmed;

    const suffix = trimmed.slice(atIndex + 1);
    return looksLikeVersion(suffix) ? trimmed.slice(0, atIndex) : trimmed;
  }

  const atIndex = trimmed.indexOf("@");
  if (atIndex === -1) return trimmed;

  const suffix = trimmed.slice(atIndex + 1);
  return looksLikeVersion(suffix) ? trimmed.slice(0, atIndex) : trimmed;
}

export function isPluginInstalled(pluginList: string[], pluginName: string, aliases: string[] = []) {
  const normalized = pluginList.flatMap((entry) => {
    const raw = entry.toLowerCase();
    const stripped = stripPluginVersion(entry).toLowerCase();
    return stripped && stripped !== raw ? [raw, stripped] : [raw];
  });

  const list = new Set(normalized);
  return [pluginName, ...aliases].some((entry) => list.has(entry.toLowerCase()));
}

export function loadPluginsFromConfig(
  config: PluginConfig,
  onList: (next: string[]) => void,
  onError: (message: string) => void,
) {
  if (!config?.content) {
    onList([]);
    return;
  }

  try {
    const parsed = parse(config.content) as Record<string, unknown> | undefined;
    const next = normalizePluginList(parsed?.plugin as PluginListValue);
    onList(next);
  } catch (e) {
    onList([]);
    onError(e instanceof Error ? e.message : "Failed to parse opencode.json");
  }
}

export function parsePluginsFromConfig(config: OpencodeConfigFile | null) {
  if (!config?.content) return [] as string[];
  return parsePluginListFromContent(config.content);
}

export function parsePluginListFromContent(content: string) {
  try {
    const parsed = parse(content) as Record<string, unknown> | undefined;
    return normalizePluginList(parsed?.plugin as PluginListValue);
  } catch {
    return [] as string[];
  }
}
