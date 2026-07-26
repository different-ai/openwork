import { createWorkspaceKvStore, isRecord } from "./workspace-kv-store.js";
import type { ServerConfig } from "./types.js";

export type AgentRuntime = "opencode" | "codex";

export type AgentRuntimeState = {
  runtime: AgentRuntime;
};

const DEFAULT_AGENT_RUNTIME_STATE: AgentRuntimeState = { runtime: "opencode" };

function parseAgentRuntimeState(json: string): AgentRuntimeState {
  try {
    const value: unknown = JSON.parse(json);
    if (isRecord(value) && value.runtime === "codex") {
      return { runtime: "codex" };
    }
  } catch {
    // Invalid legacy state falls back to the safe default.
  }
  return DEFAULT_AGENT_RUNTIME_STATE;
}

const agentRuntimeStore = createWorkspaceKvStore<AgentRuntimeState>({
  tableName: "agent_runtime_state",
  valueColumn: "state_json",
  parse: parseAgentRuntimeState,
  serialize: JSON.stringify,
});

export async function readAgentRuntimeState(
  config: ServerConfig,
  workspaceId: string,
): Promise<AgentRuntimeState> {
  return (await agentRuntimeStore.get(config, workspaceId)) ?? DEFAULT_AGENT_RUNTIME_STATE;
}

export async function writeAgentRuntimeState(
  config: ServerConfig,
  workspaceId: string,
  runtime: AgentRuntime,
): Promise<AgentRuntimeState> {
  const state = { runtime } satisfies AgentRuntimeState;
  await agentRuntimeStore.set(config, workspaceId, state);
  return state;
}

export async function workspaceUsesCodexRuntime(
  config: ServerConfig,
  workspaceId: string,
): Promise<boolean> {
  return (await readAgentRuntimeState(config, workspaceId)).runtime === "codex";
}
