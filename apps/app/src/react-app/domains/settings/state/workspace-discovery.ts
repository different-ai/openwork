export const SETTINGS_DISCOVERY_TIMEOUT_MS = 8_000;

type WorkspaceRegistryState = "pending" | "listed" | "unreachable";
export type SettingsWorkspaceState = "discovering" | "connected" | "missing" | "disconnected" | "timed-out";

export function settingsWorkspaceState(input: {
  registry: WorkspaceRegistryState;
  workspaceFound: boolean;
  deadlineReached: boolean;
}): SettingsWorkspaceState {
  switch (input.registry) {
    case "listed": return input.workspaceFound ? "connected" : "missing";
    case "unreachable": return "disconnected";
    case "pending": return input.deadlineReached ? "timed-out" : "discovering";
  }
}

export type { WorkspaceRegistryState };
