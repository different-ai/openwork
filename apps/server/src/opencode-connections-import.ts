import { join } from "node:path";
import { globalOpencodeConfigDir } from "@openwork/paths";

import { ApiError } from "./errors.js";
import { readJsoncFile } from "./jsonc.js";
import { isOrganizationMcpName } from "./organization-mcp-names.js";
import { validateMcpConfig, validateMcpName } from "./validators.js";

export const OPENCODE_CONNECTIONS_IMPORT_LIMITS = {
  configBytes: 1024 * 1024,
  connections: 200,
} as const;

export type OpencodeConnectionKind = "local" | "remote";

export type OpencodeConnection = {
  name: string;
  kind: OpencodeConnectionKind;
  target: string;
  config: Record<string, unknown>;
};

export type OpencodeConnectionProblem = { name: string; reason: string };

export type OpencodeConfigStatus = "found" | "missing" | "invalid" | "unreadable";

export type OpencodeConnectionsSource = {
  status: OpencodeConfigStatus;
  connections: OpencodeConnection[];
  problems: OpencodeConnectionProblem[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function opencodeUserConfigPaths(configDir: string = globalOpencodeConfigDir()): string[] {
  return ["config.json", "opencode.json", "opencode.jsonc"].map((name) => join(configDir, name));
}

function connectionEntries(mcp: unknown): Array<[string, unknown]> {
  if (!isRecord(mcp)) return [];
  const nested = mcp.servers;
  const nestedIsMap = isRecord(nested)
    && typeof nested.type !== "string" && nested.command === undefined && nested.url === undefined;
  return [
    ...Object.entries(mcp).filter(([name]) => !(nestedIsMap && name === "servers")),
    ...(nestedIsMap ? Object.entries(nested) : []),
  ];
}

export function normalizeOpencodeConnection(name: string, value: unknown): OpencodeConnection | OpencodeConnectionProblem {
  try {
    validateMcpName(name);
  } catch {
    return { name, reason: "Its name can only use letters, numbers, - and _." };
  }
  if (!isRecord(value)) return { name, reason: "It is not a connection." };
  const shared = {
    ...(typeof value.enabled === "boolean" ? { enabled: value.enabled } : {}),
    ...(typeof value.timeout === "number" && value.timeout > 0 ? { timeout: value.timeout } : {}),
  };
  const hasUrl = typeof value.url === "string";
  const type = value.type === "local" || value.type === "remote" ? value.type : hasUrl ? "remote" : "local";
  let config: Record<string, unknown>;
  if (type === "remote") {
    const headers = stringRecord(value.headers);
    config = {
      type: "remote",
      url: hasUrl ? String(value.url).trim() : "",
      ...(headers ? { headers } : {}),
      ...(value.oauth === false || isRecord(value.oauth) ? { oauth: value.oauth } : {}),
      ...shared,
    };
  } else {
    const args = Array.isArray(value.args) ? value.args : [];
    const command = typeof value.command === "string" ? [value.command, ...args] : value.command;
    const environment = stringRecord(value.environment) ?? stringRecord(value.env);
    config = {
      type: "local",
      command,
      ...(environment ? { environment } : {}),
      ...(typeof value.cwd === "string" && value.cwd.trim() ? { cwd: value.cwd } : {}),
      ...shared,
    };
  }
  try {
    validateMcpConfig(config);
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return {
      name,
      reason: type === "remote" ? "It needs a web address that starts with http:// or https://." : "It needs a command to run.",
    };
  }
  return { name, kind: type, target: connectionTarget(config), config };
}

function connectionTarget(config: Record<string, unknown>): string {
  if (config.type === "remote") {
    try { return new URL(String(config.url)).host; } catch { return ""; }
  }
  const first = Array.isArray(config.command) && typeof config.command[0] === "string" ? config.command[0] : "";
  return first.split(/[\\/]/).pop() ?? first;
}

export async function readOpencodeConnections(paths: string[] = opencodeUserConfigPaths()): Promise<OpencodeConnectionsSource> {
  const merged = new Map<string, unknown>();
  let found = false;
  let failure: "invalid" | "unreadable" | undefined;
  for (const path of paths) {
    try {
      const file = await readJsoncFile<unknown>(path, {}, {
        allowInvalid: true,
        maxBytes: OPENCODE_CONNECTIONS_IMPORT_LIMITS.configBytes,
        regularFileOnly: true,
      });
      if (file.missing) continue;
      if (file.invalid || !isRecord(file.data)) { failure ??= "invalid"; continue; }
      found = true;
      for (const [name, value] of connectionEntries(file.data.mcp)) merged.set(name, value);
    } catch {
      failure ??= "unreadable";
    }
  }
  const connections: OpencodeConnection[] = [];
  const problems: OpencodeConnectionProblem[] = [];
  for (const [name, value] of [...merged].slice(0, OPENCODE_CONNECTIONS_IMPORT_LIMITS.connections)) {
    if (isOrganizationMcpName(name)) continue;
    const entry = normalizeOpencodeConnection(name, value);
    if ("config" in entry) connections.push(entry);
    else problems.push(entry);
  }
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  return {
    status: merged.size > 0 || (found && !failure) ? "found" : failure ?? "missing",
    connections: connections.sort(byName),
    problems: problems.sort(byName),
  };
}
