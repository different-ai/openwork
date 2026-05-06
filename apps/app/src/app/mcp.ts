import { applyEdits, modify, parse, printParseErrorCode } from "jsonc-parser";
import type { McpServerConfig, McpServerEntry } from "./types";
import { readOpencodeConfig, writeOpencodeConfig } from "./lib/desktop";
import { CHROME_DEVTOOLS_MCP_COMMAND, CHROME_DEVTOOLS_MCP_ID } from "./constants";
import { isElectronRuntime } from "./utils";

type McpConfigValue = Record<string, unknown> | null | undefined;

export const CHROME_DEVTOOLS_AUTO_CONNECT_ARG = "--autoConnect";

/**
 * Cached result of resolving the bundled chrome-devtools-mcp binary path
 * from the Electron main process. `undefined` = not yet resolved.
 */
let _resolvedBundledCommand: string[] | null | undefined;

/**
 * Resolve the chrome-devtools-mcp command for the current runtime.
 *
 * In Electron, the package is bundled as a dependency of `@openwork/desktop`,
 * so we ask the main process for the absolute path to the bin and use
 * `["node", "<path>"]` — no npm/npx required.
 *
 * Falls back to the npx-based command for web/remote contexts.
 */
export async function resolveChromeDevtoolsMcpCommand(): Promise<string[]> {
  if (isElectronRuntime() && _resolvedBundledCommand === undefined) {
    try {
      const resolved = await (window as Window).__OPENWORK_ELECTRON__!.invokeDesktop(
        "resolveChromeDevtoolsMcpBin",
      );
      _resolvedBundledCommand = Array.isArray(resolved) && resolved.length > 0
        ? (resolved as string[])
        : null;
    } catch {
      _resolvedBundledCommand = null;
    }
  }
  return _resolvedBundledCommand ?? [...CHROME_DEVTOOLS_MCP_COMMAND];
}

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

export function buildChromeDevtoolsCommand(
  command: string[] | undefined,
  useExistingProfile: boolean,
  resolvedBase?: string[],
): string[] {
  const base = Array.isArray(command) && command.length
    ? command.filter((part) => part !== CHROME_DEVTOOLS_AUTO_CONNECT_ARG)
    : resolvedBase ?? [...CHROME_DEVTOOLS_MCP_COMMAND];
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
  const raw = configFile.exists && configFile.content?.trim()
    ? configFile.content
    : "{}\n";

  const parseErrors: Array<{ error: number; offset: number; length: number }> = [];
  const existingConfig = parse(raw, parseErrors, { allowTrailingComma: true }) as Record<string, unknown> | undefined;
  if (parseErrors.length > 0) {
    const details = parseErrors
      .map((entry) => printParseErrorCode(entry.error))
      .join(", ");
    throw new Error(`Failed to parse opencode config: ${details}`);
  }

  const mcpSection = existingConfig?.["mcp"] as Record<string, unknown> | undefined;
  if (!mcpSection || !(name in mcpSection)) return;

  const formattingOptions = { insertSpaces: true, tabSize: 2, eol: "\n" };
  const updated = applyEdits(raw, modify(raw, ["mcp", name], undefined, { formattingOptions }));
  const writeResult = await writeOpencodeConfig(
    "project",
    projectDir,
    updated.endsWith("\n") ? updated : `${updated}\n`,
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

      return [{ name, config, source: "config.project" as const }];
    });
  } catch {
    return [];
  }
}
