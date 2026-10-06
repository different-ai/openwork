/**
 * Single source of truth for "where does a workspace's server live?".
 *
 * Every workspace is owned by the user's local OpenWork server. Always go
 * through {@link resolveWorkspaceEndpoint} when you need:
 *   - an `OpenworkServerClient` for a workspace
 *   - a mounted `/workspace/<id>` URL prefix
 *   - the `/opencode` URL for the OpenCode SDK
 *
 * Don't compose `<baseUrl>/workspace/<id>` by hand.
 */

import type { WorkspaceInfo } from "./desktop";
import {
  buildOpenworkWorkspaceBaseUrl,
  createOpenworkServerClient,
  type OpenworkServerClient,
} from "./openwork-server";

export type ResolvedWorkspaceEndpoint = {
  /** Host URL of the OpenWork server that owns this workspace (no `/workspace` mount). */
  baseUrl: string;
  /** Auth token for that server. May be empty for unauthenticated local servers. */
  token: string;
  /** Workspace id as the owning server expects it in URL paths. */
  workspaceId: string;
  /** OpenworkServerClient bound to {@link baseUrl}/{@link token}. */
  client: OpenworkServerClient;
  /** Mounted base url: `<baseUrl>/workspace/<workspaceId>`. No trailing slash. */
  mountedBaseUrl: string;
  /** OpenCode SDK base url: `<mountedBaseUrl>/opencode`. */
  opencodeBaseUrl: string;
};

export type LocalServerHandle = {
  baseUrl: string | null | undefined;
  token: string | null | undefined;
};

type WorkspaceEndpointInput = Pick<WorkspaceInfo, "id"> | null | undefined;

/**
 * Resolve the right server endpoint for a workspace. Returns null when the
 * local server isn't connected yet. The returned object's `client`, `mountedBaseUrl`, and
 * `opencodeBaseUrl` are ready to use for any workspace-scoped API call.
 */
export function resolveWorkspaceEndpoint(
  workspace: WorkspaceEndpointInput,
  localServer: LocalServerHandle,
): ResolvedWorkspaceEndpoint | null {
  if (!workspace) return null;

  const localBaseUrl = (localServer.baseUrl ?? "").trim();
  if (!localBaseUrl) return null;
  const localToken = (localServer.token ?? "").trim();
  const workspaceId = workspace.id.trim();
  const client = createOpenworkServerClient({
    baseUrl: localBaseUrl,
    token: localToken || undefined,
  });
  const mountedBaseUrl = (
    buildOpenworkWorkspaceBaseUrl(localBaseUrl, workspaceId) ?? localBaseUrl
  ).replace(/\/+$/, "");
  return {
    baseUrl: localBaseUrl,
    token: localToken,
    workspaceId,
    client,
    mountedBaseUrl,
    opencodeBaseUrl: `${mountedBaseUrl}/opencode`,
  };
}

/**
 * The local server's managed engine, addressed without a workspace. The
 * server runs its engine before the first workspace exists and proxies
 * `<server>/opencode/*` to it, so providers can be listed and connected
 * right after sign-in. Returns null without a connected local server.
 */
export function resolveEngineRootEndpoint(
  localServer: LocalServerHandle,
): { opencodeBaseUrl: string; token: string } | null {
  const baseUrl = (localServer.baseUrl ?? "").trim().replace(/\/+$/, "");
  const token = (localServer.token ?? "").trim();
  if (!baseUrl || !token) return null;
  return { opencodeBaseUrl: `${baseUrl}/opencode`, token };
}
