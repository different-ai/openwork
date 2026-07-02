/**
 * Portable export of installed skills and MCP servers.
 *
 * Skills live as plain files, but MCP servers can be OpenWork-managed
 * (stored in the runtime DB and injected into the engine via
 * OPENCODE_CONFIG), so the agent has no canonical way to read their
 * definitions back. This module exposes both in one portable shape so the
 * harness can package them into a marketplace plugin.
 *
 * Secret-bearing MCP values (headers, environment) are always redacted and
 * surfaced as `redactedKeys` so exports never leak credentials; consumers
 * should declare those keys as required inputs instead.
 */
import { readFile } from "node:fs/promises";
import type { McpItem, ServerConfig } from "./types.js";
import { listMcp } from "./mcp.js";
import { listSkills } from "./skills.js";

export type ExportedSkill = {
  kind: "skill";
  name: string;
  description: string;
  scope: "project" | "global";
  content: string;
};

export type ExportedMcp = {
  kind: "mcp";
  name: string;
  source: McpItem["source"];
  config: Record<string, unknown>;
  redactedKeys: string[];
};

export type ExtensionsExportResult = {
  components: Array<ExportedSkill | ExportedMcp>;
  missing: { skills: string[]; mcps: string[] };
};

const REDACTED_VALUE = "<redacted>";
const SECRET_RECORD_KEYS = ["headers", "environment", "env"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Redact all header/environment values from an MCP config. Values are
 * replaced (not removed) so consumers still see which keys a server needs.
 */
export function redactMcpConfig(config: Record<string, unknown>): {
  config: Record<string, unknown>;
  redactedKeys: string[];
} {
  const output: Record<string, unknown> = { ...config };
  const redactedKeys: string[] = [];
  for (const recordKey of SECRET_RECORD_KEYS) {
    const record = output[recordKey];
    if (!isRecord(record)) continue;
    const redacted: Record<string, unknown> = {};
    for (const key of Object.keys(record)) {
      redacted[key] = REDACTED_VALUE;
      redactedKeys.push(`${recordKey}.${key}`);
    }
    output[recordKey] = redacted;
  }
  return { config: output, redactedKeys };
}

export async function exportExtensions(input: {
  serverConfig: ServerConfig;
  workspaceId: string;
  workspaceRoot: string;
  skills: string[];
  mcps: string[];
}): Promise<ExtensionsExportResult> {
  const components: Array<ExportedSkill | ExportedMcp> = [];
  const missing: ExtensionsExportResult["missing"] = { skills: [], mcps: [] };

  if (input.skills.length > 0) {
    const installed = await listSkills(input.workspaceRoot, true);
    for (const name of input.skills) {
      const item = installed.find((skill) => skill.name === name);
      if (!item) {
        missing.skills.push(name);
        continue;
      }
      components.push({
        kind: "skill",
        name: item.name,
        description: item.description,
        scope: item.scope,
        content: await readFile(item.path, "utf8"),
      });
    }
  }

  if (input.mcps.length > 0) {
    const installed = await listMcp(input.serverConfig, input.workspaceId, input.workspaceRoot);
    for (const name of input.mcps) {
      const item = installed.find((mcp) => mcp.name === name);
      if (!item) {
        missing.mcps.push(name);
        continue;
      }
      const { config, redactedKeys } = redactMcpConfig(item.config);
      components.push({ kind: "mcp", name: item.name, source: item.source, config, redactedKeys });
    }
  }

  return { components, missing };
}
