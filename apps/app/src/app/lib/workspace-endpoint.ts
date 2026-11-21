import type { WorkspaceInfo } from "./desktop";
import {
  buildOpenworkWorkspaceBaseUrl,
  createOpenworkServerClient,
  type OpenworkServerClient,
} from "./openwork-server";

export type ResolvedWorkspaceEndpoint = {
  baseUrl: string;
  token: string;
  workspaceId: string;
  client: OpenworkServerClient;
  mountedBaseUrl: string;
  opencodeBaseUrl: string;
};

export type LocalServerHandle = {
  baseUrl: string | null | undefined;
  token: string | null | undefined;
};

type WorkspaceEndpointInput = Pick<WorkspaceInfo, "id"> | null | undefined;

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

export function resolveEngineRootEndpoint(
  localServer: LocalServerHandle,
): { opencodeBaseUrl: string; token: string } | null {
  const baseUrl = (localServer.baseUrl ?? "").trim().replace(/\/+$/, "");
  const token = (localServer.token ?? "").trim();
  if (!baseUrl || !token) return null;
  return { opencodeBaseUrl: `${baseUrl}/opencode`, token };
}
