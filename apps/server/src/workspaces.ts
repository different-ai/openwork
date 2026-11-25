import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import type { ServerConfig, WorkspaceConfig, WorkspaceInfo } from "./types.js";

export function hasExternalOpencode(config: Pick<ServerConfig, "externalOpencode" | "opencodeBaseUrl"> & Partial<Pick<ServerConfig, "workspaces">>): boolean {
  return config.externalOpencode ?? Boolean(config.opencodeBaseUrl || config.workspaces?.some((workspace) => workspace.baseUrl));
}

function workspaceIdForKey(key: string): string {
  const hash = createHash("sha256").update(key).digest("hex");
  return `ws_${hash.slice(0, 12)}`;
}

export function workspaceIdForPath(path: string): string {
  return workspaceIdForKey(path);
}

export function buildWorkspaceInfos(
  workspaces: WorkspaceConfig[],
  cwd: string,
): WorkspaceInfo[] {
  return workspaces
    .filter((workspace) => (workspace.workspaceType ?? "local") === "local")
    .map((workspace) => {
      const rawPath = workspace.path?.trim() ?? "";
      const resolvedPath = rawPath ? resolve(cwd, rawPath) : "";
      const id = workspace.id?.trim() || workspaceIdForPath(resolvedPath);
      const name = workspace.name?.trim()
        || workspace.displayName?.trim()
        || basename(resolvedPath || workspace.directory?.trim() || "Workspace");
      return {
        id,
        name,
        path: resolvedPath,
        preset: workspace.preset?.trim() || "starter",
        workspaceType: "local",
        baseUrl: workspace.baseUrl,
        directory: workspace.directory,
        displayName: workspace.displayName,
        sandboxBackend: workspace.sandboxBackend,
        sandboxRunId: workspace.sandboxRunId,
        sandboxContainerName: workspace.sandboxContainerName,
        opencodeUsername: workspace.opencodeUsername,
        opencodePassword: workspace.opencodePassword,
      };
    });
}

export function findManagedEngineWorkspace(workspaces: WorkspaceInfo[]): WorkspaceInfo | undefined {
  return workspaces.find((workspace) => workspace.path.trim() !== "");
}

export function shouldStartManagedEngine(workspaces: WorkspaceInfo[]): boolean {
  return workspaces.length === 0 || findManagedEngineWorkspace(workspaces) !== undefined;
}

export const MANAGED_ENGINE_ROOT_WORKSPACE_ID = "ws_managed_engine_root";

export function managedEngineRootWorkspace(cwd: string): WorkspaceInfo {
  return {
    id: MANAGED_ENGINE_ROOT_WORKSPACE_ID,
    name: "OpenCode engine",
    path: cwd,
    preset: "starter",
    workspaceType: "local",
  };
}

export function resolveManagedEngineCwd(input: {
  explicit?: string | null;
  workspace?: WorkspaceInfo | null;
  fallbackDir: string;
}): string {
  return input.explicit?.trim() || input.workspace?.path.trim() || input.fallbackDir;
}
