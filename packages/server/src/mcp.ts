import { homedir } from "node:os";
import { join } from "node:path";
import { minimatch } from "minimatch";
import type { McpItem } from "./types.js";
import { readJsoncFile, updateJsoncTopLevel } from "./jsonc.js";
import { opencodeConfigPath } from "./workspace-files.js";
import { validateMcpConfig, validateMcpName } from "./validators.js";

function getGlobalOpencodeConfigPath(): string {
  return join(homedir(), ".config", "opencode", "opencode.json");
}

function getMcpConfig(config: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const mcp = config.mcp;
  if (!mcp || typeof mcp !== "object") return {};
  return mcp as Record<string, Record<string, unknown>>;
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

// Generate a unique identifier for MCP config (for deduplication)
function getMcpConfigId(config: Record<string, unknown>): string | null {
  const type = config.type;

  if (type === "remote") {
    // Remote MCP: use URL as identifier
    const url = config.url;
    if (typeof url === "string") return `remote:${url}`;
  } else if (type === "local") {
    // Local MCP: use full command array as identifier
    // Keep all arguments including --flags for security-sensitive deduplication
    const command = config.command;
    if (Array.isArray(command)) {
      const cmdStr = command.filter((c) => typeof c === "string").join(" ");
      if (cmdStr.length > 0) return `local:${cmdStr}`;
    }
  }

  return null;
}

// Check if two MCP configs are the same (for deduplication)
function isSameMcpConfig(config1: Record<string, unknown>, config2: Record<string, unknown>): boolean {
  const id1 = getMcpConfigId(config1);
  const id2 = getMcpConfigId(config2);

  // If both can generate IDs, compare IDs
  if (id1 && id2) return id1 === id2;

  // If unable to generate ID, compare the entire config object (excluding runtime fields like enabled)
  // Note: environment is now included in comparison to avoid merging configs with different credentials
  const keys1 = Object.keys(config1).filter((k) => k !== "enabled").sort();
  const keys2 = Object.keys(config2).filter((k) => k !== "enabled").sort();

  if (keys1.length !== keys2.length) return false;

  return keys1.every((key) => JSON.stringify(config1[key]) === JSON.stringify(config2[key]));
}

export async function listMcp(workspaceRoot: string): Promise<McpItem[]> {
  // Read global config
  const globalPath = getGlobalOpencodeConfigPath();
  const { data: globalConfig } = await readJsoncFile(globalPath, {} as Record<string, unknown>);
  const globalMcpMap = getMcpConfig(globalConfig);

  // Read workspace config
  const { data: projectConfig } = await readJsoncFile(opencodeConfigPath(workspaceRoot), {} as Record<string, unknown>);
  const projectMcpMap = getMcpConfig(projectConfig);

  // Collect all existing config IDs (for deduplication)
  const existingConfigIds = new Set<string>();
  const existingConfigs: Array<{ name: string; config: Record<string, unknown> }> = [];

  // Process workspace config first (higher priority)
  for (const [name, entry] of Object.entries(projectMcpMap)) {
    const configId = getMcpConfigId(entry);
    if (configId) existingConfigIds.add(configId);
    existingConfigs.push({ name, config: entry });
  }

  // Then process global config, filtering out duplicates from workspace
  for (const [name, entry] of Object.entries(globalMcpMap)) {
    // Check for same name (case 1: already handled, workspace takes priority)
    if (Object.prototype.hasOwnProperty.call(projectMcpMap, name)) continue;

    // Check for duplicate content (case 2: different name but same config)
    const configId = getMcpConfigId(entry);
    if (configId && existingConfigIds.has(configId)) continue;

    // Check if content matches any existing config (fallback)
    const isDuplicate = existingConfigs.some(({ config }) => isSameMcpConfig(entry, config));
    if (isDuplicate) continue;

    // Add to results
    if (configId) existingConfigIds.add(configId);
    existingConfigs.push({ name, config: entry });
  }

  return existingConfigs.map(({ name, config }) => {
    const source = Object.prototype.hasOwnProperty.call(projectMcpMap, name)
      ? "config.project"
      : "config.global";

    // Check if disabled by workspace config
    let disabledByTools = isMcpDisabledByTools(projectConfig, name) || undefined;

    // If not disabled by workspace, check global config (only for global-sourced MCPs)
    if (!disabledByTools && source === "config.global") {
      disabledByTools = isMcpDisabledByTools(globalConfig, name) || undefined;
    }

    return {
      name,
      config,
      source,
      disabledByTools,
    };
  });
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
  const existed = Object.prototype.hasOwnProperty.call(mcpMap, name);
  mcpMap[name] = config;
  await updateJsoncTopLevel(opencodeConfigPath(workspaceRoot), { mcp: mcpMap });
  return { action: existed ? "updated" : "added" };
}

export async function removeMcp(workspaceRoot: string, name: string): Promise<boolean> {
  const { data } = await readJsoncFile(opencodeConfigPath(workspaceRoot), {} as Record<string, unknown>);
  const mcpMap = getMcpConfig(data);
  if (!Object.prototype.hasOwnProperty.call(mcpMap, name)) return false;
  delete mcpMap[name];
  await updateJsoncTopLevel(opencodeConfigPath(workspaceRoot), { mcp: mcpMap });
  return true;
}
