import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { createClientV2 } from "@/app/lib/opencode-v2-adapter";
import { OpenworkServerError } from "@/app/lib/openwork-server";
import type { ResolvedWorkspaceEndpoint } from "@/app/lib/workspace-endpoint";
import type { Client } from "@/app/types";

export async function readChatRoutesToV2(endpoint: Pick<ResolvedWorkspaceEndpoint, "client">): Promise<boolean> {
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
  workspaceRoot: string;
  fallback: { client: Client | null; baseUrl: string };
}): { client: Client | null; baseUrl: string } {
  const { endpoint, workspaceRoot, fallback } = input;
  const routing = useQuery({
    queryKey: ["chat-engine-routing", endpoint?.baseUrl ?? "", endpoint?.token ?? ""],
    queryFn: () => (endpoint ? readChatRoutesToV2(endpoint) : false),
    enabled: Boolean(endpoint?.token),
    staleTime: 30_000,
  });
  const v2 = routing.data === true && Boolean(endpoint?.token);
  const baseUrl = v2 && endpoint ? `${endpoint.mountedBaseUrl}/opencode2` : fallback.baseUrl;
  const client = useMemo(() => {
    if (!v2 || !endpoint) return fallback.client;
    return createClientV2(baseUrl, workspaceRoot || undefined, { token: endpoint.token });
  }, [baseUrl, endpoint, fallback.client, v2, workspaceRoot]);
  return { client, baseUrl };
}

