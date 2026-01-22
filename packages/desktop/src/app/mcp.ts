import { parse } from "jsonc-parser";
import type { McpServerConfig, McpServerEntry } from "./types";

type McpConfigValue = Record<string, unknown> | null | undefined;

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
