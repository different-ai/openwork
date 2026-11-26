import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { createClientV2 } from "@/app/lib/opencode-v2-adapter";
import { OpenworkServerError } from "@/app/lib/openwork-server";
import type { ResolvedWorkspaceEndpoint } from "@/app/lib/workspace-endpoint";
import type { Client } from "@/app/types";

type RoutingStatusClient = Pick<ResolvedWorkspaceEndpoint["client"], "getEngineV2PreviewStatus">;

export async function readChatRoutesToV2(endpoint: { client: RoutingStatusClient }): Promise<boolean> {
  try {
    const status = await endpoint.client.getEngineV2PreviewStatus();
    return status.enabled && status.chatRouting;
  } catch (error) {
    if (error instanceof OpenworkServerError && error.status === 404) return false;
    throw error;
  }
}

export function useChatEngineClient(input: {
  endpoint: ResolvedWorkspaceEndpoint | null;
  engineRoot?: { opencodeBaseUrl: string; token: string } | null;
  serverClient?: RoutingStatusClient | null;
  workspaceRoot: string;
  fallback: { client: Client | null; baseUrl: string };
}): { client: Client | null; baseUrl: string } {
  const { endpoint, engineRoot, serverClient, workspaceRoot, fallback } = input;
  const serverBaseUrl = endpoint?.baseUrl ?? engineRoot?.opencodeBaseUrl.replace(/\/opencode\/?$/, "") ?? "";
  const token = endpoint?.token ?? engineRoot?.token ?? "";
  const statusClient = endpoint?.client ?? (engineRoot ? serverClient : null);
  const routing = useQuery({
    queryKey: ["chat-engine-routing", serverBaseUrl, token],
    queryFn: () => (statusClient ? readChatRoutesToV2({ client: statusClient }) : false),
    enabled: Boolean(statusClient && token),
    staleTime: 30_000,
  });
  const v2 = routing.data === true && Boolean(statusClient && token);
  const baseUrl = v2 ? `${endpoint?.mountedBaseUrl ?? serverBaseUrl}/opencode2` : fallback.baseUrl;
  const client = useMemo(() => {
    if (!v2) return fallback.client;
    return createClientV2(baseUrl, workspaceRoot || undefined, { token });
  }, [baseUrl, fallback.client, token, v2, workspaceRoot]);
  return { client, baseUrl };
}

