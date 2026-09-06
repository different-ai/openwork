import { applyEdits, modify, parse, printParseErrorCode } from "jsonc-parser";
import type { McpServerConfig, McpServerEntry } from "./types";
import { readOpencodeConfig, writeOpencodeConfig } from "./lib/desktop";

type McpConfigValue = Record<string, unknown> | null | undefined;

type McpIdentity = {
  id?: string;
  serverName?: string;
  name: string;
};

export function normalizeMcpSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

export function canonicalMcpServerName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "mcp";
}

export function getMcpIdentityKey(entry: McpIdentity): string {
  return entry.id ?? entry.serverName ?? canonicalMcpServerName(entry.name);
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
  const configFile = await readOpencodeConfig("project", projectDir) as { path: string; exists: boolean; content: string | null };
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
  ) as { ok: boolean; stderr?: string; stdout?: string };
  if (!writeResult.ok) {
    throw new Error(writeResult.stderr || writeResult.stdout || "Failed to write opencode.json");
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((part): part is string => typeof part === "string") : [];
}

/**
 * Accept both command shapes users paste into opencode.json: OpenCode's
 * `command: ["python3", "server.py"]` and the Claude Desktop / Cursor style
 * `command: "python3", args: ["server.py"]`. Every reader downstream sees one
 * array, so a string command no longer blanks the Settings page.
 */
function normalizeMcpServerConfig(value: object): McpServerConfig | null {
  const config = value as McpServerConfig & { args?: unknown };
  if (config.type !== "remote" && config.type !== "local") return null;
  const rawCommand: unknown = config.command;
  if (typeof rawCommand !== "string") return config;
  const executable = rawCommand.trim();
  return { ...config, command: executable ? [executable, ...stringList(config.args)] : undefined };
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

      const config = normalizeMcpServerConfig(value);
      if (!config) return [];

      return [{ name, config, source: "config.project" as const }];
    });
  } catch {
    return [];
  }
}
