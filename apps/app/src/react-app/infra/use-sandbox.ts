import { useQuery } from "@tanstack/react-query";

import { OpenworkServerError, type OpenworkServerClient, type OpenworkSandboxStatusResponse } from "@/app/lib/openwork-server";
import { t } from "@/i18n";

type SandboxConnection = { client: OpenworkServerClient | null; workspaceId: string | null };

export function useSandboxSettings({ client, workspaceId }: SandboxConnection) {
  const queryKey = ["openwork-server", client?.baseUrl, workspaceId, "sandbox-settings"];
  const settings = useQuery({
    queryKey,
    queryFn: async () => {
      if (!client || !workspaceId) return null;
      try {
        return await client.getSandboxSettings(workspaceId);
      } catch (error) {
        if (error instanceof OpenworkServerError && error.status === 404) return null;
        throw error;
      }
    },
    enabled: Boolean(client && workspaceId),
    retry: false,
    refetchInterval: ({ state }) => state.data?.verification === "checking" || state.data?.pending ? 1_000 : false,
  });
  return { settings, queryKey };
}

export function useSandboxStatus({ client, workspaceId }: SandboxConnection, observeChanges = false) {
  const queryKey = ["openwork-server", client?.baseUrl, workspaceId, "sandbox-status"];
  const status = useQuery({
    queryKey,
    queryFn: async () => {
      if (!client || !workspaceId) return null;
      try {
        return await client.getSandboxStatus(workspaceId);
      } catch (error) {
        if (error instanceof OpenworkServerError && error.status === 404) return null;
        throw error;
      }
    },
    enabled: Boolean(client && workspaceId),
    retry: false,
    refetchInterval: ({ state }) => {
      if (state.status === "error" || state.data === null) return false;
      if (state.data?.state === "preparing") return 500;
      if (state.data?.state === "idle" || (observeChanges && state.data?.state === "off")) return 2_000;
      return state.data?.mode && state.data.mode !== "off" ? 10_000 : false;
    },
  });
  return { status, queryKey };
}

export function sandboxCurrentStepText(status: OpenworkSandboxStatusResponse) {
  switch (status.steps.find((step) => step.state === "active")?.id) {
    case "download": return status.imageSource === "bundled" ? t("sandbox.preparing") : t("sandbox.downloading");
    case "folders": return t("sandbox.connecting_folders");
    default: return t("sandbox.starting_tool");
  }
}
