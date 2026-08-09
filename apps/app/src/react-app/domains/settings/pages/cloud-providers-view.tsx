/** @jsxImportSource react */
import * as React from "react";

import type { CloudImportedProvider } from "@/app/cloud/import-state";
import type { DesktopAppRestrictionChecker } from "@/app/cloud/desktop-app-restrictions";
import type { DenOrgLlmProvider } from "@/app/lib/den";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { t } from "@/i18n";
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
import type { CloudProviderSyncError } from "@/react-app/domains/connections/provider-auth/store";
import { SettingsNotice, SettingsStack } from "@/react-app/domains/settings/settings-section";

export type CloudProviderRowStateInput = {
  imported: boolean;
  outOfSync: boolean;
  allowed: boolean;
  importsUnavailable: boolean;
  needsCredential: boolean;
  needsServer: boolean;
  syncError: CloudProviderSyncError | null;
};

export function resolveCloudProviderRowStatus(
  input: CloudProviderRowStateInput,
): CloudProviderRowStatus {
  if (input.importsUnavailable) return "unavailable";
  if (!input.allowed) return "blocked";
  if (input.syncError) return input.syncError.kind;
  if (input.needsCredential) return "needs_credential";
  if (input.needsServer) return "needs_server";
  return input.imported && !input.outOfSync ? "connected" : "syncing";
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
}: CloudProvidersViewProps) {
  const { activeOrganization, isSignedIn } = useCloudSession();
  const [busy, setBusy] = React.useState(false);
  const [actionId, setActionId] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);

  const rows = React.useMemo<CloudProviderRow[]>(() => {
    const restrictToCloud = checkDesktopAppRestriction({ restriction: "allowCustomProviders" });
    return cloudOrgProviders.map((provider) => {
      const imported = importedCloudProviders[provider.id] ?? null;
      const outOfSync = imported ? isCloudProviderOutOfSync(provider, imported) : false;
      const allowed = isProviderAllowedByDesktopPolicy({
        providerId: getCloudManagedProviderId(provider),
        restrictToCloud,
        checkRestriction: checkDesktopAppRestriction,
      });
      const syncError = lastSyncError[provider.id] ?? null;
      const env = getCloudProviderEnv(provider.providerConfig);
      const status = resolveCloudProviderRowStatus({
        imported: Boolean(imported),
        outOfSync,
        allowed,
        importsUnavailable,
        needsCredential: !provider.hasApiKey && env.length > 0,
        needsServer: provider.hasApiKey && env.length > 1 && !openworkServerAvailable,
        syncError,
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
  }, [
    checkDesktopAppRestriction,
    cloudOrgProviders,
    importedCloudProviders,
    importsUnavailable,
    lastSyncError,
    openworkServerAvailable,
  ]);

  React.useEffect(() => {
    if (!isSignedIn || !activeOrganization?.id) return;
    void refreshCloudOrgProviders();
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
          <span>{t("skills.share_team_sign_in_hint")}</span>
          <Button size="sm" onClick={onOpenAccount}>
            {t("skills.share_team_sign_in")}
          </Button>
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
      actionError={actionError}
      actionId={actionId}
      busy={busy}
      rows={rows}
      onRefresh={syncNow}
      onRetry={retryProvider}
    />
  );

  return embedded ? section : (
    <SettingsStack>
      <Separator />
      {section}
    </SettingsStack>
  );
}
