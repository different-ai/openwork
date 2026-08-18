import type { ServerConfig } from "./types.js";
import { createWorkspaceKvStore, isRecord } from "./workspace-kv-store.js";

export type WorkspaceEngine = "opencode" | "flue";

type WorkspaceEngineRecord = {
  engine: WorkspaceEngine;
};

const DEFAULT_WORKSPACE_ENGINE: WorkspaceEngine = "opencode";

function normalizeWorkspaceEngine(value: unknown): WorkspaceEngine {
  return value === "flue" ? "flue" : DEFAULT_WORKSPACE_ENGINE;
}

function normalizeWorkspaceEngineRecord(value: unknown): WorkspaceEngineRecord {
  if (!isRecord(value)) return { engine: DEFAULT_WORKSPACE_ENGINE };
  return { engine: normalizeWorkspaceEngine(value.engine) };
}

function parseWorkspaceEngineRecord(json: string): WorkspaceEngineRecord {
  try {
    return normalizeWorkspaceEngineRecord(JSON.parse(json));
  } catch {
    return { engine: DEFAULT_WORKSPACE_ENGINE };
  }
}

const workspaceEngineStore = createWorkspaceKvStore<WorkspaceEngineRecord>({
  tableName: "workspace_engine_configs",
  valueColumn: "config_json",
  parse: parseWorkspaceEngineRecord,
  serialize: (value) => JSON.stringify(value),
});

export function parseWorkspaceEngine(value: unknown): WorkspaceEngine | null {
  if (value === "opencode" || value === "flue") return value;
  return null;
}

export function defaultWorkspaceEngine(): WorkspaceEngine {
  return parseWorkspaceEngine(process.env.OPENWORK_WORKSPACE_ENGINE_DEFAULT) ?? DEFAULT_WORKSPACE_ENGINE;
}

export async function readWorkspaceEngine(config: ServerConfig, workspaceId: string): Promise<WorkspaceEngine> {
  return (await workspaceEngineStore.get(config, workspaceId))?.engine ?? defaultWorkspaceEngine();
}

export async function writeWorkspaceEngine(
  config: ServerConfig,
  workspaceId: string,
  engine: WorkspaceEngine,
): Promise<{ engine: WorkspaceEngine; updatedAt: number }> {
  const updatedAt = Date.now();
  await workspaceEngineStore.set(config, workspaceId, { engine }, updatedAt);
  return { engine, updatedAt };
}
