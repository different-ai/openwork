import { homedir } from "node:os";
import { join, relative } from "node:path";
import { readdir } from "node:fs/promises";
import type { PluginItem } from "./types.js";
import { readJsoncFile, updateJsoncTopLevel } from "./jsonc.js";
import { opencodeConfigPath, projectPluginsDir } from "./workspace-files.js";
import { exists } from "./utils.js";
import { validatePluginSpec } from "./validators.js";

function normalizePluginSpec(spec: string): string {
  const trimmed = spec.trim();
  if (trimmed.startsWith("file:") || trimmed.startsWith("http:") || trimmed.startsWith("https:") || trimmed.startsWith("git:")) {
    return trimmed;
  }
  if (trimmed.startsWith("/")) {
    return trimmed;
  }
  if (trimmed.startsWith("@")) {
    const atIndex = trimmed.indexOf("@", 1);
    return atIndex > 0 ? trimmed.slice(0, atIndex) : trimmed;
  }
  const atIndex = trimmed.indexOf("@");
  return atIndex > 0 ? trimmed.slice(0, atIndex) : trimmed;
}

function pluginListFromConfig(config: Record<string, unknown>): string[] {
  const plugin = config.plugin;
  if (typeof plugin === "string") return [plugin];
  if (Array.isArray(plugin)) return plugin.filter((item) => typeof item === "string") as string[];
  return [];
}

async function listPluginFiles(dir: string, scope: "project" | "global", workspaceRoot?: string): Promise<PluginItem[]> {
  if (!(await exists(dir))) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const items: PluginItem[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".js") && !entry.name.endsWith(".ts")) continue;
    const absolutePath = join(dir, entry.name);
    const relativePath = workspaceRoot ? relative(workspaceRoot, absolutePath) : absolutePath;
    items.push({
      spec: `file://${absolutePath}`,
      source: scope === "project" ? "dir.project" : "dir.global",
      scope,
      path: relativePath,
    });
  }
  return items;
}

export async function listPlugins(workspaceRoot: string, includeGlobal: boolean): Promise<{ items: PluginItem[]; loadOrder: string[] }> {
  const { data: config } = await readJsoncFile(opencodeConfigPath(workspaceRoot), {} as Record<string, unknown>);
  const pluginSpecs = pluginListFromConfig(config);
  const items: PluginItem[] = pluginSpecs.map((spec) => ({
    spec,
    source: "config",
    scope: "project",
  }));

  const projectDir = projectPluginsDir(workspaceRoot);
  items.push(...(await listPluginFiles(projectDir, "project", workspaceRoot)));

  if (includeGlobal) {
    const globalDir = join(homedir(), ".config", "opencode", "plugins");
    items.push(...(await listPluginFiles(globalDir, "global")));
  }

  return {
    items,
    loadOrder: ["config.global", "config.project", "dir.global", "dir.project"],
  };
}

export async function addPlugin(workspaceRoot: string, spec: string): Promise<void> {
  validatePluginSpec(spec);
  const { data: config } = await readJsoncFile(opencodeConfigPath(workspaceRoot), {} as Record<string, unknown>);
  const pluginSpecs = pluginListFromConfig(config);
  const normalized = normalizePluginSpec(spec);
  const existing = pluginSpecs.find((item) => normalizePluginSpec(item) === normalized);
  if (existing) return;
  pluginSpecs.push(spec);
  await updateJsoncTopLevel(opencodeConfigPath(workspaceRoot), { plugin: pluginSpecs });
}

export async function removePlugin(workspaceRoot: string, name: string): Promise<void> {
  const { data: config } = await readJsoncFile(opencodeConfigPath(workspaceRoot), {} as Record<string, unknown>);
  const pluginSpecs = pluginListFromConfig(config);
  const normalized = normalizePluginSpec(name);
  const filtered = pluginSpecs.filter((item) => normalizePluginSpec(item) !== normalized);
  await updateJsoncTopLevel(opencodeConfigPath(workspaceRoot), { plugin: filtered });
}
