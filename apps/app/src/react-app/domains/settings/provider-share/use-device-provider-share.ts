import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { DeviceShareOptions } from "@openwork/types/den/device-provider-share";
import { useAutomationsDenContext } from "@/react-app/domains/automations/use-automations";
import { useOrgFeature } from "@/react-app/domains/cloud/use-org-feature";
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
  /** The feature is on for the signed-in person's organization. */
  enabled: boolean;
  options: DeviceShareOptions | null;
  /** Per device provider id: shareable, or already shared. */
  rows: ReadonlyMap<string, DeviceProviderShareRow>;
  /** What the organization section offers while nothing is shared. */
  emptyState: OrganizationShareEmptyState;
  /** Ask Den again, after a share or a change of sign-in. */
  refresh: () => Promise<unknown>;
};

/**
 * What this person can share from this device (Den feature
 * `shareDeviceProvider`). Signed out, feature off or Den unreachable: nothing
 * is offered, and Settings › AI Providers reads exactly as before.
 */
export function useDeviceProviderShare(input: {
  providers: readonly ShareableDeviceProvider[];
  health: (providerId: string) => ProviderCredentialHealth;
}): DeviceProviderShare {
  const featureOn = useOrgFeature("shareDeviceProvider");
  const context = useAutomationsDenContext();
  const auth = useDenAuth();
  const settings = readDenSettings();
  const enabled = featureOn && context.ready;
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
  // Verification replaces the token without changing account/org identity.
  // Ask with the fresh client after that commit rather than retaining an old
  // verificationRequired result in this identity-scoped cache.
  const refetch = query.refetch;
  useEffect(() => { if (enabled) void refetch(); }, [context.client, enabled, refetch]);
  // `enabled: false` stops fetching, not cache reads.
  const options = enabled && !query.isError ? query.data ?? null : null;
  return useMemo(() => ({
    enabled,
    options,
    rows: deviceProviderShareRows(options, candidates),
    emptyState: organizationShareEmptyState(options, candidates),
    refresh: () => query.refetch(),
  }), [enabled, options, candidates, query.refetch]);
}
