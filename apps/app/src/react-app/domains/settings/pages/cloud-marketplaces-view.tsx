/** @jsxImportSource react */
import * as React from "react";
import { toast } from "@/components/ui/sonner";

import type { McpDirectoryInfo } from "@/app/constants";
import type { CloudImportedPlugin } from "@/app/cloud/import-state";
import type { PendingCloudPluginChange } from "@/app/cloud/desktop-cloud-sync";
import { evaluateEnablement, type EnablementContext } from "@/app/enablement";
import type { DenOrgMarketplaceResolved, DenOrgPlugin, DenOrgPluginResolved } from "@/app/lib/den";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { t } from "@/i18n";
import { ExtensionCard } from "@/react-app/design-system/extension-card";
import { ExtensionDetailModal } from "@/react-app/design-system/extension-detail-modal";
import { isToggleControlledExtension, type ExtensionItem } from "@/react-app/domains/settings/extension-items";
import { useCloudSession } from "@/react-app/domains/settings/cloud/cloud-session-provider";
import type { useDenSession } from "@/react-app/domains/settings/cloud/use-den-session";
import {
  RefreshButton,
  SettingsNotice,
  SettingsPill,
  SettingsSection,
  SettingsSectionHeader,
  SettingsSectionHeaderActions,
  SettingsSectionHeaderContent,
  SettingsSectionHeaderDescription,
  SettingsSectionHeaderTitle,
  SettingsStack,
} from "@/react-app/domains/settings/settings-section";
import {
  SettingsListEmptyState,
  SettingsListSearchInput,
} from "@/react-app/domains/settings/settings-list";

type AsyncResult = { ok: boolean; message: string };
type MarketplacePackageStatus = "available" | "installed" | "update_available";
type MarketplaceStatusFilter = "all" | MarketplacePackageStatus;
type CloudMarketplacesSession = Pick<
  ReturnType<typeof useDenSession>,
  "syncCurrentDenSettings"
>;

type DenSettingsExtensionsStore = {
  cloudOrgMarketplaces: () => DenOrgMarketplaceResolved[];
  cloudOrgMarketplacesStatus: () => string | null;
  importedCloudPlugins: () => Record<string, CloudImportedPlugin>;
  pendingCloudPluginChanges: () => Record<string, PendingCloudPluginChange>;
  refreshCloudOrgMarketplaces: (options?: { force?: boolean }) => Promise<unknown>;
  importCloudOrgPlugin: (marketplaceId: string | null, plugin: DenOrgPlugin) => Promise<AsyncResult>;
  removeCloudOrgPlugin: (pluginId: string) => Promise<AsyncResult>;
};

type MarketplacePackageRow = {
  source: "cloud";
  marketplaceId: string;
  marketplaceName: string;
  plugin: DenOrgPlugin;
  imported: CloudImportedPlugin | null;
  status: MarketplacePackageStatus;
  counts: string[];
  composition: Array<{ count: number; label: string; type: string }>;
  searchableText: string;
};

type BuiltInMarketplaceRow = {
  source: "built-in";
  marketplaceId: "openwork-builtins";
  marketplaceName: string;
  entry: McpDirectoryInfo;
  status: MarketplacePackageStatus;
  active: boolean;
  searchableText: string;
};

type MarketplaceRow = MarketplacePackageRow | BuiltInMarketplaceRow;

export function shouldShowMarketplaceRows(isSignedIn: boolean, activeOrgId: string) {
  return isSignedIn && activeOrgId.trim().length > 0;
}

export type CloudMarketplacesViewProps = {
  extensions: DenSettingsExtensionsStore;
  embedded?: boolean;
  onOpenAccount: () => void;
  session: CloudMarketplacesSession;
  builtInEntries?: McpDirectoryInfo[];
  enablementContext?: EnablementContext;
  builtInExtensionsDisabled?: boolean;
  builtInConnectingName?: string | null;
  configSlotForBuiltIn?: (entry: McpDirectoryInfo) => React.ReactNode | null;
  isBuiltInConnected?: (entry: McpDirectoryInfo) => boolean;
  extensionItems?: ExtensionItem[];
  setBuiltInEnabled?: (entry: McpDirectoryInfo, enabled: boolean) => void;
};

function pluginCounts(plugin: DenOrgPlugin) {
  return pluginComposition(plugin).map((entry) => `${entry.count} ${entry.label}${entry.count === 1 ? "" : "s"}`);
}

function pluginComposition(plugin: DenOrgPlugin) {
  const componentEntries = Object.entries(plugin.componentCounts).flatMap(([type, count]) => {
    if (count <= 0) return [];
    const label = type === "mcp" ? "MCP" : type;
    return [{ count, label, type }];
  });
  if (componentEntries.length > 0) return componentEntries;

  const manifestResources = plugin.extension?.manifest?.resources ?? [];
  const counts = manifestResources.reduce((accumulator, resource) => {
    accumulator.set(resource.type, (accumulator.get(resource.type) ?? 0) + 1);
    return accumulator;
  }, new Map<string, number>());
  return [...counts.entries()].map(([type, count]) => ({
    count,
    label: type === "mcp" ? "MCP" : type,
    type,
  }));
}

function isCloudBuiltInPlugin(plugin: DenOrgPlugin) {
  return plugin.extension?.sourceFormat === "openwork-builtin";
}

function pluginManifestSearchText(plugin: DenOrgPlugin) {
  const manifest = plugin.extension?.manifest;
  if (!manifest) return "";
  return [
    manifest.name,
    manifest.description,
    manifest.setup?.instructions ?? "",
    ...(manifest.resources.map((resource) => `${resource.id} ${resource.label ?? ""} ${resource.description ?? ""}`)),
    ...(manifest.contributions?.map((contribution) => `${contribution.ref ?? ""} ${contribution.label ?? ""}`) ?? []),
  ].join(" ");
}

function pluginStatus(imported: CloudImportedPlugin | null, plugin: DenOrgPlugin): MarketplacePackageStatus {
  if (!imported) return "available";
  const importedObjectCount = new Set(imported.files.map((file) => file.configObjectId)).size;
  if (imported.updatedAt !== plugin.updatedAt || importedObjectCount !== plugin.memberCount) return "update_available";
  return "installed";
}

function statusLabel(status: MarketplacePackageStatus) {
  switch (status) {
    case "installed":
      return t("den.imported_badge");
    case "update_available":
      return t("den.out_of_sync_badge");
    default:
      return "Available";
  }
}

function statusClass(status: MarketplacePackageStatus) {
  switch (status) {
    case "installed":
      return "border-green-7/30 bg-green-3/20 text-green-11";
    case "update_available":
      return "border-amber-7/30 bg-amber-3/20 text-amber-11";
    default:
      return "border-gray-6/60 bg-gray-3/20 text-gray-11";
  }
}

export function CloudMarketplacesView({
  extensions,
  embedded = false,
  onOpenAccount,
  session,
  builtInEntries = [],
  enablementContext,
  builtInExtensionsDisabled = false,
  builtInConnectingName = null,
  configSlotForBuiltIn,
  isBuiltInConnected,
  extensionItems = [],
  setBuiltInEnabled,
}: CloudMarketplacesViewProps) {
  const { activeOrganization: activeOrg, authToken, client, isSignedIn, user } = useCloudSession();
  const [busy, setBusy] = React.useState(false);
  const [actionId, setActionId] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState<MarketplaceStatusFilter>("all");
  const [marketplaceFilter, setMarketplaceFilter] = React.useState("all");
  const [detailRow, setDetailRow] = React.useState<MarketplaceRow | null>(null);
  const [updateAllProgress, setUpdateAllProgress] = React.useState<{ current: number; total: number } | null>(null);
  const [resolvedPlugins, setResolvedPlugins] = React.useState<Record<string, DenOrgPluginResolved>>({});
  const [detailLoadingId, setDetailLoadingId] = React.useState<string | null>(null);
  const [detailError, setDetailError] = React.useState<string | null>(null);
  const activeOrgId = activeOrg?.id ?? "";
  const canShowRows = shouldShowMarketplaceRows(isSignedIn, activeOrgId);

  const marketplaces = extensions.cloudOrgMarketplaces();
  const importedPlugins = extensions.importedCloudPlugins();
  const pendingChanges = extensions.pendingCloudPluginChanges();
  const extensionItemsByBuiltInId = React.useMemo(() => new Map(
    extensionItems.flatMap((item) => item.builtInEntry ? [[item.builtInEntry.id ?? item.builtInEntry.serverName ?? item.builtInEntry.name, item] as const] : []),
  ), [extensionItems]);
  const extensionItemsByPluginId = React.useMemo(() => new Map(
    extensionItems.flatMap((item) => item.plugin ? [[item.plugin.id, item] as const] : []),
  ), [extensionItems]);
  const lastRowsRef = React.useRef<MarketplaceRow[]>([]);
  const cloudRows = React.useMemo<MarketplacePackageRow[]>(() => {
    return marketplaces.flatMap((marketplace) => marketplace.plugins.map((plugin) => {
      const imported = importedPlugins[plugin.id] ?? null;
      const composition = pluginComposition(plugin);
      const counts = pluginCounts(plugin);
      const item = extensionItemsByPluginId.get(plugin.id);
      const status: MarketplacePackageStatus = imported && pendingChanges[plugin.id] === "modified" && !isCloudBuiltInPlugin(plugin)
        ? "update_available"
        : item?.installState ?? (isCloudBuiltInPlugin(plugin) ? "installed" : pluginStatus(imported, plugin));
      return {
        source: "cloud",
        marketplaceId: marketplace.marketplace.id,
        marketplaceName: marketplace.marketplace.name,
        plugin,
        imported,
        status,
        counts,
        composition,
        searchableText: [
          plugin.name,
          plugin.description ?? "",
          marketplace.marketplace.name,
          pluginManifestSearchText(plugin),
          ...counts,
          ...(imported?.files.map((file) => `${file.title} ${file.objectType} ${file.path}`) ?? []),
        ].join(" ").toLowerCase(),
      };
    }));
  }, [extensionItemsByPluginId, importedPlugins, marketplaces, pendingChanges]);

  const builtInRows = React.useMemo<BuiltInMarketplaceRow[]>(() => {
    return builtInEntries.map((entry) => {
      const item = extensionItemsByBuiltInId.get(entry.id ?? entry.serverName ?? entry.name);
      const enablement = entry.extensionManifest?.enablement && enablementContext
        ? evaluateEnablement(entry.extensionManifest.enablement, enablementContext)
        : null;
      const active = item?.active ?? enablement?.active ?? isBuiltInConnected?.(entry) ?? false;
      return {
        source: "built-in",
        marketplaceId: "openwork-builtins",
        marketplaceName: "OpenWork Built-ins",
        entry,
        active,
        status: item?.installState ?? (active ? "installed" : "available"),
        searchableText: [
          entry.name,
          entry.description,
          entry.extensionManifest?.setup?.instructions ?? "",
          ...(entry.extensionManifest?.resources.map((resource) => `${resource.id} ${resource.label ?? ""}`) ?? []),
        ].join(" ").toLowerCase(),
      };
    });
  }, [builtInEntries, enablementContext, extensionItemsByBuiltInId, isBuiltInConnected]);

  const rows = React.useMemo<MarketplaceRow[]>(() => canShowRows ? [...builtInRows, ...cloudRows] : [], [builtInRows, canShowRows, cloudRows]);

  React.useEffect(() => {
    if (rows.length > 0) lastRowsRef.current = rows;
  }, [rows]);

  const displayRows = rows.length > 0 ? rows : busy ? lastRowsRef.current : rows;

  const marketplaceOptions = React.useMemo(
    () => canShowRows ? [
      ...(builtInRows.length > 0 ? [{ id: "openwork-builtins", name: "OpenWork Built-ins" }] : []),
      ...marketplaces.map((marketplace) => ({ id: marketplace.marketplace.id, name: marketplace.marketplace.name })),
    ] : [],
    [builtInRows.length, canShowRows, marketplaces],
  );

  const visibleRows = React.useMemo(() => {
    const query = search.trim().toLowerCase();
    return displayRows.filter((row) => {
      if (marketplaceFilter !== "all" && row.marketplaceId !== marketplaceFilter) return false;
      if (statusFilter !== "all" && row.status !== statusFilter) return false;
      if (!query) return true;
      return row.searchableText.includes(query);
    });
  }, [displayRows, marketplaceFilter, search, statusFilter]);

  const refresh = React.useCallback(
    async (quiet = false) => {
      if (!authToken.trim() || !activeOrgId) return;

      setBusy(true);
      if (!quiet) setActionError(null);

      try {
        session.syncCurrentDenSettings();
        await extensions.refreshCloudOrgMarketplaces({ force: true });
        if (!quiet) {
          const count = extensions.cloudOrgMarketplaces().reduce((total, marketplace) => total + marketplace.plugins.length, 0);
          toast.info(
            count > 0
              ? `Loaded ${count} marketplace extension${count === 1 ? "" : "s"} for ${activeOrg?.name ?? t("den.active_org_title")}.`
              : `No marketplace extensions are available for ${activeOrg?.name ?? t("den.active_org_title")}.`,
          );
        }
      } catch (error) {
        if (!quiet) {
          setActionError(error instanceof Error ? error.message : "Failed to load marketplace extensions.");
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
    ],
  );

  React.useEffect(() => {
    if (!user || !activeOrgId) return;
    void refresh(true);
  }, [activeOrgId, refresh, user]);

  React.useEffect(() => {
    if (!detailRow || detailRow.source !== "cloud" || !isSignedIn || !activeOrgId) return;
    if (resolvedPlugins[detailRow.plugin.id]) return;

    let cancelled = false;
    setDetailLoadingId(detailRow.plugin.id);
    setDetailError(null);
    void client.getOrgPluginResolved(activeOrgId, detailRow.plugin)
      .then((resolved) => {
        if (cancelled) return;
        setResolvedPlugins((current) => ({ ...current, [detailRow.plugin.id]: resolved }));
      })
      .catch((error) => {
        if (cancelled) return;
        setDetailError(error instanceof Error ? error.message : "Failed to load extension composition.");
      })
      .finally(() => {
        if (!cancelled) setDetailLoadingId(null);
      });
    return () => {
      cancelled = true;
    };
  }, [activeOrgId, client, detailRow, isSignedIn, resolvedPlugins]);

  const importPlugin = React.useCallback(
    async (marketplaceId: string | null, plugin: DenOrgPlugin) => {
      if (actionId) return;

      setActionId(plugin.id);
      setActionError(null);

      try {
        const result = await extensions.importCloudOrgPlugin(marketplaceId, plugin);
        if (!result.ok) throw new Error(result.message);
        toast.success(result.message);
        setDetailRow(null);
      } catch (error) {
        setActionError(error instanceof Error ? error.message : `Failed to add ${plugin.name}.`);
      } finally {
        setActionId(null);
      }
    },
    [actionId, extensions],
  );

  const removePlugin = React.useCallback(
    async (pluginId: string, pluginName: string) => {
      if (actionId) return;

      setActionId(pluginId);
      setActionError(null);

      try {
        const result = await extensions.removeCloudOrgPlugin(pluginId);
        if (!result.ok) throw new Error(result.message);
        toast.success(result.message);
        setDetailRow(null);
      } catch (error) {
        setActionError(error instanceof Error ? error.message : `Failed to remove ${pluginName}.`);
      } finally {
        setActionId(null);
      }
    },
    [actionId, extensions],
  );

  const updatableRows = React.useMemo(
    () => cloudRows.filter((row) => row.status === "update_available" && !isCloudBuiltInPlugin(row.plugin)),
    [cloudRows],
  );

  const removedUpstreamPlugins = React.useMemo(
    () => Object.values(importedPlugins).filter((plugin) => pendingChanges[plugin.pluginId] === "removed"),
    [importedPlugins, pendingChanges],
  );

  const updateAll = React.useCallback(async () => {
    if (actionId || updateAllProgress) return;

    setActionError(null);
    const targets = [...updatableRows];
    let failed = 0;
    // Sequential on purpose: avoid hammering the install routes.
    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index];
      setUpdateAllProgress({ current: index + 1, total: targets.length });
      const result = await extensions.importCloudOrgPlugin(target.marketplaceId, target.plugin);
      if (!result.ok) failed += 1;
    }
    setUpdateAllProgress(null);
    if (failed > 0) {
      setActionError(`Failed to update ${failed} extension${failed === 1 ? "" : "s"}.`);
    } else if (targets.length > 0) {
      toast.success(`Updated ${targets.length} extension${targets.length === 1 ? "" : "s"}.`);
    }
  }, [actionId, extensions, updatableRows, updateAllProgress]);

  const content = (
    <SettingsSection>
      <SettingsSectionHeader>
        <SettingsSectionHeaderContent>
          <SettingsSectionHeaderTitle>Extension Marketplace</SettingsSectionHeaderTitle>
          <SettingsSectionHeaderDescription>
            Browse built-in OpenWork extensions and organization marketplace extensions. Claude-compatible plugins are normalized into OpenWork extensions with installable resources such as skills, MCPs, commands, or tools.
          </SettingsSectionHeaderDescription>
        </SettingsSectionHeaderContent>
        <SettingsSectionHeaderActions>
          {updatableRows.length >= 2 ? (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy || Boolean(actionId) || Boolean(updateAllProgress)}
              onClick={() => void updateAll()}
            >
              {updateAllProgress
                ? t("extensions.update_all_progress", { current: updateAllProgress.current, total: updateAllProgress.total })
                : t("extensions.update_all_button")}
            </Button>
          ) : null}
          <RefreshButton
            busy={busy}
            disabled={busy || !canShowRows}
            onRefresh={refresh}
          >
            {t("den.refresh")}
          </RefreshButton>
        </SettingsSectionHeaderActions>
      </SettingsSectionHeader>

      {!isSignedIn ? (
        <SettingsNotice>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>You can use OpenWork without an account. Sign in to OpenWork Cloud to load the Marketplace, including OpenWork's built-in extensions and any organization marketplaces.</span>
            <Button size="sm" onClick={onOpenAccount}>
              {t("skills.share_team_sign_in")}
            </Button>
          </div>
        </SettingsNotice>
      ) : null}

      {actionError ?? extensions.cloudOrgMarketplacesStatus() ? (
        <SettingsNotice tone="error">{actionError ?? extensions.cloudOrgMarketplacesStatus()}</SettingsNotice>
      ) : null}

      {busy ? (
        <SettingsNotice>Loading marketplace extensions...</SettingsNotice>
      ) : null}

      {removedUpstreamPlugins.map((plugin) => (
        <SettingsNotice key={plugin.pluginId}>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>{t("extensions.removed_upstream_notice", { name: plugin.name })}</span>
            <Button
              size="sm"
              variant="outline"
              disabled={Boolean(actionId)}
              onClick={() => void removePlugin(plugin.pluginId, plugin.name)}
            >
              {actionId === plugin.pluginId ? "Working..." : t("extensions.remove_from_workspace_button")}
            </Button>
          </div>
        </SettingsNotice>
      ))}

      <div className="space-y-3">
        <SettingsListSearchInput
          value={search}
          onChange={(event) => setSearch(event.currentTarget.value)}
          placeholder="Search marketplace extensions..."
        />
        <div className="flex flex-wrap items-center gap-2">
          {(["all", "available", "installed", "update_available"] as const).map((filter) => (
            <Button
              key={filter}
              variant={statusFilter === filter ? "secondary" : "outline"}
              size="xs"
              onClick={() => setStatusFilter(filter)}
            >
              {filter === "all" ? "All" : filter === "update_available" ? "Updates" : filter === "installed" ? "Installed" : "Available"}
            </Button>
          ))}
          <details className="group relative">
            <summary className="flex h-7 cursor-pointer list-none items-center rounded-md border border-dls-border px-2.5 text-xs font-medium text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text">
              Filters
            </summary>
            <div className="absolute right-0 z-20 mt-2 w-72 rounded-xl border border-dls-border bg-dls-surface p-3 shadow-[var(--dls-shell-shadow)]">
              <label className="grid gap-1.5 text-xs text-dls-secondary">
                Marketplace
                <select
                  className="rounded-lg border border-dls-border bg-dls-surface px-2 py-1.5 text-xs text-dls-text"
                  value={marketplaceFilter}
                  onChange={(event) => setMarketplaceFilter(event.currentTarget.value)}
                >
                  <option value="all">All marketplaces</option>
                  {marketplaceOptions.map((marketplace) => (
                    <option key={marketplace.id} value={marketplace.id}>{marketplace.name}</option>
                  ))}
                </select>
              </label>
            </div>
          </details>
        </div>
      </div>

      {!busy && displayRows.length === 0 ? (
        <SettingsListEmptyState>
          {!isSignedIn ? "Sign in to view marketplace extensions." : activeOrgId ? "No marketplace extensions are available yet." : "Choose an organization to view marketplace extensions."}
        </SettingsListEmptyState>
      ) : null}

      {displayRows.length > 0 && visibleRows.length === 0 ? (
        <SettingsListEmptyState>No marketplace extensions match your search or filters.</SettingsListEmptyState>
      ) : null}

      {visibleRows.length > 0 ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,20rem),1fr))] gap-3">
          {visibleRows.map((row) => (
            <MarketplaceCard
              key={row.source === "cloud" ? `${row.marketplaceId}:${row.plugin.id}` : `${row.marketplaceId}:${row.entry.id ?? row.entry.name}`}
              actionId={actionId}
              row={row}
              onOpenDetail={setDetailRow}
              onUpdatePlugin={importPlugin}
              builtInDisabled={builtInExtensionsDisabled}
              builtInConnectingName={builtInConnectingName}
            />
          ))}
        </div>
      ) : null}

      {detailRow?.source === "cloud" ? (
        <MarketplacePackageDetailModal
          actionId={actionId}
          row={detailRow}
          resolved={resolvedPlugins[detailRow.plugin.id] ?? null}
          resolving={detailLoadingId === detailRow.plugin.id}
          resolveError={detailError}
          onClose={() => setDetailRow(null)}
          onImportPlugin={importPlugin}
          onRemovePlugin={removePlugin}
        />
      ) : detailRow?.source === "built-in" ? (
        <BuiltInMarketplaceDetailModal
          row={detailRow}
          disabled={builtInExtensionsDisabled}
          connecting={builtInConnectingName === detailRow.entry.name}
          configSlot={configSlotForBuiltIn?.(detailRow.entry) ?? null}
          onSetEnabled={setBuiltInEnabled}
          onClose={() => setDetailRow(null)}
        />
      ) : null}
    </SettingsSection>
  );

  return embedded ? content : (
    <SettingsStack>
      <Separator />
      {content}
    </SettingsStack>
  );
}

function actionLabelForStatus(status: MarketplacePackageStatus) {
  switch (status) {
    case "installed":
      return "View details";
    case "update_available":
      return "Update available";
    default:
      return "Add";
  }
}

function MarketplaceCard(props: {
  actionId: string | null;
  row: MarketplaceRow;
  onOpenDetail: (row: MarketplaceRow) => void;
  onUpdatePlugin: (marketplaceId: string | null, plugin: DenOrgPlugin) => void | Promise<void>;
  builtInDisabled: boolean;
  builtInConnectingName: string | null;
}) {
  const { actionId, row, onOpenDetail, onUpdatePlugin } = props;

  if (row.source === "built-in") {
    const actionBusy = props.builtInConnectingName === row.entry.name;
    return (
      <ExtensionCard
        name={row.entry.name}
        description={row.entry.description}
        iconSlug={row.entry.iconSlug}
        iconSrc={row.entry.iconSrc}
        kind={row.entry.kind ?? "extension"}
        preview={row.entry.preview}
        connected={row.active}
        connectedLabel={row.entry.defaultEnabled ? "Ready" : "Active"}
        connecting={actionBusy}
        disabled={props.builtInDisabled}
        disabledReason={props.builtInDisabled ? "Disabled by organization" : null}
        actionLabel={row.active ? "Manage" : "View setup"}
        onClick={() => onOpenDetail(row)}
      />
    );
  }

  const actionBusy = actionId === row.plugin.id;
  const manifest = row.plugin.extension?.manifest;
  const cloudBuiltIn = isCloudBuiltInPlugin(row.plugin);
  const updateAvailable = !cloudBuiltIn && row.status === "update_available";

  return (
    <div className="flex flex-col gap-2">
      <ExtensionCard
        name={row.plugin.name}
        description={row.plugin.description || `Marketplace extension from ${row.marketplaceName}.`}
        iconSlug={manifest?.icon?.simpleIconSlug}
        iconSrc={manifest?.icon?.src}
        kind="extension"
        connected={cloudBuiltIn || Boolean(row.imported)}
        connectedLabel={cloudBuiltIn ? "Built-in" : updateAvailable ? t("extensions.update_available") : "Installed"}
        connecting={actionBusy}
        actionLabel={cloudBuiltIn ? "View details" : actionBusy ? "Working..." : actionLabelForStatus(row.status)}
        onClick={() => onOpenDetail(row)}
      />
      {updateAvailable ? (
        <Button
          size="xs"
          variant="secondary"
          disabled={Boolean(actionId)}
          onClick={() => void onUpdatePlugin(row.marketplaceId, row.plugin)}
        >
          {actionBusy ? t("extensions.updating") : t("extensions.update_button")}
        </Button>
      ) : null}
    </div>
  );
}

function BuiltInMarketplaceDetailModal(props: {
  row: BuiltInMarketplaceRow;
  disabled: boolean;
  connecting: boolean;
  configSlot: React.ReactNode | null;
  onSetEnabled?: (entry: McpDirectoryInfo, enabled: boolean) => void;
  onClose: () => void;
}) {
  const { row, disabled, connecting, configSlot, onClose, onSetEnabled } = props;
  const entry = row.entry;
  const toggleControlled = isToggleControlledExtension(entry);
  return (
    <ExtensionDetailModal
      open
      onClose={onClose}
      name={entry.name}
      description={entry.description}
      iconSlug={entry.iconSlug}
      iconSrc={entry.iconSrc}
      kind={entry.kind ?? "extension"}
      connected={row.active}
      connectedLabel={entry.defaultEnabled ? "Ready" : "Active"}
      disconnectedLabel="Needs setup"
      connecting={connecting}
      preview={entry.preview}
      disabledReason={disabled ? "Disabled by organization" : null}
      setupInstructions={entry.extensionManifest?.setup?.instructions}
      resourceLabels={entry.extensionManifest?.resources.map((resource) => resource.label ?? resource.id) ?? []}
      contributionLabels={entry.extensionManifest?.contributions?.map((contribution) => contribution.label ?? contribution.ref ?? contribution.type) ?? []}
      configSlot={configSlot}
      showEnablementCard={false}
      connectLabel="Enable"
      connectingLabel="Enabling..."
      uninstallLabel="Disable"
      onConnect={!disabled && toggleControlled && !row.active && onSetEnabled ? () => onSetEnabled(entry, true) : undefined}
      onUninstall={!disabled && toggleControlled && row.active && onSetEnabled ? () => onSetEnabled(entry, false) : undefined}
    />
  );
}

function MarketplacePackageDetailModal(props: {
  actionId: string | null;
  row: MarketplacePackageRow;
  resolved: DenOrgPluginResolved | null;
  resolving: boolean;
  resolveError: string | null;
  onClose: () => void;
  onImportPlugin: (marketplaceId: string | null, plugin: DenOrgPlugin) => void | Promise<void>;
  onRemovePlugin: (pluginId: string, pluginName: string) => void | Promise<void>;
}) {
  const { actionId, row, resolved, resolving, resolveError, onClose, onImportPlugin, onRemovePlugin } = props;
  const actionBusy = actionId === row.plugin.id;
  const cloudBuiltIn = isCloudBuiltInPlugin(row.plugin);
  const manifest = row.plugin.extension?.manifest;
  const canAddOrUpdate = !cloudBuiltIn && (row.status === "available" || row.status === "update_available");

  return (
    <ExtensionDetailModal
      open
      onClose={onClose}
      name={row.plugin.name}
      description={row.plugin.description || "No description provided."}
      iconSlug={manifest?.icon?.simpleIconSlug}
      iconSrc={manifest?.icon?.src}
      kind="extension"
      connected={cloudBuiltIn || Boolean(row.imported)}
      connectedLabel={cloudBuiltIn ? "Built-in" : "Installed"}
      connecting={actionBusy}
      connectLabel={row.status === "update_available" ? "Update" : "Add"}
      connectingLabel={row.status === "update_available" ? "Updating..." : "Adding..."}
      uninstallLabel="Remove"
      showEnablementCard={false}
      setupInstructions={manifest?.setup?.instructions}
      resourceLabels={manifest?.resources.map((resource) => resource.label ?? resource.id) ?? []}
      contributionLabels={manifest?.contributions?.map((contribution) => contribution.label ?? contribution.ref ?? contribution.type) ?? []}
      onConnect={canAddOrUpdate ? () => void onImportPlugin(row.marketplaceId, row.plugin) : undefined}
      onUninstall={!cloudBuiltIn && row.imported ? () => void onRemovePlugin(row.plugin.id, row.plugin.name) : undefined}
      configSlot={(
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <SettingsPill className={statusClass(row.status)}>{cloudBuiltIn ? "Built-in" : statusLabel(row.status)}</SettingsPill>
            <SettingsPill>{row.marketplaceName}</SettingsPill>
            {row.counts.map((label) => <SettingsPill key={label}>{label}</SettingsPill>)}
          </div>
          <div className="rounded-xl border border-dls-border bg-dls-hover px-3 py-3">
            <div className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Composition</div>
            <div className="mt-2 grid gap-2">
              {row.composition.map((entry) => (
                <div key={entry.type} className="flex items-center justify-between text-sm">
                  <span className="capitalize text-card-foreground">{entry.label}</span>
                  <span className="rounded-full bg-dls-surface px-2 py-0.5 text-xs font-medium text-muted-foreground">{entry.count}</span>
                </div>
              ))}
            </div>
          </div>
          {resolveError ? (
            <SettingsNotice tone="error">{resolveError}</SettingsNotice>
          ) : null}
          {resolving ? (
            <SettingsNotice>Loading extension contents...</SettingsNotice>
          ) : null}
          {resolved ? (
            <div className="space-y-2">
              <div className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Extension contents</div>
              {resolved.memberships.length > 0 ? resolved.memberships.map((membership) => {
                const object = membership.configObject;
                const version = object?.latestVersion ?? null;
                if (!object) return null;
                const preview = version?.rawSourceText?.trim().slice(0, 600) ?? "";
                return (
                  <details key={membership.id} className="rounded-xl border border-dls-border bg-dls-surface px-3 py-2">
                    <summary className="cursor-pointer text-sm font-medium text-card-foreground">
                      <span className="uppercase text-[10px] tracking-[0.12em] text-muted-foreground">{object.objectType}</span> {object.title}
                    </summary>
                    <div className="mt-2 space-y-2 text-xs text-muted-foreground">
                      {object.description ? <div>{object.description}</div> : null}
                      {object.currentRelativePath ? <div className="font-mono">{object.currentRelativePath}</div> : null}
                      {preview ? (
                        <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-dls-hover p-2 font-mono text-[11px] text-card-foreground">
                          {preview}
                        </pre>
                      ) : null}
                    </div>
                  </details>
                );
              }) : (
                <SettingsNotice>This extension does not expose detailed contents yet.</SettingsNotice>
              )}
            </div>
          ) : null}
          {row.imported?.files.length ? (
            <div className="rounded-xl border border-dls-border bg-dls-hover px-3 py-2 text-xs text-muted-foreground">
              Installed files: {row.imported.files.map((file) => `${file.title} (${file.objectType})`).join(", ")}
            </div>
          ) : null}
        </div>
      )}
    />
  );
}
