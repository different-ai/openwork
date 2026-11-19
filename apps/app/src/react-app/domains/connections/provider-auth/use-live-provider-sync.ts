import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import type { OpenworkServerClient } from "@/app/lib/openwork-server";
import { isOpencodeV2BaseUrl } from "@/app/lib/opencode-v2-adapter";
import { liveProviderSyncStatusQueryKey, usesLiveProviderSync } from "./live-provider-sync";

/** Follow effective provider ownership: managed v2 is live; v1 keeps its materializer. */
export function useLiveProviderSync(client: OpenworkServerClient | null, baseUrl: string) {
  const v2 = isOpencodeV2BaseUrl(baseUrl);
  const status = useQuery({
    queryKey: liveProviderSyncStatusQueryKey(baseUrl),
    queryFn: () => client?.getEngineV2PreviewStatus() ?? null,
    enabled: Boolean(client && v2),
    staleTime: 30_000,
    retry: false,
  });
  const { refetch } = status;
  useEffect(() => {
    if (client && v2) void refetch();
  }, [client, refetch, v2]);
  return usesLiveProviderSync({ baseUrl, status: status.data });
}
