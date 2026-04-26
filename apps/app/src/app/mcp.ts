import { applyEdits, modify, parse, printParseErrorCode } from "jsonc-parser";
import type { McpServerConfig, McpServerEntry } from "./types";
import { readOpencodeConfig, writeOpencodeConfig } from "./lib/desktop";
import { CHROME_DEVTOOLS_MCP_COMMAND, CHROME_DEVTOOLS_MCP_ID } from "./constants";

type McpConfigValue = Record<string, unknown> | null | undefined;
const jsoncFormattingOptions = { insertSpaces: true, tabSize: 2, eol: "\n" };

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

function isConfiguredMcpEntry(entry: unknown): entry is Record<string, unknown> {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const type = (entry as Record<string, unknown>).type;
  return type === "local" || type === "remote";
}

function isDisabledMcpOverride(entry: unknown): boolean {
  return (
    Boolean(entry) &&
    typeof entry === "object" &&
    !Array.isArray(entry) &&
    (entry as Record<string, unknown>).enabled === false &&
    !isConfiguredMcpEntry(entry)
  );
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

export function updateMcpEnabledInConfigContent(
  content: string,
  name: string,
  enabled: boolean,
  options: { inheritedMcpServers?: readonly McpServerEntry[] } = {},
): string {
  const source = content.trim() ? content : "{}\n";
  const errors: { error: number; offset: number; length: number }[] = [];
  const parsed = parse(source, errors, { allowTrailingComma: true }) as Record<string, unknown> | undefined;
  if (errors.length > 0) {
    const detail = errors.map((error) => printParseErrorCode(error.error)).join(", ");
    throw new Error(`Failed to parse opencode config${detail ? `: ${detail}` : ""}`);
  }

  const mcpSection = parsed?.mcp as Record<string, unknown> | undefined;
  const entry = mcpSection?.[name];
  const inheritedEntry = options.inheritedMcpServers?.find((item) => item.name === name);
  const inheritedEnabled = inheritedEntry ? inheritedEntry.config.enabled !== false : false;

  if (isConfiguredMcpEntry(entry)) {
    const updated = applyEdits(
      source,
      modify(source, ["mcp", name, "enabled"], enabled, {
        formattingOptions: jsoncFormattingOptions,
      }),
    );
    return updated.endsWith("\n") ? updated : `${updated}\n`;
  }

  if (isDisabledMcpOverride(entry)) {
    if (!inheritedEntry) {
      throw new Error("MCP server not found");
    }
    if (!enabled) return source.endsWith("\n") ? source : `${source}\n`;
    if (!inheritedEnabled) {
      throw new Error("This MCP server is disabled in the global config.");
    }
    const updated = applyEdits(
      source,
      modify(source, ["mcp", name], undefined, {
        formattingOptions: jsoncFormattingOptions,
      }),
    );
    return updated.endsWith("\n") ? updated : `${updated}\n`;
  }

  if (entry != null) {
    throw new Error("MCP config is not a configurable server");
  }

  if (inheritedEntry) {
    if (enabled) {
      if (!inheritedEnabled) {
        throw new Error("This MCP server is disabled in the global config.");
      }
      return source.endsWith("\n") ? source : `${source}\n`;
    }
    if (!inheritedEnabled) return source.endsWith("\n") ? source : `${source}\n`;
    const updated = applyEdits(
      source,
      modify(source, ["mcp", name], { enabled: false }, {
        formattingOptions: jsoncFormattingOptions,
      }),
    );
    return updated.endsWith("\n") ? updated : `${updated}\n`;
  }

  throw new Error(mcpSection ? "MCP server not found" : "Workspace config has no MCP section yet");
}

export async function setMcpEnabledInConfig(
  projectDir: string,
  name: string,
  enabled: boolean,
): Promise<{ changed: boolean }> {
  const safeName = validateMcpServerName(name);
  const configFile = await readOpencodeConfig("project", projectDir);
  const projectContent = configFile.exists && configFile.content ? configFile.content : "{}\n";
  const globalConfigFile = await readOpencodeConfig("global", projectDir);
  const inheritedMcpServers = parseMcpServersFromContent(globalConfigFile.content ?? "");

  const nextContent = updateMcpEnabledInConfigContent(projectContent, safeName, enabled, {
    inheritedMcpServers,
  });
  if (nextContent === projectContent) return { changed: false };
  const writeResult = await writeOpencodeConfig("project", projectDir, nextContent);
  if (!writeResult.ok) {
    throw new Error(writeResult.stderr || writeResult.stdout || "Failed to write opencode.json");
  }
  return { changed: true };
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

      return [{ name, config, source: "config.project" as const }];
    });
  } catch {
    return [];
  }
}
