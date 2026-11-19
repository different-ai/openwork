// Local copies of organization plugins. Desktops no longer create them: org
// plugins reach the agent through OpenWork Connect (#2857). Workspaces may
// still hold copies made by older builds; this module lists and removes them.

import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ServerConfig } from "./types.js";
import { ApiError } from "./errors.js";
import { removeMcp } from "./mcp.js";
import { createWorkspaceKvStore, isRecord } from "./workspace-kv-store.js";

const OPENCODE_MCP_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;
const OPENCODE_MCP_IMPORT_PATH_PREFIX = "opencode.jsonc#mcp.";

export type CloudImportedPluginFile = {
  configObjectId: string;
  versionId: string | null;
  objectType: string;
  title: string;
  path: string;
  updatedAt: string | null;
};

export type CloudImportedPlugin = {
  pluginId: string;
  marketplaceId: string | null;
  name: string;
  description: string | null;
  updatedAt: string | null;
  files: CloudImportedPluginFile[];
  importedAt: number | null;
};

type WorkspaceCloudImports = {
  skills: Record<string, unknown>;
  providers: Record<string, unknown>;
  marketplaces: Record<string, { marketplaceId: string; name: string; updatedAt: string | null; pluginIds: string[]; importedAt: number | null }>;
  plugins: Record<string, CloudImportedPlugin>;
};

function readString(value: unknown): string | null {
  return typeof value === "string" ? value.trim() || null : null;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.flatMap((entry) => {
    const text = readString(entry);
    return text ? [text] : [];
  }) : [];
}

function readCloudImports(config: Record<string, unknown>): WorkspaceCloudImports {
  const root = isRecord(config.cloudImports) ? config.cloudImports : {};
  const marketplaces = isRecord(root.marketplaces) ? Object.fromEntries(Object.entries(root.marketplaces).flatMap(([key, value]) => {
    if (!isRecord(value)) return [];
    const marketplaceId = readString(value.marketplaceId) ?? key.trim();
    const name = readString(value.name) ?? marketplaceId;
    if (!marketplaceId || !name) return [];
    return [[marketplaceId, {
      marketplaceId,
      name,
      updatedAt: readString(value.updatedAt),
      pluginIds: readStringArray(value.pluginIds),
      importedAt: typeof value.importedAt === "number" && Number.isFinite(value.importedAt) ? value.importedAt : null,
    }]];
  })) : {};
  const plugins = isRecord(root.plugins) ? Object.fromEntries(Object.entries(root.plugins).flatMap(([key, value]) => {
    if (!isRecord(value)) return [];
    const pluginId = readString(value.pluginId) ?? key.trim();
    const name = readString(value.name) ?? pluginId;
    if (!pluginId || !name) return [];
    const files = Array.isArray(value.files) ? value.files.flatMap((file) => {
      if (!isRecord(file)) return [];
      const configObjectId = readString(file.configObjectId);
      const objectType = readString(file.objectType);
      const title = readString(file.title) ?? configObjectId;
      const path = readString(file.path);
      if (!configObjectId || !objectType || !title || !path) return [];
      return [{
        configObjectId,
        versionId: readString(file.versionId),
        objectType,
        title,
        path,
        updatedAt: readString(file.updatedAt),
      }];
    }) : [];
    return [[pluginId, {
      pluginId,
      marketplaceId: readString(value.marketplaceId),
      name,
      description: readString(value.description),
      updatedAt: readString(value.updatedAt),
      files,
      importedAt: typeof value.importedAt === "number" && Number.isFinite(value.importedAt) ? value.importedAt : null,
    }]];
  })) : {};
  return {
    skills: isRecord(root.skills) ? root.skills : {},
    providers: isRecord(root.providers) ? root.providers : {},
    marketplaces,
    plugins,
  };
}

function parseInstalledCloudPlugins(configJson: string): WorkspaceCloudImports {
  try {
    return readCloudImports({ cloudImports: JSON.parse(configJson) });
  } catch {
    return readCloudImports({});
  }
}

const cloudPluginInstallStore = createWorkspaceKvStore<WorkspaceCloudImports>({
  tableName: "cloud_plugin_install_configs",
  valueColumn: "config_json",
  parse: parseInstalledCloudPlugins,
  serialize: (value) => JSON.stringify(value),
});

export async function readInstalledCloudPlugins(config: ServerConfig, workspaceId: string): Promise<WorkspaceCloudImports> {
  return await cloudPluginInstallStore.get(config, workspaceId) ?? readCloudImports({});
}

async function writeInstalledCloudPlugins(
  config: ServerConfig,
  workspaceId: string,
  updater: (current: WorkspaceCloudImports) => WorkspaceCloudImports,
): Promise<WorkspaceCloudImports> {
  const next = updater(await readInstalledCloudPlugins(config, workspaceId));
  await cloudPluginInstallStore.set(config, workspaceId, next);
  return next;
}

function resolveWorkspaceInstallPath(workspaceRoot: string, relativePath: string): string {
  const normalized = relativePath.trim().replace(/^\/+/, "");
  const parts = normalized.split("/").filter(Boolean);
  if (!normalized.startsWith(".opencode/") || parts.some((part) => part === "." || part === "..")) {
    throw new ApiError(400, "invalid_cloud_plugin_path", `Invalid cloud plugin path: ${relativePath}`);
  }
  const root = resolve(workspaceRoot);
  const candidate = resolve(root, normalized);
  if (candidate !== root && !candidate.startsWith(`${root}/`)) {
    throw new ApiError(400, "invalid_cloud_plugin_path", `Invalid cloud plugin path: ${relativePath}`);
  }
  return candidate;
}

async function removePluginWorkspaceFile(workspaceRoot: string, path: string): Promise<void> {
  if (!path.startsWith(".opencode/")) return;
  const absolutePath = resolveWorkspaceInstallPath(workspaceRoot, path);
  if (/^\.opencode\/skills\/[^/]+\/[^/]+\/SKILL\.md$/.test(path)) {
    await rm(dirname(absolutePath), { recursive: true, force: true });
    return;
  }
  await rm(absolutePath, { force: true });
}

function cloudPluginMcpNameFromPath(path: string): string | null {
  if (!path.startsWith(OPENCODE_MCP_IMPORT_PATH_PREFIX)) return null;
  const name = path.slice(OPENCODE_MCP_IMPORT_PATH_PREFIX.length).trim();
  return OPENCODE_MCP_NAME_RE.test(name) ? name : null;
}

export async function removeCloudPlugin(input: {
  serverConfig: ServerConfig;
  workspaceId: string;
  workspaceRoot: string;
  pluginId: string;
}): Promise<CloudImportedPlugin> {
  const cloudImports = await readInstalledCloudPlugins(input.serverConfig, input.workspaceId);
  const imported = cloudImports.plugins[input.pluginId];
  if (!imported) throw new ApiError(404, "cloud_plugin_not_installed", "This workspace has no local copy of that plugin.");

  // One at a time: the MCP config is a single document. A server another
  // local copy still lists stays.
  const sharedMcpNames = new Set(Object.values(cloudImports.plugins).flatMap((plugin) => (
    plugin.pluginId === input.pluginId ? [] : plugin.files.flatMap((file) => {
      const name = file.objectType === "mcp" ? cloudPluginMcpNameFromPath(file.path) : null;
      return name ? [name] : [];
    })
  )));
  for (const file of imported.files) {
    const mcpName = file.objectType === "mcp" ? cloudPluginMcpNameFromPath(file.path) : null;
    if (mcpName) {
      if (!sharedMcpNames.has(mcpName)) await removeMcp(input.serverConfig, input.workspaceId, mcpName);
      continue;
    }
    await removePluginWorkspaceFile(input.workspaceRoot, file.path);
  }

  const nextPlugins = { ...cloudImports.plugins };
  delete nextPlugins[input.pluginId];
  const nextMarketplaces = Object.fromEntries(Object.entries(cloudImports.marketplaces).flatMap(([marketplaceId, marketplace]) => {
    const pluginIds = marketplace.pluginIds.filter((id) => id !== input.pluginId);
    if (pluginIds.length === 0) return [];
    return [[marketplaceId, { ...marketplace, pluginIds }]];
  }));

  await writeInstalledCloudPlugins(input.serverConfig, input.workspaceId, (current) => ({
    ...current,
    marketplaces: nextMarketplaces,
    plugins: nextPlugins,
  }));

  return imported;
}
