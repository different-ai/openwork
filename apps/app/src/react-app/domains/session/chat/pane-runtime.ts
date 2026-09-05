import type { WorkspaceInfo } from "@/app/lib/desktop";
import type { ResolvedWorkspaceEndpoint } from "@/app/lib/workspace-endpoint";

type PaneWorkspace = Pick<WorkspaceInfo, "id" | "path" | "workspaceType">;

export type WorkbenchPaneEndpoint<TWorkspace extends PaneWorkspace = PaneWorkspace> = {
  status: "ready";
  workspaceId: string;
  workspaceTitle: string;
  workspaceRoot: string;
  workspaceType?: WorkspaceInfo["workspaceType"];
  workspace: TWorkspace;
  endpoint: ResolvedWorkspaceEndpoint;
} | {
  status: "unavailable";
  workspaceId: string;
  workspaceTitle: string;
  message: string;
};

export function resolveWorkbenchPaneEndpoint<TWorkspace extends PaneWorkspace>(input: {
  workspaceId: string;
  workspaceTitle: string;
  workspace: TWorkspace | undefined;
  endpoint: ResolvedWorkspaceEndpoint | null;
  connectionError?: string | null;
}): WorkbenchPaneEndpoint<TWorkspace> {
  if (!input.workspace) {
    return {
      status: "unavailable",
      workspaceId: input.workspaceId,
      workspaceTitle: input.workspaceTitle,
      message: "This workspace is no longer available.",
    };
  }

  const connectionError = input.connectionError?.trim();
  if (connectionError) {
    return {
      status: "unavailable",
      workspaceId: input.workspace.id,
      workspaceTitle: input.workspaceTitle,
      message: connectionError,
    };
  }

  if (!input.endpoint?.token) {
    return {
      status: "unavailable",
      workspaceId: input.workspace.id,
      workspaceTitle: input.workspaceTitle,
      message: "OpenWork could not connect to this workspace runtime.",
    };
  }

  return {
    status: "ready",
    workspaceId: input.workspace.id,
    workspaceTitle: input.workspaceTitle,
    workspaceRoot: input.workspace.path?.trim() || "",
    workspaceType: input.workspace.workspaceType,
    workspace: input.workspace,
    endpoint: input.endpoint,
  };
}
