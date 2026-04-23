import type { OpenworkStore } from "./store";

export const selectActiveWorkspace = (state: OpenworkStore) =>
  state.workspaces.find(
    (workspace) => workspace.id === state.activeWorkspaceId,
  ) ?? null;

export const selectServerStatus = (state: OpenworkStore) => state.server.status;

export const selectServerUrl = (state: OpenworkStore) => state.server.url;

export const selectErrorBanner = (state: OpenworkStore) => state.errorBanner;
