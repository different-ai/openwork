import { minimatch } from "minimatch";
import type { McpItem } from "./types.js";
import { readJsoncFile, updateJsoncTopLevel } from "./jsonc.js";
import { opencodeConfigPath } from "./workspace-files.js";
import { validateMcpConfig, validateMcpName } from "./validators.js";

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

export async function listMcp(workspaceRoot: string): Promise<McpItem[]> {
  const { data: config } = await readJsoncFile(opencodeConfigPath(workspaceRoot), {} as Record<string, unknown>);
  const mcpMap = getMcpConfig(config);
  return Object.entries(mcpMap).map(([name, entry]) => ({
    name,
    config: entry,
    source: "config.project",
    disabledByTools: isMcpDisabledByTools(config, name) || undefined,
  }));
}

export async function addMcp(workspaceRoot: string, name: string, config: Record<string, unknown>): Promise<void> {
  validateMcpName(name);
  validateMcpConfig(config);
  const { data } = await readJsoncFile(opencodeConfigPath(workspaceRoot), {} as Record<string, unknown>);
  const mcpMap = getMcpConfig(data);
  mcpMap[name] = config;
  await updateJsoncTopLevel(opencodeConfigPath(workspaceRoot), { mcp: mcpMap });
}

export async function removeMcp(workspaceRoot: string, name: string): Promise<void> {
  const { data } = await readJsoncFile(opencodeConfigPath(workspaceRoot), {} as Record<string, unknown>);
  const mcpMap = getMcpConfig(data);
  delete mcpMap[name];
  await updateJsoncTopLevel(opencodeConfigPath(workspaceRoot), { mcp: mcpMap });
}
