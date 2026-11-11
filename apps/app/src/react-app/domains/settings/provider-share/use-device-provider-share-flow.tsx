import { useCallback, useMemo, useState, type ReactNode } from "react";
import { toast } from "@/components/ui/sonner";
import { readDenSettings } from "@/app/lib/den";
import { useDenAuth } from "../../cloud/den-auth-provider";
import { credentialHealthKey, useProviderCredentialHealth, type ProviderCredentialHealth } from "../../connections/provider-auth/credential-health";
import type { DeviceProviderShareRow, OrganizationShareEmptyState, ShareableDeviceProvider } from "./device-provider-share";
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
 * organization (Den feature `shareDeviceProvider`). Owns the confirmation and
 * what follows it, so the page only places the row action and the dialog.
 */
export function useDeviceProviderShareFlow(input: {
  providers: readonly ShareableDeviceProvider[];
  runtimeWorkspaceId: string | null | undefined;
  organizationName: string;
  /** Sends the share through this computer's server; rejects with the server's error. */
  share: (providerId: string, verifiedToken?: string) => Promise<unknown>;
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

  const dialog = share.enabled ? (
    <ShareProviderDialog
      key={scope}
      provider={target}
      organizationName={organizationName}
      verificationRequired={share.options?.verificationRequired === true}
      onShare={input.share}
      onShared={(provider) => {
        toast.success(`Shared ${provider.name} with ${organizationName}`);
        void share.refresh();
      }}
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
