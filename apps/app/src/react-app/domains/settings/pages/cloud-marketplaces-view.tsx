/** @jsxImportSource react */
import * as React from "react";

import type { CloudImportedPlugin } from "../../../../app/cloud/import-state";
import type { DenOrgMarketplaceResolved, DenOrgPlugin } from "../../../../app/lib/den";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { t } from "@/i18n";
import { useStatusToasts } from "../../shell-feedback/status-toasts";
import { useCloudSession } from "../cloud/cloud-session-provider";
import { MarketplacePluginsSection, type CloudPluginRow } from "../cloud/sections";
import type { useDenSession } from "../cloud/use-den-session";
import { SettingsNotice, SettingsStack } from "../settings-section";

type AsyncResult = { ok: boolean; message: string };
type CloudMarketplacesSession = Pick<
  ReturnType<typeof useDenSession>,
  "syncCurrentDenSettings"
>;

type DenSettingsExtensionsStore = {
  cloudOrgMarketplaces: () => DenOrgMarketplaceResolved[];
  cloudOrgMarketplacesStatus: () => string | null;
  importedCloudPlugins: () => Record<string, CloudImportedPlugin>;
  refreshCloudOrgMarketplaces: (options?: { force?: boolean }) => Promise<unknown>;
  importCloudOrgPlugin: (marketplaceId: string | null, plugin: DenOrgPlugin) => Promise<AsyncResult>;
};

export type CloudMarketplacesViewProps = {
  extensions: DenSettingsExtensionsStore;
  onOpenAccount: () => void;
  session: CloudMarketplacesSession;
};

export function CloudMarketplacesView({
  extensions,
  onOpenAccount,
  session,
}: CloudMarketplacesViewProps) {
  const { activeOrganization: activeOrg, authToken, isSignedIn, user } = useCloudSession();
  const { showToast } = useStatusToasts();
  const [busy, setBusy] = React.useState(false);
  const [activeMarketplaceId, setActiveMarketplaceId] = React.useState<string | null>(null);
  const [actionId, setActionId] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const activeOrgId = activeOrg?.id ?? "";

  const marketplaces = extensions.cloudOrgMarketplaces();
  const importedPlugins = extensions.importedCloudPlugins();
  const rowsByMarketplace = React.useMemo<Record<string, CloudPluginRow[]>>(() => {
    const next: Record<string, CloudPluginRow[]> = {};
    for (const marketplace of marketplaces) {
      next[marketplace.marketplace.id] = marketplace.plugins.map((plugin) => {
        const imported = importedPlugins[plugin.id] ?? null;
        const status = !imported
          ? "available"
          : imported.updatedAt !== plugin.updatedAt || imported.files.length !== plugin.memberCount
            ? "out_of_sync"
            : "imported";
        return { marketplaceId: marketplace.marketplace.id, plugin, imported, status };
      });
    }
    return next;
  }, [importedPlugins, marketplaces]);

  const refresh = React.useCallback(
    async (quiet = false) => {
      if (!authToken.trim() || !activeOrgId) return;

      setBusy(true);
      if (!quiet) setActionError(null);

      try {
        session.syncCurrentDenSettings();
        await extensions.refreshCloudOrgMarketplaces({ force: true });
        if (!quiet) {
          const count = extensions.cloudOrgMarketplaces().length;
          showToast({
            title: count > 0
              ? `Loaded ${count} marketplace${count === 1 ? "" : "s"} for ${activeOrg?.name ?? t("den.active_org_title")}.`
              : `No marketplaces are available for ${activeOrg?.name ?? t("den.active_org_title")}.`,
            tone: "info",
          });
        }
      } catch (error) {
        if (!quiet) {
          setActionError(error instanceof Error ? error.message : "Failed to load marketplaces.");
        }
      } finally {
        setBusy(false);
      }
    },
    [
      extensions,
      activeOrg,
      activeOrgId,
      authToken,
      session.syncCurrentDenSettings,
      showToast,
    ],
  );

  React.useEffect(() => {
    if (!user || !activeOrgId) return;
    void refresh(true);
  }, [activeOrgId, refresh, user]);

  const importPlugin = React.useCallback(
    async (marketplaceId: string | null, plugin: DenOrgPlugin) => {
      if (actionId) return;

      setActionId(plugin.id);
      setActionError(null);

      try {
        const result = await extensions.importCloudOrgPlugin(marketplaceId, plugin);
        if (!result.ok) throw new Error(result.message);
        showToast({ title: `${result.message} ${t("den.reload_workspace")}`, tone: "success" });
      } catch (error) {
        setActionError(error instanceof Error ? error.message : `Failed to import ${plugin.name}.`);
      } finally {
        setActionId(null);
      }
    },
    [actionId, extensions, showToast],
  );

  if (!isSignedIn) {
    return (
      <SettingsStack>
        <Separator />
        <SettingsNotice>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>{t("skills.share_team_sign_in_hint")}</span>
            <Button size="sm" onClick={onOpenAccount}>
              {t("skills.share_team_sign_in")}
            </Button>
          </div>
        </SettingsNotice>
      </SettingsStack>
    );
  }

  return (
    <SettingsStack>
      <Separator />
      <MarketplacePluginsSection
        actionError={actionError}
        actionId={actionId}
        activeMarketplaceId={activeMarketplaceId}
        busy={busy}
        marketplaces={marketplaces}
        rowsByMarketplace={rowsByMarketplace}
        statusError={extensions.cloudOrgMarketplacesStatus()}
        onImportPlugin={importPlugin}
        onRefresh={refresh}
        onSelectMarketplace={setActiveMarketplaceId}
      />
    </SettingsStack>
  );
}
