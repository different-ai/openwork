import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import type { WorkspaceConfig, WorkspaceInfo } from "./types.js";

export function workspaceIdForPath(path: string): string {
  const hash = createHash("sha256").update(path).digest("hex");
  return `ws_${hash.slice(0, 12)}`;
}

export function buildWorkspaceInfos(
  workspaces: WorkspaceConfig[],
  cwd: string,
): WorkspaceInfo[] {
  return workspaces.map((workspace) => {
    const resolvedPath = resolve(cwd, workspace.path);
    return {
      id: workspaceIdForPath(resolvedPath),
      name: workspace.name ?? basename(resolvedPath),
      path: resolvedPath,
      workspaceType: workspace.workspaceType ?? "local",
      baseUrl: workspace.baseUrl,
      directory: workspace.directory,
    };
  });
}
