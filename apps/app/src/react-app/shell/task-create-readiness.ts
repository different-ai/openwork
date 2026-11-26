export function taskCreateBlocker(input: {
  agentChat: boolean;
  hasWorkspace: boolean;
  hasEndpointToken: boolean;
  refreshingWorkspaces: boolean;
  loadingSessionList: boolean;
}): "loading" | "missing_workspace" | "disconnected" | null {
  if (!input.agentChat && (input.refreshingWorkspaces || input.loadingSessionList)) return "loading";
  if (input.refreshingWorkspaces && (!input.hasWorkspace || !input.hasEndpointToken)) return "loading";
  if (!input.hasWorkspace) return "missing_workspace";
  if (!input.hasEndpointToken) return "disconnected";
  return null;
}
