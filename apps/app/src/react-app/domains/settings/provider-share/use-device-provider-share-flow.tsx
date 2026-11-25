import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "@/components/ui/sonner";
import { readDenSettings } from "@/app/lib/den";
import { useDenAuth } from "../../cloud/den-auth-provider";
import { credentialHealthKey, useProviderCredentialHealth, type ProviderCredentialHealth } from "../../connections/provider-auth/credential-health";
import type { DeviceProviderShareRow, OrganizationShareEmptyState, ShareableDeviceProvider, SharedProviderArrival } from "./device-provider-share";
import { ShareProviderDialog } from "./share-provider-dialog";
import { useDeviceProviderShare } from "./use-device-provider-share";

export type DeviceProviderShareFlow = {
  rows: ReadonlyMap<string, DeviceProviderShareRow>;
  emptyState: OrganizationShareEmptyState;
  canShare: boolean;
  resolved: boolean;
  firstShareable: { id: string; name: string } | null;
  open: (provider: { id: string; name: string }) => void;
  dialog: ReactNode;
};

export function useDeviceProviderShareFlow(input: {
  providers: readonly ShareableDeviceProvider[];
  runtimeWorkspaceId: string | null | undefined;
  organizationName: string;
  share: (providerId: string, verifiedToken?: string) => Promise<{ inferenceProviderId: string; name: string }>;
  guided?: {
    confirmArrival: (providerId: string, shared: { inferenceProviderId: string; name: string }) => Promise<SharedProviderArrival>;
    removeDeviceKey: (providerId: string, organizationProviderId: string) => Promise<void>;
    showOrganizationProviders: () => void;
  };
}): DeviceProviderShareFlow {
  const healthEntries = useProviderCredentialHealth((state) => state.entries);
  const workspaceId = input.runtimeWorkspaceId ?? null;
  const health = useCallback((providerId: string): ProviderCredentialHealth =>
    (workspaceId ? healthEntries[credentialHealthKey(workspaceId, providerId)]?.status : undefined) ?? "unverified", [healthEntries, workspaceId]);
  const providerKey = input.providers.map((provider) => `${provider.id}\u001f${provider.name}\u001f${provider.source ?? ""}`).join("\n");
  const providers = useMemo(() => input.providers.map((provider) => ({ ...provider })), [providerKey]);
  const share = useDeviceProviderShare({ providers, health });
  const auth = useDenAuth();
  const settings = readDenSettings();
  const scope = `${settings.baseUrl}\n${settings.activeOrgId}\n${auth.user?.id}`;
  const [selection, setSelection] = useState<{ scope: string; provider: { id: string; name: string } } | null>(null);
  const target = selection?.scope === scope ? selection.provider : null;
  const open = useCallback((provider: { id: string; name: string }) => setSelection({ scope, provider }), [scope]);
  const organizationName = input.organizationName.trim() || "your organization";
  const firstShareable = useMemo(() => {
    const provider = providers.find((entry) => share.rows.get(entry.id)?.state === "shareable");
    return provider ? { id: provider.id, name: provider.name } : null;
  }, [providers, share.rows]);

  const guided = input.guided;
  const shared = useRef(new Map<string, { inferenceProviderId: string; name: string }>());
  const inputShare = input.share;
  const shareAndRemember = useCallback(async (providerId: string, verifiedToken?: string) => {
    const result = await inputShare(providerId, verifiedToken);
    shared.current.set(providerId, result);
    return result;
  }, [inputShare]);
  const dialog = share.enabled ? (
    <ShareProviderDialog
      key={scope}
      provider={target}
      organizationName={organizationName}
      verificationRequired={share.options?.verificationRequired === true}
      onShare={shareAndRemember}
      onShared={(provider) => {
        if (!guided) toast.success(`Shared ${provider.name} with ${organizationName}`);
        void share.refresh();
      }}
      guided={guided ? {
        confirmArrival: async (providerId) => {
          const created = shared.current.get(providerId);
          return created ? guided.confirmArrival(providerId, created) : { status: "pending" };
        },
        useOrganizationCopy: async (provider, arrival) => {
          if (arrival.status === "arrived") await guided.removeDeviceKey(provider.id, arrival.organizationProviderId);
        },
        onFinished: (provider, result) => {
          void share.refresh();
          if (result.arrival.status === "arrived") {
            toast.success(result.kept
              ? `Shared ${provider.name} with ${organizationName}`
              : `Shared ${provider.name} with ${organizationName} and removed your key from this device`);
            guided.showOrganizationProviders();
          }
        },
      } : undefined}
      onClose={() => setSelection(null)}
    />
  ) : null;

  return {
    rows: share.rows,
    emptyState: share.emptyState,
    canShare: share.options?.canShare === true,
    resolved: share.options !== null,
    firstShareable,
    open,
    dialog,
  };
}
