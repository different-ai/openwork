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

// 生成 MCP 配置的唯一标识（用于去重）
function getMcpConfigId(config: Record<string, unknown>): string | null {
  const type = config.type;
  
  if (type === "remote") {
    // 远程 MCP：使用 URL 作为标识
    const url = config.url;
    if (typeof url === "string") return `remote:${url}`;
  } else if (type === "local") {
    // 本地 MCP：使用 command 数组作为标识
    const command = config.command;
    if (Array.isArray(command)) {
      // 过滤掉 -y 等选项，只保留核心命令
      const coreCmd = command.filter((c) => typeof c === "string" && c !== "-y" && !c.startsWith("--"));
      if (coreCmd.length > 0) return `local:${coreCmd.join(" ")}`;
    }
  }
  
  return null;
}

// 检查两个 MCP 配置是否是同一个（基于内容去重）
function isSameMcpConfig(config1: Record<string, unknown>, config2: Record<string, unknown>): boolean {
  const id1 = getMcpConfigId(config1);
  const id2 = getMcpConfigId(config2);
  
  // 如果都能生成 ID，比较 ID
  if (id1 && id2) return id1 === id2;
  
  // 如果无法生成 ID，比较整个配置对象（排除 enabled 等运行时字段）
  const keys1 = Object.keys(config1).filter((k) => !["enabled", "environment"].includes(k)).sort();
  const keys2 = Object.keys(config2).filter((k) => !["enabled", "environment"].includes(k)).sort();
  
  if (keys1.length !== keys2.length) return false;
  
  return keys1.every((key) => JSON.stringify(config1[key]) === JSON.stringify(config2[key]));
}

export async function listMcp(workspaceRoot: string): Promise<McpItem[]> {
  // 读取全局配置
  const globalPath = getGlobalOpencodeConfigPath();
  const { data: globalConfig } = await readJsoncFile(globalPath, {} as Record<string, unknown>);
  const globalMcpMap = getMcpConfig(globalConfig);

  // 读取工作区配置
  const { data: projectConfig } = await readJsoncFile(opencodeConfigPath(workspaceRoot), {} as Record<string, unknown>);
  const projectMcpMap = getMcpConfig(projectConfig);

  // 收集所有已存在的配置 ID（用于去重）
  const existingConfigIds = new Set<string>();
  const existingConfigs: Array<{ name: string; config: Record<string, unknown> }> = [];

  // 先处理工作区配置（优先级高）
  for (const [name, entry] of Object.entries(projectMcpMap)) {
    const configId = getMcpConfigId(entry);
    if (configId) existingConfigIds.add(configId);
    existingConfigs.push({ name, config: entry });
  }

  // 再处理全局配置，过滤掉与工作区重复的内容
  for (const [name, entry] of Object.entries(globalMcpMap)) {
    // 检查是否同名（情况 1：已处理，工作区优先）
    if (Object.prototype.hasOwnProperty.call(projectMcpMap, name)) continue;

    // 检查是否内容重复（情况 2：不同名但相同配置）
    const configId = getMcpConfigId(entry);
    if (configId && existingConfigIds.has(configId)) continue;

    // 检查是否与任何已存在的配置内容相同（回退方案）
    const isDuplicate = existingConfigs.some(({ config }) => isSameMcpConfig(entry, config));
    if (isDuplicate) continue;

    // 添加到结果
    if (configId) existingConfigIds.add(configId);
    existingConfigs.push({ name, config: entry });
  }

  return existingConfigs.map(({ name, config }) => {
    const source = Object.prototype.hasOwnProperty.call(projectMcpMap, name)
      ? "config.project"
      : "config.global";

    // 检查是否被工作区配置禁用
    let disabledByTools = isMcpDisabledByTools(projectConfig, name) || undefined;

    // 如果工作区没禁用，检查全局配置是否禁用（仅对全局来源的 MCP）
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
