import { homedir } from "node:os";
import { join, relative } from "node:path";
import { readdir } from "node:fs/promises";
import type { PluginItem, ServerConfig } from "./types.js";
import { readJsoncFile } from "./jsonc.js";
import { opencodeConfigPath, projectPluginsDir } from "./workspace-files.js";
import { exists } from "./utils.js";
import { validatePluginSpec } from "./validators.js";
import { readRuntimeOpencodeConfig, runtimePluginList, writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import {
  buildOpenworkPluginSpecs,
  isOpenworkCorePluginSpec,
  openworkCorePluginSpecs,
} from "./openwork-core-plugin-specs.js";
import { normalizePluginSpec } from "./plugin-spec.js";
import { ApiError } from "./errors.js";

export { normalizePluginSpec } from "./plugin-spec.js";

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
    const relativePath = workspaceRoot
      ? relative(workspaceRoot, absolutePath)
      : join("~", ".config", "opencode", "plugins", entry.name);
    items.push({
      spec: scope === "project"
        ? `file://${relativePath}`
        : `file://~/.config/opencode/plugins/${entry.name}`,
      source: scope === "project" ? "dir.project" : "dir.global",
      scope,
      stage: scope === "project" ? "dir.project" : "dir.global",
      path: relativePath,
    });
  }
  return items;
}

const CORE_PLUGIN_PUBLIC_LABELS = [
  "opencode-chrome-devtools",
  "openwork-context",
  "openwork-prompt-log",
] as const;

function publicCorePluginSpec(spec: string): string {
  const normalized = normalizePluginSpec(spec);
  const index = openworkCorePluginSpecs().findIndex(
    (candidate) => normalizePluginSpec(candidate) === normalized,
  );
  return CORE_PLUGIN_PUBLIC_LABELS[index] ?? "openwork-core-plugin";
}

function publicShadowReference(spec: string): string {
  // Preserve a user-declared package spec (including its version) so the
  // shadow marker points back to the exact visible inventory row. Only the
  // concrete OpenWork-owned specs need redaction: two of those are absolute
  // bundle paths that must not escape through diagnostics.
  if (openworkCorePluginSpecs().includes(spec)) return publicCorePluginSpec(spec);
  if (spec.startsWith("file:") || spec.startsWith("/")) return "file-plugin";
  return spec;
}

export type PluginInventory = {
  items: PluginItem[];
  /** Known stages represented by `items`, in OpenCode stage order. */
  loadOrder: string[];
  /** This endpoint is an ownership inventory, not OpenCode's complete resolved plugin graph. */
  orderSemantics: "partial-stage-order";
  uninspectedStages: string[];
};

export async function listPlugins(
  serverConfig: ServerConfig,
  workspaceId: string,
  workspaceRoot: string,
  includeGlobal: boolean,
): Promise<PluginInventory> {
  const { data: config } = await readJsoncFile(opencodeConfigPath(workspaceRoot), {} as Record<string, unknown>, { allowInvalid: true });
  const pluginSpecs = pluginListFromConfig(config);
  const runtimeSpecs = runtimePluginList(await readRuntimeOpencodeConfig(serverConfig, workspaceId));
  // This is the exact sequence written into OpenWork's OPENCODE_CONFIG layer:
  // chrome/context, user-managed runtime rows, then the prompt observer.
  const managedSpecs = buildOpenworkPluginSpecs(runtimeSpecs);
  const items: PluginItem[] = managedSpecs.map((spec) => ({
    spec,
    source: isOpenworkCorePluginSpec(spec) ? "core" : "config",
    scope: "project",
    stage: "config.managed",
  }));

  for (const spec of pluginSpecs) {
    items.push({
      spec,
      source: "config",
      scope: "project",
      stage: "config.project",
    });
  }

  if (includeGlobal) {
    const globalDir = join(homedir(), ".config", "opencode", "plugins");
    items.push(...(await listPluginFiles(globalDir, "global")));
  }

  const projectDir = projectPluginsDir(workspaceRoot);
  items.push(...(await listPluginFiles(projectDir, "project", workspaceRoot)));

  // OpenCode v1.17.11 resolves duplicate plugin identities last-wins. Preserve
  // every declaration for provenance and mark known earlier losers instead of
  // hiding the later row. Uninspected stages below still prevent this marker
  // from claiming complete effective resolution.
  const laterWinnerByIdentity = new Map<string, string>();
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item) continue;
    const identity = normalizePluginSpec(item.spec);
    const laterWinner = laterWinnerByIdentity.get(identity);
    if (laterWinner) item.shadowedWithinInventoryBy = laterWinner;
    else laterWinnerByIdentity.set(identity, item.spec);
  }
  for (const item of items) {
    if (item.source === "core") item.spec = publicCorePluginSpec(item.spec);
    if (item.shadowedWithinInventoryBy) {
      item.shadowedWithinInventoryBy = publicShadowReference(item.shadowedWithinInventoryBy);
    }
  }

  return {
    items,
    loadOrder: [
      "config.managed",
      "config.project",
      ...(includeGlobal ? ["dir.global"] : []),
      "dir.project",
    ],
    orderSemantics: "partial-stage-order",
    uninspectedStages: [
      "config.global",
      "config.remote-account-managed",
      ...(!includeGlobal ? ["dir.global"] : []),
    ],
  };
}

export function assertPluginAddable(spec: string): void {
  if (!isOpenworkCorePluginSpec(spec)) return;
  throw new ApiError(400, "core_plugin_read_only", "OpenWork core plugins are managed by OpenWork");
}

export async function assertPluginRemovable(
  serverConfig: ServerConfig,
  workspaceId: string,
  spec: string,
): Promise<void> {
  const normalized = normalizePluginSpec(spec);
  if (!isOpenworkCorePluginSpec(spec)) return;
  const runtimeConfig = await readRuntimeOpencodeConfig(serverConfig, workspaceId);
  const hasStaleRuntimeRow = runtimePluginList(runtimeConfig).some(
    (item) => normalizePluginSpec(item) === normalized,
  );
  // Deleting a stale runtime duplicate is a repair operation: the effective
  // core plugin remains injected by OpenWork.
  if (hasStaleRuntimeRow) return;
  throw new ApiError(400, "core_plugin_read_only", "OpenWork core plugins cannot be removed");
}

export async function addPlugin(serverConfig: ServerConfig, workspaceId: string, spec: string): Promise<boolean> {
  validatePluginSpec(spec);
  assertPluginAddable(spec);
  const runtimeConfig = await readRuntimeOpencodeConfig(serverConfig, workspaceId);
  const pluginSpecs = runtimePluginList(runtimeConfig);
  const normalized = normalizePluginSpec(spec);
  const existing = pluginSpecs.find((item) => normalizePluginSpec(item) === normalized);
  if (existing) return false;
  pluginSpecs.push(spec);
  await writeRuntimeOpencodeConfig(serverConfig, workspaceId, (current) => ({ ...current, plugin: pluginSpecs }));
  return true;
}

export async function removePlugin(serverConfig: ServerConfig, workspaceId: string, name: string): Promise<boolean> {
  const runtimeConfig = await readRuntimeOpencodeConfig(serverConfig, workspaceId);
  const pluginSpecs = runtimePluginList(runtimeConfig);
  const normalized = normalizePluginSpec(name);
  const filtered = pluginSpecs.filter((item) => normalizePluginSpec(item) !== normalized);
  if (filtered.length === pluginSpecs.length) {
    if (isOpenworkCorePluginSpec(name)) {
      throw new ApiError(400, "core_plugin_read_only", "OpenWork core plugins cannot be removed");
    }
    return false;
  }
  await writeRuntimeOpencodeConfig(serverConfig, workspaceId, (current) => ({ ...current, plugin: filtered }));
  return true;
}
