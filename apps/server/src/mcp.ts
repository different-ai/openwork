import { minimatch } from "minimatch";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { McpItem } from "./types.js";
import { readJsoncFile, updateJsoncPath, updateJsoncTopLevel } from "./jsonc.js";
import { opencodeConfigPath } from "./workspace-files.js";
import { validateMcpConfig, validateMcpName } from "./validators.js";
import { ApiError } from "./errors.js";

function globalOpenCodeConfigPath(): string {
  // Match the runtime's effective HOME first; tests and hosted workers may intentionally
  // point HOME at a different config root than os.homedir().
  const home = process.env.HOME?.trim() || homedir();
  const base = join(home, ".config", "opencode");
  const jsonc = join(base, "opencode.jsonc");
  const json = join(base, "opencode.json");
  if (existsSync(jsonc)) return jsonc;
  if (existsSync(json)) return json;
  return jsonc; // fall back to jsonc (readJsoncFile handles missing files gracefully)
}

function getMcpConfig(config: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const mcp = config.mcp;
  if (!mcp || typeof mcp !== "object") return {};
  return mcp as Record<string, Record<string, unknown>>;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isConfiguredMcp(entry: Record<string, unknown> | undefined): entry is Record<string, unknown> {
  // Keep in sync with OpenCode MCP transport types.
  return entry?.type === "local" || entry?.type === "remote";
}

function isDisabledOverride(entry: Record<string, unknown> | undefined): boolean {
  return entry?.enabled === false && !isConfiguredMcp(entry);
}

function getDeniedToolPatterns(config: Record<string, unknown>): string[] {
  const tools = config.tools;
  if (!tools || typeof tools !== "object") return [];
  const deny = (tools as { deny?: unknown }).deny;
  if (!Array.isArray(deny)) return [];
  return deny.filter((item) => typeof item === "string") as string[];
}

function isMcpDisabledByTools(config: Record<string, unknown>, name: string): boolean {
  const patterns = getDeniedToolPatterns(config);
  if (patterns.length === 0) return false;
  const candidates = [`mcp.${name}`, `mcp.${name}.*`, `mcp:${name}`, `mcp:${name}:*`, "mcp.*", "mcp:*"];
  return patterns.some((pattern) => candidates.some((candidate) => minimatch(candidate, pattern)));
}

export async function listMcp(workspaceRoot: string): Promise<McpItem[]> {
  const { data: config } = await readJsoncFile(opencodeConfigPath(workspaceRoot), {} as Record<string, unknown>);
  const { data: globalConfig } = await readJsoncFile(globalOpenCodeConfigPath(), {} as Record<string, unknown>);

  const projectMcpMap = getMcpConfig(config);
  const globalMcpMap = getMcpConfig(globalConfig);

  const items: McpItem[] = [];

  // Global MCPs first; project-level entries override global ones with the same name.
  for (const [name, entry] of Object.entries(globalMcpMap)) {
    if (!isConfiguredMcp(entry)) continue;
    const projectEntry = projectMcpMap[name];
    if (hasOwn(projectMcpMap, name)) {
      if (isDisabledOverride(projectEntry) && isConfiguredMcp(entry)) {
        items.push({
          name,
          config: { ...entry, enabled: false },
          source: "config.project",
          inherited: true,
          disabledByTools:
            (isMcpDisabledByTools(globalConfig, name) || isMcpDisabledByTools(config, name)) || undefined,
        });
      }
      continue;
    }
    items.push({
      name,
      config: entry,
      source: "config.global",
      inherited: true,
      disabledByTools:
        (isMcpDisabledByTools(globalConfig, name) || isMcpDisabledByTools(config, name)) || undefined,
    });
  }

  // Project MCPs (highest priority).
  for (const [name, entry] of Object.entries(projectMcpMap)) {
    if (isDisabledOverride(entry)) continue;
    items.push({
      name,
      config: entry,
      source: "config.project",
      disabledByTools: isMcpDisabledByTools(config, name) || undefined,
    });
  }

  return items;
}

export async function addMcp(
  workspaceRoot: string,
  name: string,
  config: Record<string, unknown>,
): Promise<{ action: "added" | "updated" }> {
  validateMcpName(name);
  validateMcpConfig(config);
  const { data } = await readJsoncFile(opencodeConfigPath(workspaceRoot), {} as Record<string, unknown>);
  const mcpMap = getMcpConfig(data);
  const existed = hasOwn(mcpMap, name);
  mcpMap[name] = config;
  await updateJsoncTopLevel(opencodeConfigPath(workspaceRoot), { mcp: mcpMap });
  return { action: existed ? "updated" : "added" };
}

export async function removeMcp(
  workspaceRoot: string,
  name: string,
  options: { dryRun?: boolean } = {},
): Promise<boolean> {
  validateMcpName(name);
  const { data } = await readJsoncFile(opencodeConfigPath(workspaceRoot), {} as Record<string, unknown>);
  const { data: globalConfig } = await readJsoncFile(globalOpenCodeConfigPath(), {} as Record<string, unknown>);
  const mcpMap = getMcpConfig(data);
  const globalMcpMap = getMcpConfig(globalConfig);
  const projectEntry = mcpMap[name];
  const globalEntry = globalMcpMap[name];

  if (isDisabledOverride(projectEntry) && isConfiguredMcp(globalEntry)) {
    throw new ApiError(
      409,
      "inherited_mcp_not_removable",
      "This MCP app is inherited from the global config. Resume it here or remove it from the global config.",
    );
  }
  if (!hasOwn(mcpMap, name)) {
    if (isConfiguredMcp(globalEntry)) {
      throw new ApiError(
        409,
        "inherited_mcp_not_removable",
        "This MCP app is inherited from the global config. Remove it from the global config.",
      );
    }
    return false;
  }
  if (!options.dryRun) {
    delete mcpMap[name];
    await updateJsoncTopLevel(opencodeConfigPath(workspaceRoot), { mcp: mcpMap });
  }
  return true;
}

// For configured workspace MCP entries, update only mcp.<name>.enabled so
// inline comments inside the entry survive (#1444). Inherited-global
// pause/resume still edits the workspace mcp map because it creates or removes
// a small workspace override.
export async function setMcpEnabled(
  workspaceRoot: string,
  name: string,
  enabled: boolean,
  options: { dryRun?: boolean } = {},
): Promise<{ changed: boolean; enabled: boolean }> {
  validateMcpName(name);

  const configPath = opencodeConfigPath(workspaceRoot);
  const { data } = await readJsoncFile(configPath, {} as Record<string, unknown>);
  const { data: globalConfig } = await readJsoncFile(globalOpenCodeConfigPath(), {} as Record<string, unknown>);
  const projectMcpMap = getMcpConfig(data);
  const globalMcpMap = getMcpConfig(globalConfig);
  const projectEntry = projectMcpMap[name];
  const globalEntry = globalMcpMap[name];

  if (isConfiguredMcp(projectEntry)) {
    if ((projectEntry.enabled !== false) === enabled) return { changed: false, enabled };
    if (!options.dryRun) {
      await updateJsoncPath(configPath, ["mcp", name, "enabled"], enabled);
    }
    return { changed: true, enabled };
  }

  if (isDisabledOverride(projectEntry)) {
    if (!enabled) return { changed: false, enabled };
    if (!isConfiguredMcp(globalEntry)) {
      throw new ApiError(404, "mcp_not_found", "MCP server not found");
    }
    if (globalEntry.enabled === false) {
      throw new ApiError(
        409,
        "global_mcp_disabled",
        "This MCP server is disabled in the global config. Add it to this workspace before enabling it here.",
      );
    }
    if (!options.dryRun) {
      delete projectMcpMap[name];
      await updateJsoncTopLevel(configPath, { mcp: projectMcpMap });
    }
    return { changed: true, enabled };
  }

  if (hasOwn(projectMcpMap, name)) {
    throw new ApiError(409, "invalid_mcp_config", "MCP config is not a configurable server");
  }

  if (isConfiguredMcp(globalEntry)) {
    if (enabled) {
      if (globalEntry.enabled === false) {
        throw new ApiError(
          409,
          "global_mcp_disabled",
          "This MCP server is disabled in the global config. Add it to this workspace before enabling it here.",
        );
      }
      return { changed: false, enabled };
    }
    if (globalEntry.enabled === false) {
      return { changed: false, enabled: false };
    }
    if (!options.dryRun) {
      projectMcpMap[name] = { enabled: false };
      await updateJsoncTopLevel(configPath, { mcp: projectMcpMap });
    }
    return { changed: true, enabled };
  }

  throw new ApiError(404, "mcp_not_found", "MCP server not found");
}
