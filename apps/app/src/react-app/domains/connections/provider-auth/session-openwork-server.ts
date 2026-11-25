import {
  createOpenworkServerClient,
  isLoopbackOpenworkServerUrl,
  readOpenworkServerSettings,
  type OpenworkServerClient,
} from "@/app/lib/openwork-server";
import type { ResolvedWorkspaceEndpoint } from "@/app/lib/workspace-endpoint";
import type { ProviderAuthOpenworkServer } from "./store";

type SessionOpenworkServerSnapshot = ReturnType<ProviderAuthOpenworkServer["getSnapshot"]>;

export type SessionServerEndpoint = Pick<ResolvedWorkspaceEndpoint, "baseUrl" | "token" | "client">;

export type CreateSessionOpenworkServerInput = {
  endpoint: () => SessionServerEndpoint | null;
  hostToken?: () => string;
  generation?: () => number | null;
};

function resolveHostToken(endpoint: SessionServerEndpoint, live: string): string {
  if (!isLoopbackOpenworkServerUrl(endpoint.baseUrl)) return "";
  if (live) return live;
  return readOpenworkServerSettings().hostToken?.trim() ?? "";
}

export function createSessionOpenworkServer(
  input: CreateSessionOpenworkServerInput,
): ProviderAuthOpenworkServer {
  let clientCacheKey = "";
  let clientCacheValue: OpenworkServerClient | null = null;

  const hostAwareClient = (endpoint: SessionServerEndpoint, hostToken: string): OpenworkServerClient => {
    if (!hostToken) return endpoint.client;
    const key = `${endpoint.baseUrl}\u001f${endpoint.token}\u001f${hostToken}`;
    if (key !== clientCacheKey || !clientCacheValue) {
      clientCacheKey = key;
      clientCacheValue = createOpenworkServerClient({
        baseUrl: endpoint.baseUrl,
        token: endpoint.token || undefined,
        hostToken,
      });
    }
    return clientCacheValue;
  };

  return {
    getSnapshot: (): SessionOpenworkServerSnapshot => {
      const endpoint = input.endpoint();
      if (!endpoint) {
        return {
          openworkServerStatus: "disconnected",
          openworkServerClient: null,
          openworkServerCapabilities: null,
        };
      }
      if (!isLoopbackOpenworkServerUrl(endpoint.baseUrl)) {
        return {
          openworkServerStatus: "connected",
          openworkServerClient: endpoint.client,
          openworkServerCapabilities: { config: { read: true, write: true } },
        };
      }
      const hostToken = resolveHostToken(endpoint, input.hostToken?.().trim() ?? "");
      return {
        openworkServerStatus: "connected",
        openworkServerClient: hostAwareClient(endpoint, hostToken),
        openworkServerHostInfo: { generation: input.generation?.() ?? null },
        openworkServerAuth: {
          token: endpoint.token || undefined,
          hostToken: hostToken || undefined,
        },
        openworkServerCapabilities: {
          config: { read: true, write: true },
          providerSync: true,
        },
      };
    },
  };
}
