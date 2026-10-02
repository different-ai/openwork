/** @jsxImportSource react */
import * as React from "react";

import type { CloudImportedProvider } from "@/app/cloud/import-state";
import type { DesktopAppRestrictionChecker } from "@/app/cloud/desktop-app-restrictions";
import type { DenOrgLlmProvider } from "@/app/lib/den";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { t } from "@/i18n";
import { GatewayConnectRow } from "./ai-view";
import { gatewayConnectProviderKey, type GatewayConnectProvider } from "../../connections/provider-auth/cloud-provider-config";
import { useCloudSession } from "@/react-app/domains/settings/cloud/cloud-session-provider";
import {
  CloudProvidersSection,
  type CloudProviderRow,
  type CloudProviderRowStatus,
} from "@/react-app/domains/settings/cloud/sections";
import {
  getCloudProviderEnv,
  getCloudManagedProviderId,
  isCloudProviderOutOfSync,
} from "@/react-app/domains/connections/provider-auth/cloud-provider-config";
import { isProviderAllowedByDesktopPolicy } from "@/react-app/domains/connections/provider-auth/provider-policy";
import type {
  CloudProviderServerSyncState,
  CloudProviderSyncError,
} from "@/react-app/domains/connections/provider-auth/store";
import { SettingsNotice, SettingsStack } from "@/react-app/domains/settings/settings-section";

export type CloudProviderRowStateInput = {
  imported: boolean;
  outOfSync: boolean;
  allowed: boolean;
  importsUnavailable: boolean;
  needsCredential: boolean;
  needsServer: boolean;
  syncError: CloudProviderSyncError | null;
  /**
   * The server-side sync skipped this provider (from
   * /cloud-provider-sync/status skippedProviders, e.g. missing_credentials) —
   * an honest attention state instead of a silent, permanent "Syncing".
   */
  skippedByServer?: boolean;
  /**
   * The server still owes the engine a reload: the provider is materialized
   * on disk but its models are not served yet, so "Connected" would lie.
   */
  reloadPending?: boolean;
};

export function resolveCloudProviderRowStatus(
  input: CloudProviderRowStateInput,
): CloudProviderRowStatus {
  if (input.importsUnavailable) return "unavailable";
  if (!input.allowed) return "blocked";
  if (input.syncError) return input.syncError.kind;
  if (input.needsCredential || input.skippedByServer === true) return "needs_credential";
  if (input.needsServer) return "needs_server";
  return input.imported && !input.outOfSync && input.reloadPending !== true
    ? "connected"
    : "syncing";
}

export function canRetryCloudProviderRow(status: CloudProviderRowStatus) {
  return status === "error";
}

export type CloudProvidersViewProps = {
  checkDesktopAppRestriction: DesktopAppRestrictionChecker;
  cloudOrgProviders: DenOrgLlmProvider[];
  connectCloudProvider: (cloudProviderId: string) => Promise<string | void>;
  embedded?: boolean;
  importedCloudProviders: Record<string, CloudImportedProvider>;
  importsUnavailable: boolean;
  lastSyncError: Record<string, CloudProviderSyncError>;
  openworkServerAvailable: boolean;
  onOpenAccount: () => void;
  refreshCloudOrgProviders: (options?: { force?: boolean }) => Promise<DenOrgLlmProvider[]>;
  runCloudProviderSync: (reason: "manual") => Promise<unknown>;
  /** Server-side sync facts (reload pending, skips); null on the legacy renderer-import path. */
  serverSync: CloudProviderServerSyncState | null;
  gatewayConnectProviders?: GatewayConnectProvider[];
  connectingGatewayProviderId?: string | null;
  onConnectGatewayProvider?: (provider: GatewayConnectProvider) => void | Promise<void>;
  onOpenDen?: () => void;
};

export function CloudProvidersView({
  checkDesktopAppRestriction,
  cloudOrgProviders,
  connectCloudProvider,
  embedded = false,
  importedCloudProviders,
  importsUnavailable,
  lastSyncError,
  openworkServerAvailable,
  onOpenAccount,
  refreshCloudOrgProviders,
  runCloudProviderSync,
  serverSync,
  gatewayConnectProviders = [],
  connectingGatewayProviderId,
  onConnectGatewayProvider,
  onOpenDen,
}: CloudProvidersViewProps) {
  const { activeOrganization, isSignedIn } = useCloudSession();
  const [busy, setBusy] = React.useState(false);
  const [actionId, setActionId] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);

  const rows = React.useMemo<CloudProviderRow[]>(() => {
    const restrictToCloud = checkDesktopAppRestriction({ restriction: "allowCustomProviders" });
    const liveRows = cloudOrgProviders.map((provider) => {
      const imported = importedCloudProviders[provider.id] ?? null;
      const outOfSync = imported ? isCloudProviderOutOfSync(provider, imported) : false;
      const allowed = isProviderAllowedByDesktopPolicy({
        providerId: getCloudManagedProviderId(provider),
        restrictToCloud,
        checkRestriction: checkDesktopAppRestriction,
      });
      // Modern server sync owns credential resolution, including local
      // Environment variables. Den's shared-credential summary and errors
      // from the legacy renderer path are not authoritative in this mode.
      const syncError = serverSync === null ? lastSyncError[provider.id] ?? null : null;
      const env = getCloudProviderEnv(provider.providerConfig);
      const status = resolveCloudProviderRowStatus({
        imported: Boolean(imported),
        outOfSync,
        allowed,
        importsUnavailable,
        needsCredential: serverSync === null && !provider.hasApiKey && env.length > 0,
        needsServer: serverSync === null && provider.hasApiKey && env.length > 1 && !openworkServerAvailable,
        syncError,
        skippedByServer: Boolean(serverSync?.skippedProviders[provider.id]),
        reloadPending: serverSync?.reloadPending === true,
      });
      const source = provider.source === "custom" ? "custom" : "managed";
      const modelCount = provider.models.length;
      const providerDetail = modelCount === 0
        ? `All Models · ${source} provider`
        : t("den.cloud_provider_detail", { count: modelCount, source });
      const detail = status === "blocked"
        ? t("den.cloud_provider_blocked")
        : status === "unavailable"
          ? t("den.cloud_provider_imports_unavailable")
          : status === "needs_credential"
            ? syncError?.message ?? t("den.cloud_provider_needs_credential")
            : status === "needs_server"
              ? syncError?.message ?? t("den.cloud_provider_needs_server")
              : syncError?.message ?? providerDetail;

      return {
        key: `live:${provider.id}`,
        cloudProviderId: provider.id,
        provider,
        imported,
        status,
        name: provider.name,
        detail,
      };
    });
    const importedRows: CloudProviderRow[] = Object.values(importedCloudProviders).filter((provider) => !cloudOrgProviders.some((live) => live.id === provider.cloudProviderId)).map((provider) => ({
      key: `imported:${provider.cloudProviderId}`, cloudProviderId: provider.cloudProviderId, provider: null, imported: provider, name: provider.name,
      status: resolveCloudProviderRowStatus({ imported: true, outOfSync: false, allowed: isProviderAllowedByDesktopPolicy({ providerId: provider.providerId, restrictToCloud, checkRestriction: checkDesktopAppRestriction }), importsUnavailable, needsCredential: false, needsServer: false, syncError: null, reloadPending: serverSync?.reloadPending, skippedByServer: Boolean(serverSync?.skippedProviders[provider.cloudProviderId]) }),
      detail: provider.source === "openwork_gateway" ? "OpenWork Gateway · Organization credential" : "Managed in Den",
    }));
    const combined = [...liveRows, ...importedRows];
    return combined.filter((row) => !gatewayConnectProviders.some((provider) => provider.cloudProviderId === row.cloudProviderId)).map<CloudProviderRow>((row) => serverSync?.lastRun?.status === "failed" ? { ...row, status: "unavailable", detail: "Could not verify with Den. Sync again to check access." } : row);
  }, [
    checkDesktopAppRestriction,
    cloudOrgProviders,
    gatewayConnectProviders,
    importedCloudProviders,
    importsUnavailable,
    lastSyncError,
    openworkServerAvailable,
    serverSync,
  ]);

  React.useEffect(() => {
    if (!isSignedIn || !activeOrganization?.id) return;
    let current = true;
    setBusy(true);
    void refreshCloudOrgProviders().catch(() => {
      if (current) setActionError("Could not verify organization providers. Sync again to retry.");
    }).finally(() => { if (current) setBusy(false); });
    return () => { current = false; };
  }, [activeOrganization?.id, isSignedIn, refreshCloudOrgProviders]);

  const syncNow = React.useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await runCloudProviderSync("manual");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t("den.sync_provider_failed", { name: "Cloud providers" }));
    } finally {
      setBusy(false);
    }
  }, [busy, runCloudProviderSync]);

  const retryProvider = React.useCallback(async (cloudProviderId: string) => {
    if (actionId) return;
    setActionId(cloudProviderId);
    setActionError(null);
    try {
      await connectCloudProvider(cloudProviderId);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t("den.sync_provider_failed", { name: "Cloud provider" }));
    } finally {
      setActionId(null);
    }
  }, [actionId, connectCloudProvider]);

  if (!isSignedIn) {
    const notice = (
      <SettingsNotice>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div><h3 className="text-sm font-medium">From your organization</h3><span className="text-xs text-muted-foreground">No organization yet. Sign in to see what your organization already provides. Your keys on this device keep working either way.</span></div>
          <Button size="sm" onClick={onOpenAccount}>Sign in to OpenWork</Button>
        </div>
      </SettingsNotice>
    );
    return embedded ? notice : (
      <SettingsStack>
        <Separator />
        {notice}
      </SettingsStack>
    );
  }

  const section = (
    <CloudProvidersSection
      actionError={actionError ?? (serverSync?.lastRun?.status === "failed" ? "Could not verify providers with Den. Sync again to retry." : null)}
      actionId={actionId}
      busy={busy}
      rows={rows}
      onRefresh={syncNow}
      onRetry={retryProvider}
      onOpenDen={onOpenDen}
      lastVerifiedAt={serverSync?.lastVerifiedAt}
      additionalCount={gatewayConnectProviders.length}
      additionalRows={gatewayConnectProviders.map((provider) => <GatewayConnectRow key={gatewayConnectProviderKey(provider)} provider={provider} busy={connectingGatewayProviderId === gatewayConnectProviderKey(provider)} onConnect={onConnectGatewayProvider} />)}
    />
  );

  return embedded ? section : (
    <SettingsStack>
      <Separator />
      {section}
    </SettingsStack>
  );
}
