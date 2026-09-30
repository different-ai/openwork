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

export function workspaceIdForRemote(baseUrl: string, directory?: string | null): string {
  const normalizedBaseUrl = baseUrl.trim();
  const normalizedDirectory = directory?.trim() ?? "";
  const key = normalizedDirectory
    ? `remote::${normalizedBaseUrl}::${normalizedDirectory}`
    : `remote::${normalizedBaseUrl}`;
  return workspaceIdForKey(key);
}

export function workspaceIdForOpenwork(hostUrl: string, workspaceId?: string | null): string {
  const normalizedHostUrl = hostUrl.trim();
  const normalizedWorkspaceId = workspaceId?.trim() ?? "";
  const key = normalizedWorkspaceId
    ? `openwork::${normalizedHostUrl}::${normalizedWorkspaceId}`
    : `openwork::${normalizedHostUrl}`;
  return workspaceIdForKey(key);
}

export function buildWorkspaceInfos(
  workspaces: WorkspaceConfig[],
  cwd: string,
): WorkspaceInfo[] {
  return workspaces.map((workspace) => {
    const rawPath = workspace.path?.trim() ?? "";
    const workspaceType = workspace.workspaceType ?? "local";
    const resolvedPath = rawPath ? resolve(cwd, rawPath) : "";
    const remoteType = workspace.remoteType;
    const id = workspace.id?.trim()
      || (workspaceType === "remote"
        ? remoteType === "openwork"
          ? workspaceIdForOpenwork(workspace.openworkHostUrl ?? workspace.baseUrl ?? "", workspace.openworkWorkspaceId)
          : workspaceIdForRemote(workspace.baseUrl ?? "", workspace.directory)
        : workspaceIdForPath(resolvedPath));
    const name = workspace.name?.trim()
      || workspace.displayName?.trim()
      || workspace.openworkWorkspaceName?.trim()
      || basename(resolvedPath || workspace.directory?.trim() || workspace.baseUrl?.trim() || "Workspace");
    return {
      id,
      name,
      path: resolvedPath,
      preset: workspace.preset?.trim() || (workspaceType === "remote" ? "remote" : "starter"),
      workspaceType,
      remoteType,
      baseUrl: workspace.baseUrl,
      directory: workspace.directory,
      displayName: workspace.displayName,
      openworkHostUrl: workspace.openworkHostUrl,
      openworkToken: workspace.openworkToken,
      openworkWorkspaceId: workspace.openworkWorkspaceId,
      openworkWorkspaceName: workspace.openworkWorkspaceName,
      sandboxBackend: workspace.sandboxBackend,
      sandboxRunId: workspace.sandboxRunId,
      sandboxContainerName: workspace.sandboxContainerName,
      opencodeUsername: workspace.opencodeUsername,
      opencodePassword: workspace.opencodePassword,
    };
  });
}

/**
 * Pick the workspace the server-managed OpenCode engine should boot in.
 *
 * The engine serves every workspace but needs one local directory to start in.
 * `config.workspaces[0]` is not reliably that: a freshly added remote worker is
 * prepended to the list, so index 0 can be a remote workspace (no local path)
 * even when local workspaces exist — which would leave the engine unstarted.
 * Select the first non-remote workspace with a resolved local path so the engine
 * starts regardless of ordering; returns undefined for remote-only setups (which
 * need no local engine).
 */
export function findManagedEngineWorkspace(workspaces: WorkspaceInfo[]): WorkspaceInfo | undefined {
  return workspaces.find((workspace) => workspace.workspaceType !== "remote" && workspace.path.trim() !== "");
}

/**
 * Whether a server that manages its own engine should start it. A local
 * workspace needs it, and so does a member with no workspace yet (providers
 * must load right after sign-in). Remote-only setups run their engines
 * elsewhere and need no local one.
 */
export function shouldStartManagedEngine(workspaces: WorkspaceInfo[]): boolean {
  return workspaces.length === 0 || findManagedEngineWorkspace(workspaces) !== undefined;
}

/**
 * Identity of the engine root the managed engine runs in when no workspace
 * scopes a request. It is not a registered workspace: it only names the
 * process cwd so engine-wide maintenance (reload, provider credentials) has a
 * target before the first workspace exists, exactly like `cd ~ && opencode`.
 */
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

/**
 * Directory the managed engine starts in. A signed-in member may have no
 * workspace yet; the engine still needs a cwd, so fall back to a scratch
 * folder under runtime storage rather than refusing to start. The desktop
 * passes its own scratch directory explicitly.
 */
export function resolveManagedEngineCwd(input: {
  explicit?: string | null;
  workspace?: WorkspaceInfo | null;
  fallbackDir: string;
}): string {
  return input.explicit?.trim() || input.workspace?.path.trim() || input.fallbackDir;
}
