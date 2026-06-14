import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { ServerConfig } from "./types.js";
import { ApiError } from "./errors.js";
import { parseFrontmatter, buildFrontmatter } from "./frontmatter.js";
import { addMcp, removeMcp } from "./mcp.js";
import { ensureDir } from "./utils.js";

const OPENCODE_SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const OPENCODE_MCP_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;
const OPENCODE_MCP_IMPORT_PATH_PREFIX = "opencode.jsonc#mcp.";

type CloudPluginConfigObjectType = "skill" | "agent" | "command" | "tool" | "mcp" | "hook" | "context" | "custom";

type CloudPluginConfigObjectVersion = {
  id: string;
  rawSourceText: string | null;
  normalizedPayloadJson: Record<string, unknown> | null;
};

type CloudPluginConfigObject = {
  id: string;
  objectType: CloudPluginConfigObjectType;
  title: string;
  description: string | null;
  currentRelativePath: string | null;
  status: string;
  updatedAt: string | null;
  latestVersion: CloudPluginConfigObjectVersion | null;
};

type CloudPluginMembership = {
  configObjectId: string;
  configObject?: CloudPluginConfigObject;
};

export type CloudPluginResolved = {
  plugin: {
    id: string;
    name: string;
    description: string | null;
    updatedAt: string | null;
  };
  memberships: CloudPluginMembership[];
};

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

const cloudPluginInstallConfigs = sqliteTable("cloud_plugin_install_configs", {
  workspaceId: text("workspace_id").primaryKey(),
  configJson: text("config_json").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

type CloudPluginDb = {
  get: (workspaceId: string) => { configJson: string } | undefined;
  upsert: (value: { workspaceId: string; configJson: string; updatedAt: number }) => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value.trim() || null : null;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.flatMap((entry) => {
    const text = readString(entry);
    return text ? [text] : [];
  }) : [];
}

function readStringRecord(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null;
  const output: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    const text = readString(entry);
    if (text) output[key] = text;
  }
  return Object.keys(output).length ? output : null;
}

function parseJsonRecord(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeConfigObjectType(value: unknown): CloudPluginConfigObjectType | null {
  switch (value) {
    case "skill":
    case "agent":
    case "command":
    case "tool":
    case "mcp":
    case "hook":
    case "context":
    case "custom":
      return value;
    default:
      return null;
  }
}

function normalizeConfigObjectVersion(value: unknown): CloudPluginConfigObjectVersion | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  return {
    id: value.id,
    rawSourceText: typeof value.rawSourceText === "string" ? value.rawSourceText : null,
    normalizedPayloadJson: isRecord(value.normalizedPayloadJson) ? value.normalizedPayloadJson : null,
  };
}

function normalizeConfigObject(value: unknown): CloudPluginConfigObject | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.title !== "string") return null;
  const objectType = normalizeConfigObjectType(value.objectType);
  if (!objectType) return null;
  return {
    id: value.id,
    objectType,
    title: value.title,
    description: typeof value.description === "string" ? value.description : null,
    currentRelativePath: typeof value.currentRelativePath === "string" ? value.currentRelativePath : null,
    status: typeof value.status === "string" ? value.status : "active",
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
    latestVersion: normalizeConfigObjectVersion(value.latestVersion),
  };
}

function normalizeCloudPluginResolved(value: unknown): CloudPluginResolved | null {
  if (!isRecord(value) || !isRecord(value.plugin) || !Array.isArray(value.memberships)) return null;
  if (typeof value.plugin.id !== "string" || typeof value.plugin.name !== "string") return null;
  const memberships = value.memberships.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.configObjectId !== "string") return [];
    const configObject = normalizeConfigObject(entry.configObject);
    return [{ configObjectId: entry.configObjectId, ...(configObject ? { configObject } : {}) }];
  });
  return {
    plugin: {
      id: value.plugin.id,
      name: value.plugin.name,
      description: typeof value.plugin.description === "string" ? value.plugin.description : null,
      updatedAt: typeof value.plugin.updatedAt === "string" ? value.plugin.updatedAt : null,
    },
    memberships,
  };
}

export function readCloudPluginResolved(value: unknown): CloudPluginResolved {
  const resolved = normalizeCloudPluginResolved(value);
  if (!resolved) throw new ApiError(400, "invalid_cloud_plugin", "resolved cloud plugin is required");
  return resolved;
}

function extractSkillBodyMarkdown(skillText: string): string {
  const trimmed = skillText.trim();
  if (!trimmed.startsWith("---")) return trimmed;
  const rest = trimmed.slice(3);
  const end = rest.indexOf("\n---");
  if (end === -1) return trimmed;
  return rest.slice(end + 4).replace(/^\s*\n?/, "");
}

function slugifyConfigObjectName(title: string, fallback: string): string {
  let base = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!base) base = "skill";
  if (base.length > 64) base = base.slice(0, 64).replace(/-+$/g, "");
  if (!OPENCODE_SKILL_NAME_RE.test(base)) base = "skill";
  if (base === "skill" && fallback) return slugifyConfigObjectName(fallback, "");
  return base;
}

function pluginNamespace(pluginName: string, pluginId: string): string {
  const base = slugifyConfigObjectName(pluginName, pluginId);
  return `${base.replace(/-plugin$/, "")}-plugin`;
}

function normalizePluginSourcePath(path: string, objectType: string, namespace: string): string {
  const parts = path.trim().replace(/^\/+/, "").split("/").filter(Boolean);
  if (parts.length === 0 || parts.some((part) => part === ".." || part === ".")) return "";

  const folderByType: Record<string, string> = {
    agent: "agents",
    command: "commands",
    context: "context",
    hook: "hooks",
    mcp: "mcps",
    skill: "skills",
    tool: "tools",
  };
  const folder = folderByType[objectType];
  if (!folder) return "";
  const opencodeIndex = parts.findIndex((part) => part === ".opencode");
  const searchParts = opencodeIndex >= 0 ? parts.slice(opencodeIndex + 1) : parts;
  const folderIndex = searchParts.findIndex((part) => part === folder);
  if (folderIndex < 0 || folderIndex === searchParts.length - 1) return "";
  const rest = searchParts.slice(folderIndex + 1);
  if (rest[0] === namespace) return [".opencode", folder, ...rest].join("/");
  return [".opencode", folder, namespace, ...rest].join("/");
}

function getPluginObjectInstallPath(object: CloudPluginConfigObject, namespace: string): string {
  const existing = normalizePluginSourcePath(object.currentRelativePath ?? "", object.objectType, namespace);
  if (existing) {
    if (object.objectType === "skill") {
      const parts = existing.split("/").filter(Boolean);
      const lastPart = parts.at(-1) ?? "";
      const skillName = /^SKILL\.md$/i.test(lastPart)
        ? parts.at(-2) ?? slugifyConfigObjectName(object.title, object.id)
        : lastPart || slugifyConfigObjectName(object.title, object.id);
      return `.opencode/skills/${namespace}/${skillName}/SKILL.md`;
    }
    return existing;
  }
  const name = slugifyConfigObjectName(object.title, object.id);
  switch (object.objectType) {
    case "skill":
      return `.opencode/skills/${namespace}/${name}/SKILL.md`;
    case "agent":
      return `.opencode/agents/${namespace}/${name}.md`;
    case "command":
      return `.opencode/commands/${namespace}/${name}.md`;
    case "mcp":
      return `.opencode/mcps/${namespace}/${name}.json`;
    case "hook":
      return `.opencode/hooks/${namespace}/${name}.json`;
    case "tool":
      return `.opencode/tools/${namespace}/${name}.ts`;
    case "context":
      return `.opencode/context/${namespace}/${name}.md`;
    default:
      return `.opencode/plugins/${namespace}/${name}.txt`;
  }
}

function buildCloudSkillContent(name: string, description: string, body: string): string {
  const safeDescription = description.replace(/\s+/g, " ").trim();
  const normalizedBody = body.replace(/^\s*\n?/, "");
  return [
    "---",
    `name: ${JSON.stringify(name)}`,
    `description: ${JSON.stringify(safeDescription)}`,
    "---",
    "",
    normalizedBody,
  ].join("\n");
}

const OPENCODE_MODEL_ID_RE = /^[^\s/]+\/[^\s]+$/;

function translateClaudeTools(value: unknown): Record<string, boolean> | null {
  const names = typeof value === "string"
    ? value.split(",")
    : Array.isArray(value)
      ? value.flatMap((entry) => (typeof entry === "string" ? [entry] : []))
      : null;
  if (names) {
    const tools: Record<string, boolean> = {};
    for (const raw of names) {
      const name = raw.trim().toLowerCase();
      if (name) tools[name] = true;
    }
    return Object.keys(tools).length ? tools : null;
  }
  if (isRecord(value)) {
    const tools: Record<string, boolean> = {};
    for (const [key, entry] of Object.entries(value)) {
      const name = key.trim().toLowerCase();
      if (name && typeof entry === "boolean") tools[name] = entry;
    }
    return Object.keys(tools).length ? tools : null;
  }
  return null;
}

function translateClaudeModel(value: unknown): string | null {
  const model = readString(value);
  return model && OPENCODE_MODEL_ID_RE.test(model) ? model : null;
}

function cloudConfigObjectDescription(object: CloudPluginConfigObject): string {
  const rawDesc = (object.description?.trim() || object.title).trim();
  return rawDesc.slice(0, 1024) || object.title.slice(0, 1024);
}

function buildCloudAgentContent(description: string, rawSourceText: string): string {
  const { data, body } = parseFrontmatter(rawSourceText.trim());
  const safeDescription = (readString(data.description) ?? description).replace(/\s+/g, " ").trim();
  const model = translateClaudeModel(data.model);
  const tools = translateClaudeTools(data.tools);
  const frontmatter = buildFrontmatter({
    description: safeDescription,
    ...(model ? { model } : {}),
    ...(tools ? { tools } : {}),
  });
  return frontmatter + "\n" + body.replace(/^\s*\n?/, "");
}

function buildCloudCommandContent(name: string, description: string, rawSourceText: string): string {
  const { data, body } = parseFrontmatter(rawSourceText.trim());
  const safeDescription = (readString(data.description) ?? description).replace(/\s+/g, " ").trim();
  const model = translateClaudeModel(data.model);
  const agent = readString(data.agent);
  const frontmatter = buildFrontmatter({
    name,
    description: safeDescription,
    ...(agent ? { agent } : {}),
    ...(model ? { model } : {}),
    ...(typeof data.subtask === "boolean" ? { subtask: data.subtask } : {}),
  });
  return frontmatter + "\n" + body.replace(/^\s*\n?/, "");
}

function pluginMcpName(rawName: string, namespace: string, fallback: string, namespaceName: boolean): string {
  const trimmed = rawName.trim();
  const base = OPENCODE_MCP_NAME_RE.test(trimmed) ? trimmed : slugifyConfigObjectName(trimmed || fallback, fallback);
  if (!namespaceName) return base;
  const namespaced = base.startsWith(`${namespace}-`) ? base : `${namespace}-${base}`;
  return OPENCODE_MCP_NAME_RE.test(namespaced) ? namespaced : slugifyConfigObjectName(namespaced, fallback);
}

function mcpCommandFromConfig(config: Record<string, unknown>): string[] {
  if (Array.isArray(config.command)) return readStringArray(config.command);
  const command = readString(config.command);
  if (!command) return [];
  return [command, ...readStringArray(config.args)];
}

function normalizePluginMcpConfig(input: unknown): Record<string, unknown> | null {
  if (!isRecord(input)) return null;
  const enabled = typeof input.enabled === "boolean"
    ? input.enabled
    : typeof input.disabled === "boolean"
      ? !input.disabled
      : true;
  const url = readString(input.url);
  if (url) {
    const config: Record<string, unknown> = { type: "remote", url, enabled };
    const headers = readStringRecord(input.headers);
    if (headers) config.headers = headers;
    if (isRecord(input.oauth)) config.oauth = input.oauth;
    if (input.oauth === true) config.oauth = {};
    return config;
  }

  const command = mcpCommandFromConfig(input);
  if (command.length > 0) {
    const config: Record<string, unknown> = { type: "local", command, enabled };
    const environment = readStringRecord(input.environment) ?? readStringRecord(input.env);
    if (environment) config.environment = environment;
    return config;
  }

  return null;
}

function pluginMcpConfigsFromPayload(object: CloudPluginConfigObject, namespace: string) {
  const version = object.latestVersion;
  const payload = version?.normalizedPayloadJson ?? parseJsonRecord(version?.rawSourceText ?? null);
  if (!payload) return [];

  const configs = new Map<string, { name: string; config: Record<string, unknown>; path: string }>();
  const addConfig = (rawName: string, rawConfig: unknown, namespaceName: boolean) => {
    const config = normalizePluginMcpConfig(rawConfig);
    if (!config) return;
    const name = pluginMcpName(rawName, namespace, object.id, namespaceName);
    configs.set(name, {
      name,
      config,
      path: `${OPENCODE_MCP_IMPORT_PATH_PREFIX}${name}`,
    });
  };

  if (isRecord(payload.mcp)) {
    for (const [name, config] of Object.entries(payload.mcp)) addConfig(name, config, false);
  }
  if (isRecord(payload.mcpServers)) {
    for (const [name, config] of Object.entries(payload.mcpServers)) addConfig(name, config, false);
  }
  if (configs.size === 0) addConfig(object.title, payload, true);

  return [...configs.values()];
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

function runtimeDbPath(config: ServerConfig): string {
  const override = process.env.OPENWORK_RUNTIME_DB?.trim();
  if (override) return resolve(override);
  const configPath = config.configPath?.trim();
  const configDir = configPath ? dirname(configPath) : resolve(homedir(), ".config", "openwork");
  return resolve(configDir, "runtime.sqlite");
}

async function openCloudPluginDb(path: string): Promise<CloudPluginDb> {
  await ensureDir(dirname(path));
  if (typeof process.versions.bun === "string") {
    const { Database } = await import("bun:sqlite");
    const { drizzle } = await import("drizzle-orm/bun-sqlite");
    const sqlite = new Database(path, { create: true });
    sqlite.run("CREATE TABLE IF NOT EXISTS cloud_plugin_install_configs (workspace_id TEXT PRIMARY KEY NOT NULL, config_json TEXT NOT NULL, updated_at INTEGER NOT NULL)");
    const db = drizzle(sqlite);
    return {
      get: (workspaceId) => db
        .select()
        .from(cloudPluginInstallConfigs)
        .where(eq(cloudPluginInstallConfigs.workspaceId, workspaceId))
        .get(),
      upsert: ({ workspaceId, configJson, updatedAt }) => {
        db
          .insert(cloudPluginInstallConfigs)
          .values({ workspaceId, configJson, updatedAt })
          .onConflictDoUpdate({
            target: cloudPluginInstallConfigs.workspaceId,
            set: { configJson, updatedAt },
          })
          .run();
      },
    };
  }
  const { DatabaseSync } = await import("node:sqlite");
  const sqlite = new DatabaseSync(path);
  sqlite.exec("CREATE TABLE IF NOT EXISTS cloud_plugin_install_configs (workspace_id TEXT PRIMARY KEY NOT NULL, config_json TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  const get = sqlite.prepare("SELECT config_json AS configJson FROM cloud_plugin_install_configs WHERE workspace_id = ?");
  const upsert = sqlite.prepare("INSERT INTO cloud_plugin_install_configs (workspace_id, config_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(workspace_id) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at");
  return {
    get: (workspaceId) => {
      const row = get.get(workspaceId);
      if (!isRecord(row) || typeof row.configJson !== "string") return undefined;
      return { configJson: row.configJson };
    },
    upsert: ({ workspaceId, configJson, updatedAt }) => {
      upsert.run(workspaceId, configJson, updatedAt);
    },
  };
}

const dbByPath = new Map<string, Promise<CloudPluginDb>>();

async function cloudPluginDb(config: ServerConfig): Promise<CloudPluginDb> {
  const path = runtimeDbPath(config);
  const existing = dbByPath.get(path);
  if (existing) return existing;
  const db = openCloudPluginDb(path);
  dbByPath.set(path, db);
  return db;
}

export async function readInstalledCloudPlugins(config: ServerConfig, workspaceId: string): Promise<WorkspaceCloudImports> {
  const db = await cloudPluginDb(config);
  const row = db.get(workspaceId);
  if (!row) return readCloudImports({});
  try {
    return readCloudImports({ cloudImports: JSON.parse(row.configJson) });
  } catch {
    return readCloudImports({});
  }
}

async function writeInstalledCloudPlugins(
  config: ServerConfig,
  workspaceId: string,
  updater: (current: WorkspaceCloudImports) => WorkspaceCloudImports,
): Promise<WorkspaceCloudImports> {
  const db = await cloudPluginDb(config);
  const next = updater(await readInstalledCloudPlugins(config, workspaceId));
  db.upsert({ workspaceId, configJson: JSON.stringify(next), updatedAt: Date.now() });
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

async function writePluginWorkspaceFile(workspaceRoot: string, path: string, content: string): Promise<void> {
  const absolutePath = resolveWorkspaceInstallPath(workspaceRoot, path);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content.endsWith("\n") ? content : `${content}\n`, "utf8");
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

export async function installCloudPlugin(input: {
  serverConfig: ServerConfig;
  workspaceId: string;
  workspaceRoot: string;
  marketplaceId: string | null;
  marketplace?: { id: string; name: string; updatedAt: string | null } | null;
  resolved: CloudPluginResolved;
}): Promise<CloudImportedPlugin> {
  const namespace = pluginNamespace(input.resolved.plugin.name, input.resolved.plugin.id);
  const cloudImports = await readInstalledCloudPlugins(input.serverConfig, input.workspaceId);
  const existing = cloudImports.plugins[input.resolved.plugin.id];
  const files: CloudImportedPluginFile[] = [];

  for (const membership of input.resolved.memberships) {
    const object = membership.configObject;
    const version = object?.latestVersion ?? null;
    if (!object || object.status !== "active") continue;

    if (object.objectType === "mcp") {
      const configs = pluginMcpConfigsFromPayload(object, namespace);
      for (const config of configs) {
        await addMcp(input.serverConfig, input.workspaceId, config.name, config.config);
        files.push({
          configObjectId: object.id,
          versionId: version?.id ?? null,
          objectType: object.objectType,
          title: object.title,
          path: config.path,
          updatedAt: object.updatedAt,
        });
      }
      continue;
    }

    if (version?.rawSourceText == null) continue;

    const path = getPluginObjectInstallPath(object, namespace);
    let content = version.rawSourceText;
    if (object.objectType === "skill") {
      const description = cloudConfigObjectDescription(object) || "Skill";
      const installName = path.match(/^\.opencode\/skills\/[^/]+\/([^/]+)\/SKILL\.md$/)?.[1] ?? slugifyConfigObjectName(object.title, object.id);
      content = buildCloudSkillContent(installName, description, extractSkillBodyMarkdown(content));
    } else if (object.objectType === "agent") {
      content = buildCloudAgentContent(cloudConfigObjectDescription(object), content);
    } else if (object.objectType === "command") {
      const fileName = path.match(/\/([^/]+)\.md$/)?.[1] ?? object.title;
      content = buildCloudCommandContent(slugifyConfigObjectName(fileName, object.id), cloudConfigObjectDescription(object), content);
    }
    await writePluginWorkspaceFile(input.workspaceRoot, path, content);
    files.push({
      configObjectId: object.id,
      versionId: version.id,
      objectType: object.objectType,
      title: object.title,
      path,
      updatedAt: object.updatedAt,
    });
  }

  const nextPaths = new Set(files.map((file) => file.path));
  const removedMcpNames = (existing?.files ?? []).flatMap((file) => {
    const name = file.objectType === "mcp" && !nextPaths.has(file.path) ? cloudPluginMcpNameFromPath(file.path) : null;
    return name ? [name] : [];
  });
  await Promise.all(removedMcpNames.map((name) => removeMcp(input.serverConfig, input.workspaceId, name)));

  const imported: CloudImportedPlugin = {
    pluginId: input.resolved.plugin.id,
    marketplaceId: input.marketplaceId,
    name: input.resolved.plugin.name,
    description: input.resolved.plugin.description,
    updatedAt: input.resolved.plugin.updatedAt,
    files,
    importedAt: existing?.importedAt ?? Date.now(),
  };

  const nextPlugins = {
    ...cloudImports.plugins,
    [input.resolved.plugin.id]: imported,
  };

  let nextMarketplaces = cloudImports.marketplaces;
  if (input.marketplaceId) {
    const existingMarketplace = cloudImports.marketplaces[input.marketplaceId];
    const pluginIds = new Set(existingMarketplace?.pluginIds ?? []);
    pluginIds.add(input.resolved.plugin.id);
    nextMarketplaces = {
      ...cloudImports.marketplaces,
      [input.marketplaceId]: {
        marketplaceId: input.marketplaceId,
        name: input.marketplace?.name ?? existingMarketplace?.name ?? input.marketplaceId,
        updatedAt: input.marketplace?.updatedAt ?? existingMarketplace?.updatedAt ?? null,
        pluginIds: [...pluginIds].sort(),
        importedAt: existingMarketplace?.importedAt ?? Date.now(),
      },
    };
  }

  await writeInstalledCloudPlugins(input.serverConfig, input.workspaceId, (current) => ({
    ...current,
    marketplaces: nextMarketplaces,
    plugins: nextPlugins,
  }));

  return imported;
}

export async function removeCloudPlugin(input: {
  serverConfig: ServerConfig;
  workspaceId: string;
  workspaceRoot: string;
  pluginId: string;
}): Promise<CloudImportedPlugin> {
  const cloudImports = await readInstalledCloudPlugins(input.serverConfig, input.workspaceId);
  const imported = cloudImports.plugins[input.pluginId];
  if (!imported) throw new ApiError(404, "cloud_plugin_not_installed", "Marketplace package is not installed in this workspace.");

  await Promise.all(imported.files.map(async (file) => {
    const mcpName = file.objectType === "mcp" ? cloudPluginMcpNameFromPath(file.path) : null;
    if (mcpName) {
      await removeMcp(input.serverConfig, input.workspaceId, mcpName);
      return;
    }
    await removePluginWorkspaceFile(input.workspaceRoot, file.path);
  }));

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
