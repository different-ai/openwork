/** @jsxImportSource react */
import * as React from "react";
import { toast } from "@/components/ui/sonner";

import type { CloudImportedProvider } from "@/app/cloud/import-state";
import type { DenOrgLlmProvider } from "@/app/lib/den";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { t } from "@/i18n";
import { useCloudSession } from "@/react-app/domains/settings/cloud/cloud-session-provider";
import { CloudProvidersSection, type CloudProviderRow } from "@/react-app/domains/settings/cloud/sections";
import type { useDenSession } from "@/react-app/domains/settings/cloud/use-den-session";
import { SettingsNotice, SettingsStack } from "@/react-app/domains/settings/settings-section";

type CloudProvidersSession = Pick<
  ReturnType<typeof useDenSession>,
  "syncCurrentDenSettings"
>;
type ProviderActionKind = "import" | "remove" | "sync";

export type CloudProvidersViewProps = {
  cloudOrgProviders: DenOrgLlmProvider[];
  connectCloudProvider: (cloudProviderId: string) => Promise<string | void>;
  embedded?: boolean;
  importedCloudProviders: Record<string, CloudImportedProvider>;
  onOpenAccount: () => void;
  refreshCloudOrgProviders: (options?: { force?: boolean }) => Promise<DenOrgLlmProvider[]>;
  removeCloudProvider: (cloudProviderId: string) => Promise<string | void>;
  session: CloudProvidersSession;
};

const sortStrings = (values: string[]) => values.toSorted();

const sameStringList = (a: string[], b: string[]) =>
  a.length === b.length && a.every((value, index) => value === b[index]);

export function CloudProvidersView({
  cloudOrgProviders,
  connectCloudProvider,
  embedded = false,
  importedCloudProviders,
  onOpenAccount,
  refreshCloudOrgProviders,
  removeCloudProvider,
  session,
}: CloudProvidersViewProps) {
  const { activeOrganization: activeOrg, authToken, isSignedIn, user } = useCloudSession();
  const [busy, setBusy] = React.useState(false);
  const [actionId, setActionId] = React.useState<string | null>(null);
  const [actionKind, setActionKind] = React.useState<ProviderActionKind | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const activeOrgId = activeOrg?.id ?? "";

  const rows = React.useMemo<CloudProviderRow[]>(() => {
    const nextRows: CloudProviderRow[] = cloudOrgProviders.map((provider) => {
      const imported = importedCloudProviders[provider.id] ?? null;
      const status = !imported
        ? "available"
        : imported.providerId !== provider.id.trim() ||
            imported.sourceProviderId !== provider.providerId ||
            (imported.source ?? null) !== (provider.source ?? null) ||
            (imported.updatedAt ?? null) !== (provider.updatedAt ?? null) ||
            !sameStringList(imported.modelIds, sortStrings(provider.models.map((model) => model.id)))
          ? "out_of_sync"
          : "imported";
      return {
        key: `live:${provider.id}`,
        cloudProviderId: provider.id,
        provider,
        imported,
        status,
        name: provider.name,
      };
    });

    for (const imported of Object.values(importedCloudProviders)) {
      if (cloudOrgProviders.some((provider) => provider.id === imported.cloudProviderId)) continue;
      nextRows.push({
        key: `imported:${imported.cloudProviderId}`,
        cloudProviderId: imported.cloudProviderId,
        provider: null,
        imported,
        status: "removed_from_cloud",
        name: imported.name,
      });
    }

    return nextRows;
  }, [cloudOrgProviders, importedCloudProviders]);

  const refresh = React.useCallback(
    async (quiet = false) => {
      if (!authToken.trim() || !activeOrgId) return;

      setBusy(true);
      setActionError(null);

      try {
        session.syncCurrentDenSettings();
        const items = await refreshCloudOrgProviders({ force: !quiet });
        if (!quiet) {
          toast.info(
            items.length > 0
              ? `Loaded ${items.length} cloud provider${items.length === 1 ? "" : "s"} for ${activeOrg?.name ?? t("den.active_org_title")}.`
              : `No cloud providers are available for ${activeOrg?.name ?? t("den.active_org_title")}.`,
          );
        }
      } catch (error) {
        if (!quiet) {
          setActionError(error instanceof Error ? error.message : "Failed to load cloud providers.");
        }
      } finally {
        setBusy(false);
      }
    },
    [
      refreshCloudOrgProviders,
      activeOrg,
      activeOrgId,
      authToken,
      session.syncCurrentDenSettings,
    ],
  );

  React.useEffect(() => {
    if (!user || !activeOrgId) return;
    void refresh(true);
  }, [activeOrgId, refresh, user]);

  const importProvider = React.useCallback(
    async (cloudProviderId: string, providerName: string) => {
      if (actionId) return;

      setActionId(cloudProviderId);
      setActionKind("import");
      setActionError(null);

      try {
        const message = await connectCloudProvider(cloudProviderId);
        toast.success(message || t("den.imported_provider", { name: providerName }));
      } catch (error) {
        setActionError(
          error instanceof Error ? error.message : t("den.import_provider_failed", { name: providerName }),
        );
      } finally {
        setActionId(null);
        setActionKind(null);
      }
    },
    [actionId, connectCloudProvider],
  );

  const removeProvider = React.useCallback(
    async (cloudProviderId: string, providerName: string) => {
      if (actionId) return;

      setActionId(cloudProviderId);
      setActionKind("remove");
      setActionError(null);

      try {
        const message = await removeCloudProvider(cloudProviderId);
        toast.success(message || t("den.removed_provider", { name: providerName }));
      } catch (error) {
        setActionError(
          error instanceof Error ? error.message : t("den.remove_provider_failed", { name: providerName }),
        );
      } finally {
        setActionId(null);
        setActionKind(null);
      }
    },
    [actionId, removeCloudProvider],
  );

  const syncProvider = React.useCallback(
    async (cloudProviderId: string, providerName: string) => {
      if (actionId) return;

      setActionId(cloudProviderId);
      setActionKind("sync");
      setActionError(null);

      try {
        await connectCloudProvider(cloudProviderId);
        toast.success(t("den.synced_provider", { name: providerName }));
      } catch (error) {
        setActionError(
          error instanceof Error ? error.message : t("den.sync_provider_failed", { name: providerName }),
        );
      } finally {
        setActionId(null);
        setActionKind(null);
      }
    },
    [actionId, connectCloudProvider],
  );

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
      actionKind={actionKind}
      busy={busy}
      rows={rows}
      onImport={importProvider}
      onRefresh={refresh}
      onRemove={undefined}
      onSync={syncProvider}
    />
  );

  return embedded ? section : (
    <SettingsStack>
      <Separator />
      {section}
    </SettingsStack>
  );
}
