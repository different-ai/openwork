import { minimatch } from "minimatch";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { McpItem, ServerConfig } from "./types.js";
import { readJsoncFile } from "./jsonc.js";
import { opencodeConfigPath } from "./workspace-files.js";
import { validateMcpConfig, validateMcpName } from "./validators.js";
import { readRuntimeOpencodeConfig, runtimeMcpMap, writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";

function globalOpenCodeConfigPath(): string {
  const base = join(homedir(), ".config", "opencode");
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

export async function listMcp(serverConfig: ServerConfig, workspaceId: string, workspaceRoot: string): Promise<McpItem[]> {
  const { data: config } = await readJsoncFile(opencodeConfigPath(workspaceRoot), {} as Record<string, unknown>, { allowInvalid: true });
  const { data: globalConfig } = await readJsoncFile(globalOpenCodeConfigPath(), {} as Record<string, unknown>, { allowInvalid: true });

  const projectMcpMap = getMcpConfig(config);
  const globalMcpMap = getMcpConfig(globalConfig);
  const runtimeConfig = await readRuntimeOpencodeConfig(serverConfig, workspaceId);
  const runtimeMap = runtimeMcpMap(runtimeConfig);

  const items: McpItem[] = [];

  // Global MCPs first; project-level entries override global ones with the same name.
  for (const [name, entry] of Object.entries(globalMcpMap)) {
    if (Object.prototype.hasOwnProperty.call(projectMcpMap, name)) continue;
    items.push({
      name,
      config: entry,
      source: "config.global",
      disabledByTools:
        (isMcpDisabledByTools(globalConfig, name) || isMcpDisabledByTools(config, name)) || undefined,
    });
  }

  // Project MCPs (highest priority).
  for (const [name, entry] of Object.entries(projectMcpMap)) {
    if (Object.prototype.hasOwnProperty.call(runtimeMap, name)) continue;
    items.push({
      name,
      config: entry,
      source: "config.project",
      disabledByTools: isMcpDisabledByTools(config, name) || undefined,
    });
  }

  // OpenWork-owned MCPs are stored by the server and injected at runtime.
  for (const [name, entry] of Object.entries(runtimeMap)) {
    items.push({
      name,
      config: entry,
      source: "config.remote",
      disabledByTools: isMcpDisabledByTools(config, name) || undefined,
    });
  }

  return items;
}

export async function addMcp(
  serverConfig: ServerConfig,
  workspaceId: string,
  name: string,
  config: Record<string, unknown>,
): Promise<{ action: "added" | "updated" }> {
  validateMcpName(name);
  validateMcpConfig(config);
  const runtimeConfig = await readRuntimeOpencodeConfig(serverConfig, workspaceId);
  const mcpMap = { ...runtimeMcpMap(runtimeConfig) };
  const existed = Object.prototype.hasOwnProperty.call(mcpMap, name);
  mcpMap[name] = config;
  await writeRuntimeOpencodeConfig(serverConfig, workspaceId, (current) => ({ ...current, mcp: mcpMap }));
  return { action: existed ? "updated" : "added" };
}

export async function removeMcp(serverConfig: ServerConfig, workspaceId: string, name: string): Promise<boolean> {
  const runtimeConfig = await readRuntimeOpencodeConfig(serverConfig, workspaceId);
  const mcpMap = { ...runtimeMcpMap(runtimeConfig) };
  if (!Object.prototype.hasOwnProperty.call(mcpMap, name)) return false;
  delete mcpMap[name];
  await writeRuntimeOpencodeConfig(serverConfig, workspaceId, (current) => ({ ...current, mcp: mcpMap }));
  return true;
}

// Flips `enabled` on a workspace MCP entry. Returns false for "toggle does
// not apply": missing, non-object, or malformed enough that OpenCode would
// fail to load it. The HTTP layer maps false to 404. Globals are out of
// scope by design — only workspace-level entries.
//
// `updateJsoncPath` (vs `updateJsoncTopLevel`) preserves inline comments
// inside the MCP entry — see the regression that motivated #1444.
export async function setMcpEnabled(
  serverConfig: ServerConfig,
  workspaceId: string,
  name: string,
  enabled: boolean,
): Promise<boolean> {
  validateMcpName(name);
  const runtimeConfig = await readRuntimeOpencodeConfig(serverConfig, workspaceId);
  const mcpMap = { ...runtimeMcpMap(runtimeConfig) };
  if (!Object.prototype.hasOwnProperty.call(mcpMap, name)) return false;
  const current = mcpMap[name];
  if (!current || typeof current !== "object" || Array.isArray(current)) return false;
  try {
    validateMcpConfig({ ...(current as Record<string, unknown>), enabled });
  } catch {
    return false;
  }
  mcpMap[name] = { ...(current as Record<string, unknown>), enabled };
  await writeRuntimeOpencodeConfig(serverConfig, workspaceId, (currentConfig) => ({ ...currentConfig, mcp: mcpMap }));
  return true;
}
