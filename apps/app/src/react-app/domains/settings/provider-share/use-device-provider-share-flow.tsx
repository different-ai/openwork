import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "@/components/ui/sonner";
import { readDenSettings } from "@/app/lib/den";
import { useDenAuth } from "../../cloud/den-auth-provider";
import { credentialHealthKey, useProviderCredentialHealth, type ProviderCredentialHealth } from "../../connections/provider-auth/credential-health";
import type { DeviceProviderShareRow, OrganizationShareEmptyState, ShareableDeviceProvider, SharedProviderArrival } from "./device-provider-share";
import { ShareProviderDialog } from "./share-provider-dialog";
import { useDeviceProviderShare } from "./use-device-provider-share";

export type DeviceProviderShareFlow = {
  /** Per device provider id: shareable, or already shared. Empty when the feature is off. */
  rows: ReadonlyMap<string, DeviceProviderShareRow>;
  emptyState: OrganizationShareEmptyState;
  /** Den answered: the person may share (even if nothing here is shareable). */
  canShare: boolean;
  /** Den has answered, so `firstShareable` and `canShare` are final for now. */
  resolved: boolean;
  /** The first row one confirmation can share, for entry points outside the row. */
  firstShareable: { id: string; name: string } | null;
  /** Opens the confirmation for a provider on this device. */
  open: (provider: { id: string; name: string }) => void;
  /** The confirmation dialog; render it once on the page. */
  dialog: ReactNode;
};

/**
 * Settings › AI Providers: share a key saved on this device with the
 * organization. Owns the confirmation and
 * what follows it, so the page only places the row action and the dialog.
 */
export function useDeviceProviderShareFlow(input: {
  providers: readonly ShareableDeviceProvider[];
  runtimeWorkspaceId: string | null | undefined;
  organizationName: string;
  /** Sends the share through this computer's server; rejects with the server's error. */
  share: (providerId: string, verifiedToken?: string) => Promise<{ inferenceProviderId: string; name: string }>;
  /**
   * The guided ending (`providerFilterSyncFix`): the confirmation stays open
   * until this device knows whether the shared provider is listed under the
   * organization, then asks which copy this device keeps.
   */
  guided?: {
    /** Refreshes this device and answers whether what Den created is listed here. Safe to call again. */
    confirmArrival: (providerId: string, shared: { inferenceProviderId: string; name: string }) => Promise<SharedProviderArrival>;
    /** Removes the person's own key from this device, moving their default model to the organization's copy first; rejects with a sentence to show. */
    removeDeviceKey: (providerId: string, organizationProviderId: string) => Promise<void>;
    /** Brings the organization's providers into view once the dialog closes. */
    showOrganizationProviders: () => void;
  };
}): DeviceProviderShareFlow {
  const healthEntries = useProviderCredentialHealth((state) => state.entries);
  const workspaceId = input.runtimeWorkspaceId ?? null;
  const health = useCallback((providerId: string): ProviderCredentialHealth =>
    (workspaceId ? healthEntries[credentialHealthKey(workspaceId, providerId)]?.status : undefined) ?? "unverified", [healthEntries, workspaceId]);
  // The page rebuilds its provider list on every render; key the question on what is in it.
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
  // What Den created for each provider shared from this dialog, so "Check again" asks about the same one.
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
        // Guided, the dialog itself reports the result; a toast would repeat it.
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
