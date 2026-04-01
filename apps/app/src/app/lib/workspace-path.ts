import type { WorkspaceInfo } from "./tauri";

export function resolveCreatedLocalWorkspacePath(input: {
  workspaceId?: string | null;
  workspaces: WorkspaceInfo[];
  fallbackPath?: string | null;
}) {
  const fallbackPath = input.fallbackPath?.trim() ?? "";
  const workspaceId = input.workspaceId?.trim() ?? "";
  if (!workspaceId) return fallbackPath;

  const created = input.workspaces.find((workspace) => workspace.id === workspaceId && workspace.workspaceType === "local");
  const path = created?.path?.trim() ?? "";
  return path || fallbackPath;
}
