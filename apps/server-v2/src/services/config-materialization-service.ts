import fs from "node:fs";
import path from "node:path";
import { HTTPException } from "hono/http-exception";
import type { ServerRepositories } from "../database/repositories.js";
import type { JsonObject, ManagedConfigRecord, WorkspaceRecord } from "../database/types.js";
import type { ServerWorkingDirectory } from "../database/working-directory.js";
import { ensureWorkspaceConfigDir } from "../database/working-directory.js";
import { RouteError } from "../http.js";
import { requestRemoteOpenwork, resolveRemoteWorkspaceTarget } from "../adapters/remote-openwork.js";

const MANAGED_SKILL_DOMAIN = "openwork-managed";
const OPENWORK_CONFIG_VERSION = 1;

type WorkspaceConfigSnapshot = {
  effective: {
    opencode: JsonObject;
    openwork: JsonObject;
  };
  materialized: {
    compatibilityOpencodePath: string | null;
    compatibilityOpenworkPath: string | null;
    configDir: string | null;
    configOpencodePath: string | null;
    configOpenworkPath: string | null;
  };
  stored: {
    opencode: JsonObject;
    openwork: JsonObject;
  };
  updatedAt: string;
  workspaceId: string;
};

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function normalizeStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [] as string[];
  }
  return Array.from(new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)));
}

function normalizeAuthorizedFolderPath(input: string | null | undefined) {
  const trimmed = (input ?? "").trim();
  if (!trimmed) return "";
  return trimmed.replace(/[\\/]\*+$/, "");
}

function authorizedFolderToExternalDirectoryKey(folder: string) {
  const normalized = normalizeAuthorizedFolderPath(folder);
  if (!normalized) return "";
  return normalized === "/" ? "/*" : `${normalized}/*`;
}

function externalDirectoryKeyToAuthorizedFolder(key: string, value: unknown) {
  if (value !== "allow") return null;
  const trimmed = key.trim();
  if (!trimmed) return null;
  if (trimmed === "/*") return "/";
  if (!trimmed.endsWith("/*")) return null;
  return normalizeAuthorizedFolderPath(trimmed.slice(0, -2));
}

function normalizeExternalDirectory(value: unknown) {
  const folders = new Set<string>();
  const hiddenEntries: JsonObject = {};

  for (const folder of normalizeStringArray(value)) {
    const normalized = normalizeAuthorizedFolderPath(folder);
    if (normalized) {
      folders.add(normalized);
    }
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, entryValue] of Object.entries(value as JsonObject)) {
      const folder = externalDirectoryKeyToAuthorizedFolder(key, entryValue);
      if (folder) {
        folders.add(folder);
      } else {
        hiddenEntries[key] = entryValue;
      }
    }
  }

  return {
    folders: Array.from(folders),
    hiddenEntries,
  };
}

function buildExternalDirectory(folders: string[], hiddenEntries: JsonObject) {
  const next: JsonObject = { ...hiddenEntries };
  for (const folder of folders) {
    const key = authorizedFolderToExternalDirectoryKey(folder);
    if (!key) continue;
    next[key] = "allow";
  }
  return Object.keys(next).length ? next : undefined;
}

function withoutWorkspaceRoot(folders: string[], workspace: WorkspaceRecord) {
  const workspaceRoot = normalizeAuthorizedFolderPath(workspace.dataDir);
  if (!workspaceRoot) {
    return folders;
  }
  return folders.filter((folder) => normalizeAuthorizedFolderPath(folder) !== workspaceRoot);
}

function canonicalizeWorkspaceConfigState(workspace: WorkspaceRecord, config: { openwork: JsonObject; opencode: JsonObject }) {
  const nextOpenwork = asObject(config.openwork);
  nextOpenwork.authorizedRoots = withoutWorkspaceRoot(normalizeStringArray(nextOpenwork.authorizedRoots), workspace);

  const nextOpencode = asObject(config.opencode);
  const permission = asObject(nextOpencode.permission);
  const externalDirectory = normalizeExternalDirectory(permission.external_directory);
  const nextExternalDirectory = buildExternalDirectory(withoutWorkspaceRoot(externalDirectory.folders, workspace), externalDirectory.hiddenEntries);
  if (nextExternalDirectory) {
    permission.external_directory = nextExternalDirectory;
  } else {
    delete permission.external_directory;
  }
  if (Object.keys(permission).length) {
    nextOpencode.permission = permission;
  } else {
    delete nextOpencode.permission;
  }

  return {
    openwork: nextOpenwork,
    opencode: nextOpencode,
  };
}

function mergeObjects(base: JsonObject, patch: JsonObject): JsonObject {
  const next: JsonObject = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      base[key] &&
      typeof base[key] === "object" &&
      !Array.isArray(base[key])
    ) {
      next[key] = mergeObjects(asObject(base[key]), asObject(value));
      continue;
    }
    next[key] = value;
  }
  return next;
}

function writeJsonFile(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJsonFile(filePath: string) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as JsonObject;
  } catch {
    return null;
  }
}

function readJsoncFile(filePath: string) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return asObject(parseJsoncText(fs.readFileSync(filePath, "utf8")));
  } catch {
    return null;
  }
}

function parseJsoncText(content: string) {
  const withoutLineComments = content.replace(/^\s*\/\/.*$/gm, "");
  const withoutBlockComments = withoutLineComments.replace(/\/\*[\s\S]*?\*\//g, "");
  const withoutTrailingCommas = withoutBlockComments.replace(/,\s*([}\]])/g, "$1");
  return JSON.parse(withoutTrailingCommas);
}

function normalizePluginKey(spec: string) {
  const trimmed = spec.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.startsWith("@")) {
    const atIndex = trimmed.indexOf("@", 1);
    return atIndex > 0 ? trimmed.slice(0, atIndex) : trimmed;
  }
  const atIndex = trimmed.indexOf("@");
  return atIndex > 0 ? trimmed.slice(0, atIndex) : trimmed;
}

function nowIso() {
  return new Date().toISOString();
}

function parseManagedSkillMetadata(content: string, fallbackName: string) {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const nameMatch = frontmatter?.[1]?.match(/^name:\s*(.+)$/m);
  const descriptionMatch = frontmatter?.[1]?.match(/^description:\s*(.+)$/m);
  const displayName = nameMatch?.[1]?.trim() || fallbackName;
  const key = displayName.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || fallbackName;
  return {
    description: descriptionMatch?.[1]?.trim() || displayName,
    displayName,
    key,
  };
}

function readManagedSkillFiles(rootDir: string | null) {
  if (!rootDir || !fs.existsSync(rootDir)) {
    return [] as Array<{ content: string; key: string; path: string }>;
  }

  const items: Array<{ content: string; key: string; path: string }> = [];
  const visit = (directory: string, depth: number) => {
    if (depth > 2) {
      return;
    }
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const direct = path.join(directory, entry.name, "SKILL.md");
      if (fs.existsSync(direct) && fs.statSync(direct).isFile()) {
        items.push({ content: fs.readFileSync(direct, "utf8"), key: entry.name, path: direct });
        continue;
      }
      visit(path.join(directory, entry.name), depth + 1);
    }
  };

  visit(rootDir, 0);
  return items;
}

function extractRecognizedOpencodeSections(opencode: JsonObject) {
  const base = { ...opencode };
  const plugins = Array.isArray(base.plugin)
    ? base.plugin.filter((value): value is string => typeof value === "string" && Boolean(value.trim())).map((value) => value.trim())
    : typeof base.plugin === "string" && base.plugin.trim()
      ? [base.plugin.trim()]
      : [];
  const mcps = asObject(base.mcp);
  const providers = asObject((base as Record<string, unknown>).provider);
  delete base.plugin;
  delete base.mcp;
  delete (base as Record<string, unknown>).provider;

  return {
    base,
    mcps: Object.entries(mcps).map(([key, value]) => ({ config: asObject(value), displayName: key, key })),
    plugins: plugins.map((spec) => ({
      config: { spec },
      displayName: normalizePluginKey(spec) || spec,
      key: normalizePluginKey(spec) || spec,
    })),
    providers: Object.entries(providers).map(([key, value]) => ({ config: asObject(value), displayName: key, key })),
  };
}

function dedupeAssignments(items: string[]) {
  return Array.from(new Set(items.filter(Boolean)));
}

export type ConfigMaterializationService = ReturnType<typeof createConfigMaterializationService>;
export type { WorkspaceConfigSnapshot };

export function createConfigMaterializationService(input: {
  repositories: ServerRepositories;
  serverId: string;
  workingDirectory: ServerWorkingDirectory;
}) {
  function getWorkspaceOrThrow(workspaceId: string) {
    const workspace = input.repositories.workspaces.getById(workspaceId);
    if (!workspace) {
      throw new HTTPException(404, { message: `Workspace not found: ${workspaceId}` });
    }
    return workspace;
  }

  function getRemoteServerOrThrow(workspace: WorkspaceRecord) {
    const server = input.repositories.servers.getById(workspace.serverId);
    if (!server) {
      throw new RouteError(502, "bad_gateway", `Workspace ${workspace.id} points at missing remote server ${workspace.serverId}.`);
    }
    return server;
  }

  function ensureWorkspaceLocal(workspace: WorkspaceRecord) {
    if (workspace.kind === "remote") {
      throw new RouteError(
        501,
        "not_implemented",
        "Phase 7 local file/config ownership currently supports local, control, and help workspaces only. Remote config and file mutation stay on the direct remote path during migration.",
      );
    }
  }

  function workspaceOpencodeConfigPath(workspace: WorkspaceRecord) {
    const configDir = workspace.configDir?.trim();
    if (!configDir) {
      throw new RouteError(500, "internal_error", `Workspace ${workspace.id} is missing its config directory.`);
    }
    return path.join(configDir, "opencode.jsonc");
  }

  function workspaceOpenworkConfigPath(workspace: WorkspaceRecord) {
    const configDir = workspace.configDir?.trim();
    if (!configDir) {
      throw new RouteError(500, "internal_error", `Workspace ${workspace.id} is missing its config directory.`);
    }
    return path.join(configDir, ".opencode", "openwork.json");
  }

  function compatibilityOpencodeConfigPath(workspace: WorkspaceRecord) {
    const dataDir = workspace.dataDir?.trim();
    return dataDir ? path.join(dataDir, "opencode.jsonc") : null;
  }

  function compatibilityOpenworkConfigPath(workspace: WorkspaceRecord) {
    const dataDir = workspace.dataDir?.trim();
    return dataDir ? path.join(dataDir, ".opencode", "openwork.json") : null;
  }

  function workspaceSkillRoots(workspace: WorkspaceRecord) {
    const configDir = workspace.configDir?.trim();
    const dataDir = workspace.dataDir?.trim();
    return {
      compatibility: dataDir ? path.join(dataDir, ".opencode", "skills", MANAGED_SKILL_DOMAIN) : null,
      managedConfig: configDir ? path.join(configDir, ".opencode", "skills", MANAGED_SKILL_DOMAIN) : null,
      sourceConfig: configDir ? path.join(configDir, ".opencode", "skills") : null,
      sourceData: dataDir ? path.join(dataDir, ".opencode", "skills") : null,
    };
  }

  function derivePreset(workspace: WorkspaceRecord) {
    const notes = asObject(workspace.notes);
    const legacyDesktop = asObject(notes.legacyDesktop);
    const preset = typeof legacyDesktop.preset === "string" ? legacyDesktop.preset.trim() : "";
    if (preset) {
      return preset;
    }
    return workspace.kind === "local" ? "starter" : "remote";
  }

  function buildDefaultOpenwork(workspace: WorkspaceRecord) {
    return {
      authorizedRoots: [],
      blueprint: null,
      reload: null,
      version: OPENWORK_CONFIG_VERSION,
      workspace: {
        configDir: workspace.configDir,
        createdAt: Date.parse(workspace.createdAt) || Date.now(),
        dataDir: workspace.dataDir,
        name: workspace.displayName,
        preset: derivePreset(workspace),
      },
    } satisfies JsonObject;
  }

  function buildDefaultOpencode() {
    return {
      $schema: "https://opencode.ai/config.json",
    } satisfies JsonObject;
  }

  function ensureServerConfigState() {
    const existing = input.repositories.serverConfigState.getByServerId(input.serverId);
    if (existing) {
      return existing;
    }
    return input.repositories.serverConfigState.upsert({
      opencode: buildDefaultOpencode(),
      serverId: input.serverId,
    });
  }

  function readLegacyWorkspaceState(workspace: WorkspaceRecord) {
    const openwork =
      readJsonFile(workspaceOpenworkConfigPath(workspace))
      ?? (compatibilityOpenworkConfigPath(workspace) ? readJsonFile(compatibilityOpenworkConfigPath(workspace)!) : null)
      ?? buildDefaultOpenwork(workspace);
    const opencode =
      readJsoncFile(workspaceOpencodeConfigPath(workspace))
      ?? (compatibilityOpencodeConfigPath(workspace) ? readJsoncFile(compatibilityOpencodeConfigPath(workspace)!) : null)
      ?? buildDefaultOpencode();
    return {
      openwork: asObject(openwork),
      opencode: asObject(opencode),
    };
  }

  function ensureWorkspaceConfigState(workspace: WorkspaceRecord) {
    ensureWorkspaceLocal(workspace);
    ensureWorkspaceConfigDir(input.workingDirectory, workspace.id);
    const existing = input.repositories.workspaceConfigState.getByWorkspaceId(workspace.id);
    if (existing) {
      return existing;
    }
    const legacy = readLegacyWorkspaceState(workspace);
    const canonical = canonicalizeWorkspaceConfigState(workspace, legacy);
    return input.repositories.workspaceConfigState.upsert({
      openwork: canonical.openwork,
      opencode: canonical.opencode,
      workspaceId: workspace.id,
    });
  }

  function upsertManagedRecords(
    workspaceId: string,
    kind: "mcps" | "plugins" | "providerConfigs",
    items: Array<{ config: JsonObject; displayName: string; key: string }>,
  ) {
    if (kind === "mcps") {
      const ids = items.map((item) => input.repositories.mcps.upsert({
        auth: null,
        cloudItemId: null,
        config: item.config,
        displayName: item.displayName,
        id: `mcp_${workspaceId}_${item.key}`,
        key: item.key,
        metadata: { absorbed: true, workspaceId },
        source: "imported",
      }).id);
      input.repositories.workspaceMcps.replaceAssignments(workspaceId, dedupeAssignments(ids));
      return;
    }

    if (kind === "plugins") {
      const ids = items.map((item) => input.repositories.plugins.upsert({
        auth: null,
        cloudItemId: null,
        config: item.config,
        displayName: item.displayName,
        id: `plugin_${workspaceId}_${item.key}`,
        key: item.key,
        metadata: { absorbed: true, workspaceId },
        source: "imported",
      }).id);
      input.repositories.workspacePlugins.replaceAssignments(workspaceId, dedupeAssignments(ids));
      return;
    }

    const ids = items.map((item) => input.repositories.providerConfigs.upsert({
      auth: null,
      cloudItemId: null,
      config: item.config,
      displayName: item.displayName,
      id: `provider_${workspaceId}_${item.key}`,
      key: item.key,
      metadata: { absorbed: true, workspaceId },
      source: "imported",
    }).id);
    input.repositories.workspaceProviderConfigs.replaceAssignments(workspaceId, dedupeAssignments(ids));
  }

  function absorbManagedSkills(workspace: WorkspaceRecord) {
    const items = [
      ...readManagedSkillFiles(workspaceSkillRoots(workspace).sourceConfig),
      ...readManagedSkillFiles(workspaceSkillRoots(workspace).sourceData),
    ];
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const item of items) {
      const meta = parseManagedSkillMetadata(item.content, item.key);
      if (!meta.key || seen.has(meta.key)) {
        continue;
      }
      seen.add(meta.key);
      ids.push(input.repositories.skills.upsert({
        auth: null,
        cloudItemId: null,
        config: { content: item.content },
        displayName: meta.displayName,
        id: `skill_${workspace.id}_${meta.key}`,
        key: meta.key,
        metadata: {
          absorbed: true,
          description: meta.description,
          originPath: item.path,
          workspaceId: workspace.id,
        },
        source: "imported",
      }).id);
    }
    input.repositories.workspaceSkills.replaceAssignments(workspace.id, dedupeAssignments(ids));
  }

  function absorbWorkspaceConfigState(workspace: WorkspaceRecord) {
    ensureWorkspaceConfigState(workspace);
    const legacy = readLegacyWorkspaceState(workspace);
    const recognized = extractRecognizedOpencodeSections(legacy.opencode);
    upsertManagedRecords(workspace.id, "mcps", recognized.mcps);
    upsertManagedRecords(workspace.id, "plugins", recognized.plugins);
    upsertManagedRecords(workspace.id, "providerConfigs", recognized.providers);
    absorbManagedSkills(workspace);
    const canonical = canonicalizeWorkspaceConfigState(workspace, {
      openwork: mergeObjects(buildDefaultOpenwork(workspace), legacy.openwork),
      opencode: mergeObjects(buildDefaultOpencode(), recognized.base),
    });
    return input.repositories.workspaceConfigState.upsert({
      openwork: canonical.openwork,
      opencode: canonical.opencode,
      workspaceId: workspace.id,
    });
  }

  function listAssignedRecords(
    workspaceId: string,
    assignmentTable: "workspaceMcps" | "workspacePlugins" | "workspaceProviderConfigs",
    repo: "mcps" | "plugins" | "providerConfigs",
  ) {
    return input.repositories[assignmentTable]
      .listForWorkspace(workspaceId)
      .map((assignment) => input.repositories[repo].getById(assignment.itemId))
      .filter(Boolean) as ManagedConfigRecord[];
  }

  function listAssignedSkills(workspaceId: string) {
    return input.repositories.workspaceSkills
      .listForWorkspace(workspaceId)
      .map((assignment) => input.repositories.skills.getById(assignment.itemId))
      .filter(Boolean) as ManagedConfigRecord[];
  }

  function computeSnapshot(workspace: WorkspaceRecord): WorkspaceConfigSnapshot {
    const workspaceState = ensureWorkspaceConfigState(workspace);
    const serverState = ensureServerConfigState();
    const canonicalState = canonicalizeWorkspaceConfigState(workspace, {
      openwork: workspaceState.openwork,
      opencode: workspaceState.opencode,
    });
    const storedOpenwork = mergeObjects(buildDefaultOpenwork(workspace), canonicalState.openwork);
    const storedOpencode = mergeObjects(buildDefaultOpencode(), canonicalState.opencode);
    const effectiveOpenwork = mergeObjects(buildDefaultOpenwork(workspace), storedOpenwork);
    const effectiveOpencode = mergeObjects(asObject(serverState.opencode), storedOpencode);

    const mcps = listAssignedRecords(workspace.id, "workspaceMcps", "mcps");
    if (mcps.length) {
      effectiveOpencode.mcp = Object.fromEntries(mcps.map((item) => [item.key ?? item.displayName, item.config]));
    }

    const plugins = listAssignedRecords(workspace.id, "workspacePlugins", "plugins");
    if (plugins.length) {
      effectiveOpencode.plugin = plugins.map((item) => {
        const config = asObject(item.config);
        return typeof config.spec === "string" && config.spec.trim() ? config.spec.trim() : item.key ?? item.displayName;
      }).filter(Boolean);
    }

    const providers = listAssignedRecords(workspace.id, "workspaceProviderConfigs", "providerConfigs");
    if (providers.length) {
      (effectiveOpencode as Record<string, unknown>).provider = Object.fromEntries(
        providers.map((item) => [item.key ?? item.displayName, item.config]),
      );
    }

    const permission = asObject(effectiveOpencode.permission);
    const externalDirectory = normalizeExternalDirectory(permission.external_directory);
    const authorizedRoots = withoutWorkspaceRoot(normalizeStringArray([
      ...normalizeStringArray(effectiveOpenwork.authorizedRoots),
      ...externalDirectory.folders,
    ]), workspace);
    const nextExternalDirectory = buildExternalDirectory(authorizedRoots, externalDirectory.hiddenEntries);
    if (nextExternalDirectory) {
      permission.external_directory = nextExternalDirectory;
    } else {
      delete permission.external_directory;
    }
    effectiveOpencode.permission = permission;
    effectiveOpenwork.authorizedRoots = authorizedRoots;

    return {
      effective: {
        opencode: effectiveOpencode,
        openwork: effectiveOpenwork,
      },
      materialized: {
        compatibilityOpencodePath: compatibilityOpencodeConfigPath(workspace),
        compatibilityOpenworkPath: compatibilityOpenworkConfigPath(workspace),
        configDir: workspace.configDir,
        configOpencodePath: workspaceOpencodeConfigPath(workspace),
        configOpenworkPath: workspaceOpenworkConfigPath(workspace),
      },
      stored: {
        opencode: storedOpencode,
        openwork: storedOpenwork,
      },
      updatedAt: workspaceState.updatedAt,
      workspaceId: workspace.id,
    };
  }

  function materializeSkills(workspace: WorkspaceRecord) {
    const skills = listAssignedSkills(workspace.id);
    const roots = workspaceSkillRoots(workspace);
    if (roots.managedConfig) {
      fs.rmSync(roots.managedConfig, { force: true, recursive: true });
      fs.mkdirSync(roots.managedConfig, { recursive: true });
    }
    if (roots.compatibility) {
      fs.rmSync(roots.compatibility, { force: true, recursive: true });
      fs.mkdirSync(roots.compatibility, { recursive: true });
    }
    for (const skill of skills) {
      const content = typeof asObject(skill.config).content === "string" ? String(asObject(skill.config).content) : "";
      if (!content) {
        continue;
      }
      const skillKey = skill.key?.trim() || skill.id;
      if (roots.managedConfig) {
        const destination = path.join(roots.managedConfig, skillKey, "SKILL.md");
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, content.endsWith("\n") ? content : `${content}\n`, "utf8");
      }
      if (roots.compatibility) {
        const meta = asObject(skill.metadata);
        const originPath = typeof meta.originPath === "string" ? meta.originPath : "";
        if (originPath && workspace.dataDir && originPath.startsWith(workspace.dataDir)) {
          continue;
        }
        const destination = path.join(roots.compatibility, skillKey, "SKILL.md");
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, content.endsWith("\n") ? content : `${content}\n`, "utf8");
      }
    }
  }

  function materializeWorkspaceSnapshot(workspaceId: string) {
    const workspace = getWorkspaceOrThrow(workspaceId);
    ensureWorkspaceLocal(workspace);
    const snapshot = computeSnapshot(workspace);
    writeJsonFile(snapshot.materialized.configOpencodePath!, snapshot.effective.opencode);
    writeJsonFile(snapshot.materialized.configOpenworkPath!, snapshot.effective.openwork);
    if (snapshot.materialized.compatibilityOpencodePath) {
      writeJsonFile(snapshot.materialized.compatibilityOpencodePath, snapshot.effective.opencode);
    }
    if (snapshot.materialized.compatibilityOpenworkPath) {
      writeJsonFile(snapshot.materialized.compatibilityOpenworkPath, snapshot.effective.openwork);
    }
    materializeSkills(workspace);
    return snapshot;
  }

  function readRawProjectOpencodeConfig(workspaceId: string) {
    const snapshot = materializeWorkspaceSnapshot(workspaceId);
    return {
      content: `${JSON.stringify(snapshot.effective.opencode, null, 2)}\n`,
      exists: true,
      path: snapshot.materialized.configOpencodePath,
      updatedAt: snapshot.updatedAt,
    };
  }

  function readRawGlobalOpencodeConfig() {
    const state = ensureServerConfigState();
    const opencode = mergeObjects(buildDefaultOpencode(), state.opencode);
    const filePath = path.join(input.workingDirectory.managedDir, "opencode.global.jsonc");
    writeJsonFile(filePath, opencode);
    return {
      content: `${JSON.stringify(opencode, null, 2)}\n`,
      exists: true,
      path: filePath,
      updatedAt: state.updatedAt,
    };
  }

  return {
    absorbWorkspaceConfig(workspaceId: string) {
      const workspace = getWorkspaceOrThrow(workspaceId);
      ensureWorkspaceLocal(workspace);
      absorbWorkspaceConfigState(workspace);
      return materializeWorkspaceSnapshot(workspaceId);
    },

    ensureWorkspaceConfig(workspaceId: string) {
      const workspace = getWorkspaceOrThrow(workspaceId);
      ensureWorkspaceLocal(workspace);
      ensureWorkspaceConfigState(workspace);
      return materializeWorkspaceSnapshot(workspaceId);
    },

    async getWorkspaceConfigSnapshot(workspaceId: string) {
      const workspace = getWorkspaceOrThrow(workspaceId);
      if (workspace.kind === "remote") {
        const server = getRemoteServerOrThrow(workspace);
        const target = resolveRemoteWorkspaceTarget(server, workspace);
        return requestRemoteOpenwork<WorkspaceConfigSnapshot>({
          path: `/workspaces/${encodeURIComponent(target.remoteWorkspaceId)}/config`,
          server,
          timeoutMs: 10_000,
        });
      }
      ensureWorkspaceLocal(workspace);
      return computeSnapshot(workspace);
    },

    listWatchRoots(workspaceId: string) {
      const workspace = getWorkspaceOrThrow(workspaceId);
      ensureWorkspaceLocal(workspace);
      return [
        workspace.configDir,
        workspace.dataDir,
        workspace.dataDir ? path.join(workspace.dataDir, ".opencode") : null,
      ].filter((value): value is string => Boolean(value));
    },

    async patchWorkspaceConfig(workspaceId: string, patch: { openwork?: JsonObject; opencode?: JsonObject }) {
      const workspace = getWorkspaceOrThrow(workspaceId);
      if (workspace.kind === "remote") {
        const server = getRemoteServerOrThrow(workspace);
        const target = resolveRemoteWorkspaceTarget(server, workspace);
        return requestRemoteOpenwork<WorkspaceConfigSnapshot>({
          body: patch,
          method: "PATCH",
          path: `/workspaces/${encodeURIComponent(target.remoteWorkspaceId)}/config`,
          server,
          timeoutMs: 15_000,
        });
      }
      ensureWorkspaceLocal(workspace);
      const current = ensureWorkspaceConfigState(workspace);
      const nextOpenwork = patch.openwork ? mergeObjects(current.openwork, asObject(patch.openwork)) : current.openwork;
      let nextOpencode = current.opencode;
      if (patch.opencode) {
        const merged = mergeObjects(current.opencode, asObject(patch.opencode));
        const recognized = extractRecognizedOpencodeSections(merged);
        upsertManagedRecords(workspace.id, "mcps", recognized.mcps);
        upsertManagedRecords(workspace.id, "plugins", recognized.plugins);
        upsertManagedRecords(workspace.id, "providerConfigs", recognized.providers);
        nextOpencode = recognized.base;
      }
      const canonical = canonicalizeWorkspaceConfigState(workspace, {
        openwork: nextOpenwork,
        opencode: nextOpencode,
      });
      input.repositories.workspaceConfigState.upsert({
        openwork: canonical.openwork,
        opencode: canonical.opencode,
        workspaceId: workspace.id,
      });
      return materializeWorkspaceSnapshot(workspaceId);
    },

    async readRawOpencodeConfig(workspaceId: string, scope: "global" | "project") {
      const workspace = getWorkspaceOrThrow(workspaceId);
      if (workspace.kind === "remote") {
        const server = getRemoteServerOrThrow(workspace);
        const target = resolveRemoteWorkspaceTarget(server, workspace);
        const query = `?scope=${encodeURIComponent(scope)}`;
        return requestRemoteOpenwork<{ content: string; exists: boolean; path: string | null; updatedAt: string }>({
          path: `/workspaces/${encodeURIComponent(target.remoteWorkspaceId)}/config/opencode-raw${query}`,
          server,
          timeoutMs: 10_000,
        });
      }
      return scope === "global" ? readRawGlobalOpencodeConfig() : readRawProjectOpencodeConfig(workspaceId);
    },

    reconcileAllWorkspaces() {
      const workspaces = input.repositories.workspaces.list({ includeHidden: true }).filter((workspace) => workspace.kind !== "remote");
      for (const workspace of workspaces) {
        absorbWorkspaceConfigState(workspace);
        materializeWorkspaceSnapshot(workspace.id);
      }
      return {
        reconciledAt: nowIso(),
        workspaceIds: workspaces.map((workspace) => workspace.id),
      };
    },

    writeGlobalOpencodeConfig(content: string) {
      const parsed = asObject(parseJsoncText(content));
      const recognized = extractRecognizedOpencodeSections(parsed);
      if (recognized.mcps.length || recognized.plugins.length || recognized.providers.length) {
        throw new RouteError(
          400,
          "invalid_request",
          "Global raw OpenCode config writes cannot include workspace-managed MCP, plugin, or provider sections during Phase 7.",
        );
      }
      input.repositories.serverConfigState.upsert({
        opencode: recognized.base,
        serverId: input.serverId,
      });
      return readRawGlobalOpencodeConfig();
    },

    async writeWorkspaceRawOpencodeConfig(workspaceId: string, content: string) {
      const workspace = getWorkspaceOrThrow(workspaceId);
      if (workspace.kind === "remote") {
        const server = getRemoteServerOrThrow(workspace);
        const target = resolveRemoteWorkspaceTarget(server, workspace);
        return requestRemoteOpenwork<{ content: string; exists: boolean; path: string | null; updatedAt: string }>({
          body: { content, scope: "project" },
          method: "POST",
          path: `/workspaces/${encodeURIComponent(target.remoteWorkspaceId)}/config/opencode-raw`,
          server,
          timeoutMs: 15_000,
        });
      }
      ensureWorkspaceLocal(workspace);
      const parsed = asObject(parseJsoncText(content));
      const recognized = extractRecognizedOpencodeSections(parsed);
      upsertManagedRecords(workspace.id, "mcps", recognized.mcps);
      upsertManagedRecords(workspace.id, "plugins", recognized.plugins);
      upsertManagedRecords(workspace.id, "providerConfigs", recognized.providers);
      const canonical = canonicalizeWorkspaceConfigState(workspace, {
        openwork: ensureWorkspaceConfigState(workspace).openwork,
        opencode: recognized.base,
      });
      input.repositories.workspaceConfigState.upsert({
        openwork: canonical.openwork,
        opencode: canonical.opencode,
        workspaceId: workspace.id,
      });
      return readRawProjectOpencodeConfig(workspaceId);
    },
  };
}
