import type { OpenworkServerInfo } from "../lib/tauri";

export function resolveEffectiveOpenworkWorkspaceId(input: {
  runtimeWorkspaceId?: string | null;
  selectedWorkspaceId?: string | null;
  workspaceType?: "local" | "remote" | null;
  hostInfo?: OpenworkServerInfo | null;
}): string | null {
  const runtimeWorkspaceId = input.runtimeWorkspaceId?.trim() ?? "";
  if (runtimeWorkspaceId) {
    return runtimeWorkspaceId;
  }

  const selectedWorkspaceId = input.selectedWorkspaceId?.trim() ?? "";
  if (
    input.workspaceType === "local"
    && input.hostInfo?.startupMode === "server-v2"
    && selectedWorkspaceId
  ) {
    return selectedWorkspaceId;
  }

  return null;
}
