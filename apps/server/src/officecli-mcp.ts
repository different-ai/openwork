import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  readOpenworkWorkspaceConfig,
  writeOpenworkWorkspaceConfig,
} from "./openwork-workspace-config-store.js";
import {
  readRuntimeOpencodeConfig,
  runtimeMcpMap,
  writeRuntimeOpencodeConfig,
} from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";

export const OFFICECLI_MCP_NAME = "officecli" as const;

export type OfficeCliProvisionState = "managed" | "removed";

const OFFICECLI_EXE = "officecli.exe";
const PROVISION_KEY = "officecliProvision";

function normalizedOverride(env: NodeJS.ProcessEnv): string | null {
  const raw = env.OPENWORK_OFFICECLI_PATH?.trim();
  if (!raw) return null;
  return existsSync(raw) ? raw : null;
}

function defaultWindowsInstallPath(env: NodeJS.ProcessEnv): string | null {
  const localAppData = env.LOCALAPPDATA?.trim();
  if (!localAppData) return null;
  const candidate = join(localAppData, "OfficeCLI", OFFICECLI_EXE);
  return existsSync(candidate) ? candidate : null;
}

function pathScan(env: NodeJS.ProcessEnv): string | null {
  const delimiter = process.platform === "win32" ? ";" : ":";
  for (const entry of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(entry, OFFICECLI_EXE);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function resolveOfficeCliBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = normalizedOverride(env);
  if (override) return override;
  if (process.platform !== "win32") return null;
  return defaultWindowsInstallPath(env) ?? pathScan(env);
}

function parseProvisionState(value: unknown): OfficeCliProvisionState | null {
  return value === "managed" || value === "removed" ? value : null;
}

export async function readOfficeCliProvisionState(
  config: ServerConfig,
  workspaceId: string,
): Promise<OfficeCliProvisionState | null> {
  const workspaceConfig = await readOpenworkWorkspaceConfig(config, workspaceId);
  return parseProvisionState(workspaceConfig[PROVISION_KEY]);
}

export async function writeOfficeCliProvisionState(
  config: ServerConfig,
  workspaceId: string,
  state: OfficeCliProvisionState,
): Promise<void> {
  await writeOpenworkWorkspaceConfig(config, workspaceId, (current) => ({
    ...current,
    [PROVISION_KEY]: state,
  }));
}

function managedOfficeCliEntry(binaryPath: string, enabled: boolean): Record<string, unknown> {
  return {
    type: "local",
    enabled,
    command: [binaryPath, "mcp"],
    openworkManaged: true,
  };
}

export async function reconcileOfficeCliMcp(
  config: ServerConfig,
  workspaceId: string,
  binaryPath: string,
): Promise<"added" | "updated" | "skipped"> {
  if (await readOfficeCliProvisionState(config, workspaceId) === "removed") {
    return "skipped";
  }

  const runtimeConfig = await readRuntimeOpencodeConfig(config, workspaceId);
  const mcpMap = runtimeMcpMap(runtimeConfig);
  const current = mcpMap[OFFICECLI_MCP_NAME];

  if (current && current.openworkManaged !== true) {
    return "skipped";
  }

  const enabled = current?.enabled !== false;
  const nextEntry = managedOfficeCliEntry(binaryPath, enabled);
  const currentCommand = Array.isArray(current?.command) ? current.command : [];
  const action = current ? "updated" : "added";

  if (
    current
    && currentCommand[0] === binaryPath
    && current.enabled === enabled
    && current.openworkManaged === true
  ) {
    return "skipped";
  }

  await writeRuntimeOpencodeConfig(config, workspaceId, (value) => ({
    ...value,
    mcp: { ...runtimeMcpMap(value), [OFFICECLI_MCP_NAME]: nextEntry },
  }));
  await writeOfficeCliProvisionState(config, workspaceId, "managed");
  return action;
}

export async function reconcileOfficeCliMcpForAllWorkspaces(config: ServerConfig): Promise<void> {
  const binaryPath = resolveOfficeCliBinary();
  if (!binaryPath) return;
  for (const workspace of config.workspaces) {
    await reconcileOfficeCliMcp(config, workspace.id, binaryPath);
  }
}

export async function markOfficeCliManagedMcpRemoved(
  config: ServerConfig,
  workspaceId: string,
): Promise<void> {
  const runtimeConfig = await readRuntimeOpencodeConfig(config, workspaceId);
  const current = runtimeMcpMap(runtimeConfig)[OFFICECLI_MCP_NAME];
  if (current?.openworkManaged === true) {
    await writeOfficeCliProvisionState(config, workspaceId, "removed");
  }
}
