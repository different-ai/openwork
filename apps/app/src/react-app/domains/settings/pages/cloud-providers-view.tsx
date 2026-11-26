/** @jsxImportSource react */
import * as React from "react";

import type { CloudImportedProvider } from "@/app/cloud/import-state";
import type { DesktopAppRestrictionChecker } from "@/app/cloud/desktop-app-restrictions";
import type { DenOrgLlmProvider, DenOrgLlmProviderAccess } from "@/app/lib/den";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { t } from "@/i18n";
import { GatewayConnectRow } from "./ai-view";
import { ProviderIcon } from "../../../design-system/provider-icon";
import { cleanProviderSlug, formatGatewayModelPreview } from "./provider-rows";
import { useCloudSession } from "@/react-app/domains/settings/cloud/cloud-session-provider";
import {
  CloudProvidersSection,
  type CloudProviderRow,
  type CloudProviderRowStatus,
  type OpenWorkModelsToggle,
} from "@/react-app/domains/settings/cloud/sections";
import {
  getCloudProviderEnv,
  getCloudManagedProviderId,
  gatewayConnectProviderKey,
  GATEWAY_MEMBER_AUTH_REQUIRED_REASON,
  isCloudProviderOutOfSync,
  type GatewayConnectProvider,
  type LiveGatewayProvider,
} from "@/react-app/domains/connections/provider-auth/cloud-provider-config";
import { isProviderAllowedByDesktopPolicy } from "@/react-app/domains/connections/provider-auth/provider-policy";
import type {
  CloudProviderServerSyncState,
  CloudProviderSyncError,
} from "@/react-app/domains/connections/provider-auth/store";
import { SettingsStack } from "@/react-app/domains/settings/settings-section";
import { credentialHealthKey, useProviderCredentialHealth, type ProviderCredentialHealth } from "@/react-app/domains/connections/provider-auth/credential-health";
import type { OrganizationShareEmptyState } from "@/react-app/domains/settings/provider-share/device-provider-share";

export function providerAccessLabel(access: DenOrgLlmProviderAccess | undefined): string | null {
  if (!access) return null;
  if (access.allMembers) return "Everyone";
  if (access.teamNames.length) return access.teamNames.join(", ");
  if (access.memberCount) return access.memberCount === 1 ? "1 member" : `${access.memberCount} members`;
  return null;
}

export type CloudProviderRowStateInput = {
  imported: boolean;
  credentialHealth?: ProviderCredentialHealth;
  outOfSync: boolean;
  allowed: boolean;
  importsUnavailable: boolean;
  needsCredential: boolean;
  needsServer: boolean;
  syncError: CloudProviderSyncError | null;
  skippedByServer?: boolean;
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
  if (!input.imported || input.outOfSync || input.reloadPending === true) return "syncing";
  if (input.credentialHealth === "rejected") return "credential_rejected";
  if (input.credentialHealth === "unverified") return "credential_unverified";
  return "connected";
}

export function canRetryCloudProviderRow(status: CloudProviderRowStatus) {
  return status === "error";
}

export type CloudProvidersViewProps = {
  runtimeWorkspaceId?: string | null;
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
  serverSync: CloudProviderServerSyncState | null;
  liveGatewayProviders?: readonly LiveGatewayProvider[] | null;
  liveGatewaySyncedAt?: number | null;
  gatewayConnectProviders?: GatewayConnectProvider[];
  connectingGatewayProviderId?: string | null;
  onConnectGatewayProvider?: (provider: GatewayConnectProvider) => void | Promise<void>;
  onCancelGatewayConnect?: () => void;
  onOpenDen?: () => void;
  onOpenModelConnections?: () => void;
  shareEmptyState?: OrganizationShareEmptyState;
  openWorkModelsToggle?: OpenWorkModelsToggle;
};

export function CloudProvidersView({
  runtimeWorkspaceId,
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
  liveGatewayProviders = null,
  liveGatewaySyncedAt,
  gatewayConnectProviders = [],
  connectingGatewayProviderId,
  onConnectGatewayProvider,
  onCancelGatewayConnect,
  onOpenDen,
  onOpenModelConnections,
  shareEmptyState,
  openWorkModelsToggle,
}: CloudProvidersViewProps) {
  const { activeOrganization, isSignedIn } = useCloudSession();
  const [busy, setBusy] = React.useState(false);
  const [actionId, setActionId] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);

  const healthEntries = useProviderCredentialHealth((state) => state.entries);
  const { rows, waitingRows } = React.useMemo(() => {
    const providerHealth = (providerId: string): ProviderCredentialHealth =>
      (runtimeWorkspaceId ? healthEntries[credentialHealthKey(runtimeWorkspaceId, providerId)]?.status : undefined) ?? "unverified";
    const restrictToCloud = checkDesktopAppRestriction({ restriction: "allowCustomProviders" });
    const liveRows = cloudOrgProviders.map((provider) => {
      const imported = importedCloudProviders[provider.id] ?? null;
      const outOfSync = imported ? isCloudProviderOutOfSync(provider, imported) : false;
      const allowed = isProviderAllowedByDesktopPolicy({
        providerId: getCloudManagedProviderId(provider),
        restrictToCloud,
        checkRestriction: checkDesktopAppRestriction,
      });
      const syncError = serverSync === null ? lastSyncError[provider.id] ?? null : null;
      const env = getCloudProviderEnv(provider.providerConfig);
      const status = resolveCloudProviderRowStatus({
        imported: Boolean(imported),
        credentialHealth: providerHealth(imported?.providerId ?? getCloudManagedProviderId(provider)),
        outOfSync,
        allowed,
        importsUnavailable,
        needsCredential: serverSync === null && !provider.hasApiKey && env.length > 0,
        needsServer: serverSync === null && provider.hasApiKey && env.length > 1 && !openworkServerAvailable,
        syncError,
        skippedByServer: Boolean(serverSync?.skippedProviders[provider.id]),
        reloadPending: serverSync?.reloadPending === true,
      });
      const providerDetail = provider.source === "openwork"
        ? `Organization credential · ${provider.models.length ? `${provider.models.length} models` : "All models"}`
        : `${imported?.source === "openwork_gateway" ? "AI Gateway" : "Organization credential"} · ${provider.credentialMode === "per_member" ? "Each member signs in" : "Shared org key"}`;
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
        metaId: provider.source === "openwork" ? "openwork" : cleanProviderSlug(provider.providerId),
        access: providerAccessLabel(provider.access),
        credentialReady: provider.source === "openwork" || provider.hasApiKey || provider.hasMyCredential === true || Boolean(imported),
      };
    });
    const liveGatewayById = new Map(liveGatewayProviders?.map((provider) => [provider.id, provider]));
    const orgProviderIds = new Set(liveRows.map((row) => row.cloudProviderId));
    const importedRows = Object.values(importedCloudProviders)
      .filter((provider) => !orgProviderIds.has(provider.cloudProviderId))
      .map<CloudProviderRow>((provider) => {
        const isGateway = provider.source === "openwork_gateway";
        const deliveredLive = isGateway && liveGatewayProviders !== null;
        const live = isGateway ? liveGatewayById.get(provider.cloudProviderId) : undefined;
        const health = providerHealth(provider.providerId);
        const status = resolveCloudProviderRowStatus({
          imported: true,
          credentialHealth: isGateway && health !== "rejected" && provider.modelIds.length > 0 ? "verified" : health,
          outOfSync: false,
          allowed: isProviderAllowedByDesktopPolicy({ providerId: provider.providerId, restrictToCloud, checkRestriction: checkDesktopAppRestriction }),
          importsUnavailable: !deliveredLive && importsUnavailable,
          needsCredential: false,
          needsServer: false,
          syncError: null,
          reloadPending: !deliveredLive && serverSync?.reloadPending === true,
          skippedByServer: !deliveredLive && Boolean(serverSync?.skippedProviders[provider.cloudProviderId]),
        });
        const sourceProviderId = live?.providerId ?? provider.sourceProviderId;
        const modelNames = live ? live.models.map((model) => model.name) : provider.modelIds;
        const modelCount = isGateway
          ? new Set(live ? live.models.map((model) => model.name.trim() || model.id) : provider.modelIds).size
          : 0;
        return {
          key: `imported:${provider.cloudProviderId}`,
          cloudProviderId: provider.cloudProviderId,
          provider: null,
          imported: provider,
          sourceProviderId,
          name: provider.name,
          status,
          detail: status === "blocked" ? t("den.cloud_provider_blocked") : isGateway
            ? `AI Gateway · ${formatGatewayModelPreview(modelNames) ?? "Organization credential"}`
            : "Managed in Den",
          metaId: cleanProviderSlug(sourceProviderId),
          modelCountLabel: modelCount > 0 ? (modelCount === 1 ? "1 model" : `${modelCount} models`) : null,
          credentialReady: !isGateway || provider.modelIds.length > 0,
        };
      });
    const pendingIds = new Set(gatewayConnectProviders.map((provider) => provider.cloudProviderId));
    const listedIds = new Set([...orgProviderIds, ...importedRows.map((row) => row.cloudProviderId), ...pendingIds]);
    const unconfigured = liveGatewayProviders !== null
      ? liveGatewayProviders
        .filter((provider) => !provider.models.length && !provider.authorizationRequests.length && provider.credentialStatus !== GATEWAY_MEMBER_AUTH_REQUIRED_REASON)
        .map((provider) => ({ cloudProviderId: provider.id, providerId: provider.id, sourceProviderId: provider.providerId, name: provider.name }))
      : Object.values(serverSync?.skippedProviders ?? {})
        .filter((provider) => /^ipr_/i.test(provider.cloudProviderId) && provider.reason !== GATEWAY_MEMBER_AUTH_REQUIRED_REASON);
    const waitingRows: CloudProviderRow[] = [];
    for (const provider of unconfigured) {
      if (listedIds.has(provider.cloudProviderId)) continue;
      listedIds.add(provider.cloudProviderId);
      const allowed = isProviderAllowedByDesktopPolicy({ providerId: provider.providerId, restrictToCloud, checkRestriction: checkDesktopAppRestriction });
      waitingRows.push({
        key: `waiting:${provider.cloudProviderId}`,
        cloudProviderId: provider.cloudProviderId,
        provider: null,
        imported: null,
        name: provider.name,
        status: allowed ? "needs_credential" : "blocked",
        sourceProviderId: provider.sourceProviderId,
        metaId: cleanProviderSlug(provider.sourceProviderId),
        detail: allowed ? "AI Gateway · Waiting on admin setup" : t("den.cloud_provider_blocked"),
        credentialReady: false,
      });
    }
    const rows = [...liveRows, ...importedRows]
      .filter((row) => row.credentialReady || !pendingIds.has(row.cloudProviderId))
      .map<CloudProviderRow>((row) => {
        if (row.status === "blocked" || (liveGatewayProviders !== null && row.imported?.source === "openwork_gateway")) return row;
        return serverSync?.lastRun?.status === "failed"
          ? { ...row, status: "unavailable", detail: "Could not verify with Den. Sync again to check access." }
          : row;
      });
    return { rows, waitingRows };
  }, [
    runtimeWorkspaceId,
    healthEntries,
    checkDesktopAppRestriction,
    cloudOrgProviders,
    gatewayConnectProviders,
    importedCloudProviders,
    importsUnavailable,
    lastSyncError,
    liveGatewayProviders,
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
      await Promise.all([refreshCloudOrgProviders({ force: true }), runCloudProviderSync("manual")]);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t("den.sync_provider_failed", { name: "Cloud providers" }));
    } finally {
      setBusy(false);
    }
  }, [busy, refreshCloudOrgProviders, runCloudProviderSync]);

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
      <section className="flex flex-col gap-3" aria-labelledby="ai-providers-organization">
        <div className="space-y-1">
          <h2 id="ai-providers-organization" className="text-base font-medium text-dls-text">From your organization</h2>
          <p className="text-sm text-muted-foreground">Providers your team pays for, delivered through the OpenWork Gateway. Nothing to set up on this device.</p>
        </div>
        <div className="flex flex-col gap-4 rounded-2xl border border-dashed border-dls-border px-5 py-5 sm:flex-row sm:items-center">
          <div className="flex shrink-0 items-center -space-x-2" aria-hidden>
            {["openai", "openrouter", "google"].map((id) => <span key={id} className="flex size-8 items-center justify-center rounded-full border border-dls-border bg-dls-surface"><ProviderIcon providerId={id} size={16} /></span>)}
            <span className="flex size-8 items-center justify-center rounded-full border border-dls-border bg-dls-hover text-[11px] font-medium text-muted-foreground">+2</span>
          </div>
          <div className="min-w-0 flex-1 space-y-0.5">
            <h3 className="text-sm font-medium text-dls-text">No organization yet</h3>
            <p className="text-sm text-muted-foreground">Sign in to see what your organization already provides. Your keys on this device keep working either way.</p>
          </div>
          <Button variant="outline" className="shrink-0 self-start sm:self-center" onClick={onOpenAccount}>Sign in to OpenWork</Button>
        </div>
      </section>
    );
    return embedded ? notice : (
      <SettingsStack>
        <Separator />
        {notice}
      </SettingsStack>
    );
  }

  const hasLegacyServerFailure = serverSync?.lastRun?.status === "failed"
    && (liveGatewayProviders === null || rows.some((row) => row.status !== "blocked" && row.imported?.source !== "openwork_gateway"));
  const section = (
    <CloudProvidersSection
      actionError={actionError ?? (hasLegacyServerFailure ? "Could not verify providers with Den. Sync again to retry." : null)}
      actionId={actionId}
      busy={busy}
      rows={rows}
      waitingRows={waitingRows}
      onRefresh={syncNow}
      onRetry={retryProvider}
      onOpenDen={onOpenDen}
      onOpenModelConnections={onOpenModelConnections}
      shareEmptyState={shareEmptyState}
      lastVerifiedAt={liveGatewaySyncedAt ?? serverSync?.lastVerifiedAt}
      openWorkModelsToggle={openWorkModelsToggle}
      additionalProviderIds={gatewayConnectProviders.map((provider) => provider.cloudProviderId)}
      additionalRows={gatewayConnectProviders.map((provider) => (
        <GatewayConnectRow
          key={gatewayConnectProviderKey(provider)}
          provider={provider}
          busy={connectingGatewayProviderId === gatewayConnectProviderKey(provider)}
          onConnect={onConnectGatewayProvider}
          onCancel={onCancelGatewayConnect}
        />
      ))}
    />
  );

  return embedded ? section : (
    <SettingsStack>
      <Separator />
      {section}
    </SettingsStack>
  );
}
