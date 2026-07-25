import type { ServerConfig } from "./types.js";
import { createWorkspaceKvStore, isRecord } from "./workspace-kv-store.js";

function normalizeOpenworkWorkspaceConfig(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function parseOpenworkWorkspaceConfig(configJson: string): Record<string, unknown> {
  try {
    return normalizeOpenworkWorkspaceConfig(JSON.parse(configJson));
  } catch {
    return {};
  }
}

const openworkWorkspaceConfigStore = createWorkspaceKvStore<Record<string, unknown>>({
  tableName: "openwork_workspace_configs",
  valueColumn: "config_json",
  parse: parseOpenworkWorkspaceConfig,
  serialize: (value) => JSON.stringify(value),
});

export async function readOpenworkWorkspaceConfig(config: ServerConfig, workspaceId: string): Promise<Record<string, unknown>> {
  return await openworkWorkspaceConfigStore.get(config, workspaceId) ?? {};
}

export async function writeOpenworkWorkspaceConfig(
  config: ServerConfig,
  workspaceId: string,
  updater: (current: Record<string, unknown>) => Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const next = normalizeOpenworkWorkspaceConfig(updater(await readOpenworkWorkspaceConfig(config, workspaceId)));
  await openworkWorkspaceConfigStore.set(config, workspaceId, next);
  return next;
}

export async function hasOpenworkWorkspaceConfig(
  config: ServerConfig,
  workspaceId: string,
): Promise<boolean> {
  return openworkWorkspaceConfigStore.has(config, workspaceId);
}

/**
 * Seed the DB-backed openwork config for a workspace if no row exists yet.
 * Used at workspace creation and as the migrate-on-read landing spot for
 * legacy `.opencode/openwork.json` files. No-op when a row is already present,
 * so it never clobbers live provisioning state.
 */
export async function seedOpenworkWorkspaceConfigIfEmpty(
  config: ServerConfig,
  workspaceId: string,
  seed: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (await hasOpenworkWorkspaceConfig(config, workspaceId)) {
    return readOpenworkWorkspaceConfig(config, workspaceId);
  }
  return writeOpenworkWorkspaceConfig(config, workspaceId, () => seed);
}

export function mergeOpenworkWorkspaceConfigs(
  legacy: Record<string, unknown>,
  stored: Record<string, unknown>,
): Record<string, unknown> {
  return { ...legacy, ...stored };
}
