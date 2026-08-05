import type { ServerConfig } from "./types.js";
import { createWorkspaceKvStore, isRecord } from "./workspace-kv-store.js";

function normalizeMicxWorkspaceConfig(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function parseMicxWorkspaceConfig(configJson: string): Record<string, unknown> {
  try {
    return normalizeMicxWorkspaceConfig(JSON.parse(configJson));
  } catch {
    return {};
  }
}

const micxWorkspaceConfigStore = createWorkspaceKvStore<Record<string, unknown>>({
  tableName: "micx_workspace_configs",
  valueColumn: "config_json",
  parse: parseMicxWorkspaceConfig,
  serialize: (value) => JSON.stringify(value),
});

export async function readMicxWorkspaceConfig(config: ServerConfig, workspaceId: string): Promise<Record<string, unknown>> {
  return await micxWorkspaceConfigStore.get(config, workspaceId) ?? {};
}

export async function writeMicxWorkspaceConfig(
  config: ServerConfig,
  workspaceId: string,
  updater: (current: Record<string, unknown>) => Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const next = normalizeMicxWorkspaceConfig(updater(await readMicxWorkspaceConfig(config, workspaceId)));
  await micxWorkspaceConfigStore.set(config, workspaceId, next);
  return next;
}

export async function hasMicxWorkspaceConfig(
  config: ServerConfig,
  workspaceId: string,
): Promise<boolean> {
  return micxWorkspaceConfigStore.has(config, workspaceId);
}

/**
 * Seed the DB-backed micx config for a workspace if no row exists yet.
 * Used at workspace creation and as the migrate-on-read landing spot for
 * legacy `.opencode/micx.json` files. No-op when a row is already present,
 * so it never clobbers live provisioning state.
 */
export async function seedMicxWorkspaceConfigIfEmpty(
  config: ServerConfig,
  workspaceId: string,
  seed: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (await hasMicxWorkspaceConfig(config, workspaceId)) {
    return readMicxWorkspaceConfig(config, workspaceId);
  }
  return writeMicxWorkspaceConfig(config, workspaceId, () => seed);
}

export function mergeMicxWorkspaceConfigs(
  legacy: Record<string, unknown>,
  stored: Record<string, unknown>,
): Record<string, unknown> {
  return { ...legacy, ...stored };
}
