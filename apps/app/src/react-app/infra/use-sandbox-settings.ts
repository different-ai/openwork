import { useQuery } from "@tanstack/react-query";
import type { OpenworkSandboxSettingsResponse, OpenworkServerClient } from "../../app/lib/openwork-server";

export function sandboxSettingsQueryKey(client: OpenworkServerClient | null, workspaceId: string | null) {
  return ["openwork-server", client?.baseUrl ?? null, "sandbox-settings", workspaceId];
}

export function sandboxSettingsPollInterval(settings: OpenworkSandboxSettingsResponse | null | undefined): number | false {
  if (settings?.pending) return 1_000;
  if (settings && !settings.effectiveAllowHostExecution && (settings.runtime?.state === "starting" || settings.runtime?.state === "idle")) return 1_000;
  return settings ? 5_000 : false;
}

export function useSandboxSettings({ client, workspaceId, enabled }: {
  client: OpenworkServerClient | null;
  workspaceId: string | null;
  enabled: boolean;
}) {
  const queryKey = sandboxSettingsQueryKey(client, workspaceId);
  const query = useQuery({
    queryKey,
    queryFn: () => client && workspaceId ? client.getSandboxSettings(workspaceId) : null,
    enabled: enabled && Boolean(client) && Boolean(workspaceId),
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: true,
    refetchInterval: (current) => sandboxSettingsPollInterval(current.state.data),
  });
  return { ...query, queryKey };
}
