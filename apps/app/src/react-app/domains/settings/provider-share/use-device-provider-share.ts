import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { DeviceShareOptions } from "@openwork/types/den/device-provider-share";
import { useAutomationsDenContext } from "@/react-app/domains/automations/use-automations";
import type { ProviderCredentialHealth } from "../../connections/provider-auth/credential-health";
import { useDenAuth } from "../../cloud/den-auth-provider";
import { readDenSettings } from "@/app/lib/den";
import {
  deviceProviderShareRows,
  deviceShareCandidates,
  organizationShareEmptyState,
  type DeviceProviderShareRow,
  type OrganizationShareEmptyState,
  type ShareableDeviceProvider,
} from "./device-provider-share";

export type DeviceProviderShare = {
  enabled: boolean;
  options: DeviceShareOptions | null;
  rows: ReadonlyMap<string, DeviceProviderShareRow>;
  emptyState: OrganizationShareEmptyState;
  refresh: () => Promise<unknown>;
};

export function useDeviceProviderShare(input: {
  providers: readonly ShareableDeviceProvider[];
  health: (providerId: string) => ProviderCredentialHealth;
}): DeviceProviderShare {
  const context = useAutomationsDenContext();
  const auth = useDenAuth();
  const settings = readDenSettings();
  const enabled = context.ready;
  const candidates = useMemo(() => deviceShareCandidates(input.providers, input.health), [input.providers, input.health]);
  const ids = useMemo(() => candidates.map((provider) => provider.id).sort(), [candidates]);
  const query = useQuery({
    queryKey: ["den", "device-share-options", settings.baseUrl, settings.apiBaseUrl, auth.user?.id, context.organizationId, ids.join(",")],
    queryFn: () => {
      if (!context.client || !context.organizationId) throw new Error("Organization is not ready");
      return context.client.getDeviceShareOptions(context.organizationId, ids);
    },
    enabled,
    staleTime: 30_000,
    retry: false,
  });
  const refetch = query.refetch;
  useEffect(() => { if (enabled) void refetch(); }, [context.client, enabled, refetch]);
  const options = enabled && !query.isError ? query.data ?? null : null;
  return useMemo(() => ({
    enabled,
    options,
    rows: deviceProviderShareRows(options, candidates),
    emptyState: organizationShareEmptyState(options, candidates),
    refresh: () => query.refetch(),
  }), [enabled, options, candidates, query.refetch]);
}
