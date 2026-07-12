import type {
  OpenworkServerCapabilities,
  OpenworkServerClient,
  OpenworkServerStatus,
} from "@/app/lib/openwork-server";
import type { ResolvedWorkspaceEndpoint } from "@/app/lib/workspace-endpoint";

export const WORKSPACE_OPENWORK_CAPABILITIES: OpenworkServerCapabilities = {
  skills: { read: true, write: true, source: "openwork" },
  plugins: { read: true, write: true },
  mcp: { read: true, write: true },
  commands: { read: true, write: true },
  config: { read: true, write: true },
};

export type WorkspaceOpenworkServerSnapshot = {
  openworkServerClient: OpenworkServerClient | null;
  openworkServerStatus: OpenworkServerStatus;
  openworkServerCapabilities: OpenworkServerCapabilities | null;
  openworkServerIsRemote: boolean;
  openworkServerBaseUrl: string;
  openworkServerAuth: { token: string | null };
};

export type WorkspaceOpenworkServer = {
  getSnapshot: () => WorkspaceOpenworkServerSnapshot;
};

export type WorkspaceReloadTarget = {
  client: OpenworkServerClient;
  workspaceId: string;
  isRemote: boolean;
};

export function workspaceOpenworkServerSnapshot(
  endpoint: ResolvedWorkspaceEndpoint | null,
): WorkspaceOpenworkServerSnapshot {
  return {
    openworkServerClient: endpoint?.client ?? null,
    openworkServerStatus: endpoint ? "connected" : "disconnected",
    openworkServerCapabilities: endpoint ? WORKSPACE_OPENWORK_CAPABILITIES : null,
    openworkServerIsRemote: endpoint?.isRemote === true,
    openworkServerBaseUrl: endpoint?.baseUrl ?? "",
    openworkServerAuth: { token: endpoint?.token || null },
  };
}

export function canFallbackToDesktopEngineRestart(input: {
  engineUnreachable: boolean;
  desktopRuntime: boolean;
  remoteWorkspace: boolean;
}): boolean {
  return (
    input.engineUnreachable &&
    input.desktopRuntime &&
    !input.remoteWorkspace
  );
}

export function captureWorkspaceReloadTarget(
  snapshot: WorkspaceOpenworkServerSnapshot,
  workspaceId: string | null | undefined,
): WorkspaceReloadTarget | null {
  const resolvedWorkspaceId = workspaceId?.trim() ?? "";
  if (
    snapshot.openworkServerStatus !== "connected" ||
    !snapshot.openworkServerClient ||
    !resolvedWorkspaceId
  ) {
    return null;
  }
  return {
    client: snapshot.openworkServerClient,
    workspaceId: resolvedWorkspaceId,
    isRemote: snapshot.openworkServerIsRemote,
  };
}
