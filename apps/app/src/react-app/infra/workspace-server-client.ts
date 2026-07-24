import { useMemo } from "react";

import {
  isRemoteWorkspace,
  resolveWorkspaceEndpoint,
  workspaceServerId,
  type LocalServerHandle,
  type ResolvedWorkspaceEndpoint,
} from "@/app/lib/workspace-endpoint";

export type WorkspaceServerClientWorkspace = Parameters<typeof resolveWorkspaceEndpoint>[0];
export type WorkspaceServerClientResolver = (
  workspace: WorkspaceServerClientWorkspace,
) => ResolvedWorkspaceEndpoint | null;

type NormalizedLocalServer = {
  baseUrl: string;
  token: string;
};

function trim(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

function normalizeLocalServer(localServer: LocalServerHandle): NormalizedLocalServer {
  return {
    baseUrl: trim(localServer.baseUrl),
    token: trim(localServer.token),
  };
}

function remoteBaseUrl(workspace: NonNullable<WorkspaceServerClientWorkspace>): string {
  return trim(workspace.baseUrl) || trim(workspace.openworkHostUrl);
}

function remoteToken(workspace: NonNullable<WorkspaceServerClientWorkspace>): string {
  return (
    trim(workspace.openworkToken) ||
    trim(workspace.openworkClientToken) ||
    trim(workspace.openworkHostToken)
  );
}

function cacheKey(parts: string[]): string {
  return parts.join("\u001f");
}

export function createWorkspaceServerClientCacheKey(
  workspace: WorkspaceServerClientWorkspace,
  localServer: LocalServerHandle,
): string {
  if (!workspace) return "workspace:none";

  if (isRemoteWorkspace(workspace)) {
    return cacheKey([
      "workspace:remote",
      workspaceServerId(workspace),
      remoteBaseUrl(workspace),
      remoteToken(workspace),
    ]);
  }

  const normalizedLocalServer = normalizeLocalServer(localServer);
  return cacheKey([
    "workspace:local",
    trim(workspace.id),
    normalizedLocalServer.baseUrl,
    normalizedLocalServer.token,
  ]);
}

/**
 * Workspace-scoped OpenWork server client resolver.
 *
 * The returned endpoint includes the correctly mounted workspace URLs and a
 * memoized OpenWork server client. The cache is intentionally per resolver so
 * React routes/stores do not share mutable clients across workspace contexts.
 */
export function createWorkspaceServerClientResolver(
  localServer: LocalServerHandle,
): WorkspaceServerClientResolver {
  const normalizedLocalServer = normalizeLocalServer(localServer);
  const cache = new Map<string, ResolvedWorkspaceEndpoint | null>();

  return (workspace) => {
    const key = createWorkspaceServerClientCacheKey(workspace, normalizedLocalServer);
    if (cache.has(key)) {
      const cached = cache.get(key);
      return cached === undefined ? null : cached;
    }

    const endpoint = resolveWorkspaceEndpoint(workspace, normalizedLocalServer);
    cache.set(key, endpoint);
    return endpoint;
  };
}

export function useWorkspaceServerClient(
  workspace: WorkspaceServerClientWorkspace,
  localServer: LocalServerHandle,
): ResolvedWorkspaceEndpoint | null {
  const localBaseUrl = trim(localServer.baseUrl);
  const localToken = trim(localServer.token);
  const workspaceKey = createWorkspaceServerClientCacheKey(workspace, {
    baseUrl: localBaseUrl,
    token: localToken,
  });

  // `workspaceKey` intentionally includes only fields that change endpoint
  // behavior; remote workspaces do not churn when the local server reconnects.
  return useMemo(
    () => createWorkspaceServerClientResolver({ baseUrl: localBaseUrl, token: localToken })(workspace),
    [workspaceKey],
  );
}
