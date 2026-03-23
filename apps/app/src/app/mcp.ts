import { parse } from "jsonc-parser";
import type { McpServerConfig, McpServerEntry } from "./types";
import { readOpencodeConfig, writeOpencodeConfig } from "./lib/tauri";
import { CHROME_DEVTOOLS_MCP_COMMAND, CHROME_DEVTOOLS_MCP_ID } from "./constants";

type McpConfigValue = Record<string, unknown> | null | undefined;

export const CHROME_DEVTOOLS_AUTO_CONNECT_ARG = "--autoConnect";

type McpIdentity = {
  id?: string;
  name: string;
};

export function normalizeMcpSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

export function getMcpIdentityKey(entry: McpIdentity): string {
  return entry.id ?? normalizeMcpSlug(entry.name);
}

export function isChromeDevtoolsMcp(entry: McpIdentity | string | null | undefined): boolean {
  if (!entry) return false;
  const key = typeof entry === "string" ? entry : getMcpIdentityKey(entry);
  return key === CHROME_DEVTOOLS_MCP_ID || normalizeMcpSlug(typeof entry === "string" ? entry : entry.name) === "control-chrome";
}

export function usesChromeDevtoolsAutoConnect(command?: string[]): boolean {
  return Array.isArray(command) && command.includes(CHROME_DEVTOOLS_AUTO_CONNECT_ARG);
}

export function buildChromeDevtoolsCommand(command: string[] | undefined, useExistingProfile: boolean): string[] {
  const base = Array.isArray(command) && command.length
    ? command.filter((part) => part !== CHROME_DEVTOOLS_AUTO_CONNECT_ARG)
    : [...CHROME_DEVTOOLS_MCP_COMMAND];
  return useExistingProfile ? [...base, CHROME_DEVTOOLS_AUTO_CONNECT_ARG] : base;
}

export function validateMcpServerName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("server_name is required");
  }
  if (trimmed.startsWith("-")) {
    throw new Error("server_name must not start with '-'");
  }
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) {
    throw new Error("server_name must be alphanumeric with '-' or '_'");
  }
  return trimmed;
}

export async function removeMcpFromConfig(
  projectDir: string,
  name: string,
): Promise<void> {
  const configFile = await readOpencodeConfig("project", projectDir);
  let existingConfig: Record<string, unknown> = {};
  if (configFile.exists && configFile.content?.trim()) {
    try {
      existingConfig = parse(configFile.content) ?? {};
    } catch {
      existingConfig = {};
    }
  }

  const mcpSection = existingConfig["mcp"] as Record<string, unknown> | undefined;
  if (!mcpSection || !(name in mcpSection)) return;

  delete mcpSection[name];
  const writeResult = await writeOpencodeConfig(
    "project",
    projectDir,
    `${JSON.stringify(existingConfig, null, 2)}\n`,
  );
  if (!writeResult.ok) {
    throw new Error(writeResult.stderr || writeResult.stdout || "Failed to write opencode.json");
  }
}

export function parseMcpServersFromContent(content: string): McpServerEntry[] {
  if (!content.trim()) return [];

  try {
    const parsed = parse(content) as Record<string, unknown> | undefined;
    const mcp = parsed?.mcp as McpConfigValue;

    if (!mcp || typeof mcp !== "object") {
      return [];
    }

    return Object.entries(mcp).flatMap(([name, value]) => {
      if (!value || typeof value !== "object") {
        return [];
      }

      const config = value as McpServerConfig;
      if (config.type !== "remote" && config.type !== "local") {
        return [];
      }

      return [{ name, config }];
    });
  } catch {
    return [];
  }
}
