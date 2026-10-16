import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import type { WorkspaceConfig, WorkspaceInfo } from "./types.js";

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
    // Remote workspaces were removed; configs persisted by older builds can
    // still carry them, so drop any entry that is not a local workspace.
    .filter((workspace) => (workspace.workspaceType ?? "local") === "local")
    .map((workspace) => {
      const rawPath = workspace.path?.trim() ?? "";
      const resolvedPath = rawPath ? resolve(cwd, rawPath) : "";
      const id = workspace.id?.trim() || workspaceIdForPath(resolvedPath);
      const name = workspace.name?.trim()
        || workspace.displayName?.trim()
        || basename(resolvedPath || "Workspace");
      return {
        id,
        name,
        path: resolvedPath,
        preset: workspace.preset?.trim() || "starter",
        workspaceType: "local",
        displayName: workspace.displayName,
        sandboxBackend: workspace.sandboxBackend,
        sandboxRunId: workspace.sandboxRunId,
        sandboxContainerName: workspace.sandboxContainerName,
      };
    });
}

/** The active workspace: the first with a resolved local path. The engine sets it up first. */
export function findManagedEngineWorkspace(workspaces: WorkspaceInfo[]): WorkspaceInfo | undefined {
  return workspaces.find((workspace) => workspace.path.trim() !== "");
}
