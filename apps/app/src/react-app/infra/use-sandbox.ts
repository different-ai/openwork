import { useState } from "react";
import type { OpenworkSandboxSettingsResponse, OpenworkSandboxStatusResponse } from "@/app/lib/openwork-server";
import { queryOptions, useQuery } from "@tanstack/react-query";

import { OpenworkServerError, type OpenworkServerClient } from "@/app/lib/openwork-server";

type SandboxConnection = { client: OpenworkServerClient | null; workspaceId: string | null };

export function sandboxSettingsPollInterval(settings: Pick<OpenworkSandboxSettingsResponse, "verification" | "pending"> | null | undefined, mountedMs: number): number | false {
  if (settings?.verification === "checking" || settings?.verification === "refreshing") return 1_000;
  if (settings?.verification === "unavailable") return mountedMs < 120_000 ? 5_000 : false;
  return settings?.pending ? 1_000 : false;
}

export function sandboxSettingsQuery({ client, workspaceId }: SandboxConnection) {
  return queryOptions({
    queryKey: ["openwork-server", client?.baseUrl, workspaceId, "sandbox-settings"],
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
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
    refetchIntervalInBackground: false,
  });
}

export function useSandboxSettings(connection: SandboxConnection) {
  const [mountedAt] = useState(() => Date.now());
  const options = sandboxSettingsQuery(connection);
  const settings = useQuery({
    ...options,
    refetchInterval: ({ state }) => state.status === "error" ? false : sandboxSettingsPollInterval(state.data, Date.now() - mountedAt),
  });
  return { settings, queryKey: options.queryKey };
}

export function sandboxStatusQueryKey({ client, workspaceId }: SandboxConnection) {
  return ["openwork-server", client?.baseUrl, workspaceId, "sandbox-status"];
}

export function sandboxStatusPollInterval(status: Pick<OpenworkSandboxStatusResponse, "state"> | null | undefined, settledMs: number): number | false {
  if (!status) return false;
  if (status.state === "preparing") return 500;
  if (status.state === "idle" || status.state === "off") return 2_000;
  return settledMs;
}

export function useSandboxStatus(connection: SandboxConnection, observe: boolean, settledMs = 10_000) {
  const { client, workspaceId } = connection;
  const queryKey = sandboxStatusQueryKey(connection);
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
    enabled: observe && Boolean(client && workspaceId),
    retry: false,
    refetchIntervalInBackground: false,
    refetchInterval: ({ state }) => state.status === "error" ? false : sandboxStatusPollInterval(state.data, settledMs),
  });
  return { status, queryKey };
}
