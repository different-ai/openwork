/** @jsxImportSource react */
import type { CloudImportedPlugin, CloudImportedProvider } from "../../../../app/cloud/import-state";
import type {
  DenOrgMarketplaceResolved,
  DenOrgLlmProvider,
  DenOrgPlugin,
} from "../../../../app/lib/den";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { cva } from "class-variance-authority";
import fuzzysort from "fuzzysort";
import * as React from "react";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  RefreshButton,
  SettingsSection,
  SettingsNotice,
  SettingsPill,
  SettingsSectionHeader,
  SettingsSectionHeaderActions,
  SettingsSectionHeaderContent,
  SettingsSectionHeaderDescription,
  SettingsSectionHeaderTitle,
} from "../settings-section";
import {
  SettingsList,
  SettingsListItemActions,
  SettingsListEmptyState,
  SettingsListItem,
  SettingsListItemContent,
  SettingsListItemDescription,
  SettingsListTitle,
  SettingsListItemTitle,
  SettingsListSearchInput,
} from "../settings-list";
import { t } from "@/i18n";
import { useCloudSession } from "./cloud-session-provider";

export type CloudProviderRowStatus =
  | "connected"
  | "syncing"
  | "error"
  | "conflict"
  | "blocked"
  | "needs_credential"
  | "needs_server"
  | "unavailable";

export type CloudProviderRow = {
  key: string;
  cloudProviderId: string;
  provider: DenOrgLlmProvider | null;
  imported: CloudImportedProvider | null;
  status: CloudProviderRowStatus;
  name: string;
  detail: string;
};

export type CloudPluginRow = {
  marketplaceId: string;
  plugin: DenOrgPlugin;
  imported: CloudImportedPlugin | null;
  status: "available" | "imported" | "out_of_sync";
};

const statusBadgeVariants = cva("", {
  variants: {
    tone: {
      ready: "border-green-7/30 bg-green-3/20 text-green-11",
      warning: "border-amber-7/30 bg-amber-3/20 text-amber-11",
      error: "border-red-7/30 bg-red-3/20 text-red-11",
      neutral: "border-gray-6/60 bg-gray-3/20 text-gray-11",
    },
  },
});

const pluginSearchKeys = ["plugin.name"];
const nameSearchKeys = ["name"];

function resourceStatusTone(status: string) {
  switch (status) {
    case "installed":
    case "imported":
      return "ready" as const;
    case "out_of_sync":
      return "warning" as const;
    case "removed_from_cloud":
      return "error" as const;
    default:
      return "neutral" as const;
  }
}

function cloudProviderStatusTone(status: CloudProviderRowStatus) {
  switch (status) {
    case "connected":
      return "ready" as const;
    case "error":
    case "conflict":
      return "error" as const;
    case "blocked":
    case "needs_credential":
    case "needs_server":
    case "unavailable":
      return "warning" as const;
    default:
      return "neutral" as const;
  }
}

function cloudProviderStatusLabel(status: CloudProviderRowStatus) {
  switch (status) {
    case "connected":
      return t("den.cloud_provider_connected");
    case "syncing":
      return t("den.cloud_provider_syncing");
    case "error":
      return t("den.cloud_provider_error");
    case "conflict":
      return t("den.cloud_provider_conflict");
    case "blocked":
      return t("den.cloud_provider_blocked");
    case "needs_credential":
      return t("den.cloud_provider_needs_credential");
    case "needs_server":
      return t("den.cloud_provider_needs_server");
    case "unavailable":
      return t("den.cloud_provider_imports_unavailable");
  }
}

interface UseSearchProps<T> {
  items: T[];
  keys: string[];
  query: string;
}

function useSearch<T>({ items, keys, query }: UseSearchProps<T>) {
  return React.useMemo(() => {
    if (!query.trim()) {
      return items;
    }

    return fuzzysort.go(query, items, { keys }).map((result) => result.obj);
  }, [items, keys, query]);
}

interface MarketplacePluginListItemProps {
  actionId: string | null;
  row: CloudPluginRow;
  onImportPlugin: (marketplaceId: string | null, plugin: DenOrgPlugin) => void | Promise<void>;
}

function MarketplacePluginListItem({
  actionId,
  row,
  onImportPlugin,
}: MarketplacePluginListItemProps) {
  const actionBusy = actionId === row.plugin.id;
  const counts = Object.entries(row.plugin.componentCounts).flatMap(([type, count]) =>
    count > 0 ? [`${count} ${type}${count === 1 ? "" : "s"}`] : [],
  );

  return (
    <SettingsListItem>
      <SettingsListItemContent>
        <SettingsListTitle>
          <SettingsListItemTitle>{row.plugin.name}</SettingsListItemTitle>
          {row.status !== "available" ? (
            <SettingsPill className={statusBadgeVariants({ tone: resourceStatusTone(row.status) })}>
              {row.status === "imported" ? t("den.imported_badge") : t("den.out_of_sync_badge")}
            </SettingsPill>
          ) : null}
          {counts.map((label) => (
            <SettingsPill key={label}>{label}</SettingsPill>
          ))}
        </SettingsListTitle>
        <SettingsListItemDescription>
          {row.plugin.description || "No description provided."}
        </SettingsListItemDescription>
        {row.imported?.files.length ? (
          <div className="mt-1 truncate text-xs text-muted-foreground">
            Installed files: {row.imported.files.map((file) => file.path).join(", ")}
          </div>
        ) : null}
      </SettingsListItemContent>
      <Button
        variant="outline"
        size="sm"
        onClick={() => void onImportPlugin(row.marketplaceId, row.plugin)}
        disabled={actionId !== null}
      >
        {actionBusy ? t("den.importing_plugin") : row.status === "available" ? t("den.import_plugin") : t("den.sync")}
      </Button>
    </SettingsListItem>
  );
}

interface CloudProviderListItemProps {
  actionId: string | null;
  row: CloudProviderRow;
  onRetry: (cloudProviderId: string) => void | Promise<void>;
}

function CloudProviderListItem({ actionId, row, onRetry }: CloudProviderListItemProps) {
  const actionBusy = actionId === row.cloudProviderId;
  const status = actionBusy ? "syncing" : row.status;

  return (
    <SettingsListItem>
      <SettingsListItemContent>
        <SettingsListTitle>
          <SettingsListItemTitle>{row.name}</SettingsListItemTitle>
          <SettingsPill className={statusBadgeVariants({ tone: cloudProviderStatusTone(status) })}>
            {cloudProviderStatusLabel(status)}
          </SettingsPill>
        </SettingsListTitle>
        <SettingsListItemDescription>
          {[
            row.provider?.providerId ?? row.imported?.providerId,
            row.provider?.hasApiKey ? t("den.credentials_ready_badge") : null,
            row.detail,
          ].filter(Boolean).join(" · ")}
        </SettingsListItemDescription>
      </SettingsListItemContent>
      {row.status === "error" && row.provider ? (
        <SettingsListItemActions>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void onRetry(row.cloudProviderId)}
            disabled={actionId !== null}
          >
            {actionBusy ? t("den.cloud_provider_syncing") : t("den.cloud_provider_retry")}
          </Button>
        </SettingsListItemActions>
      ) : null}
    </SettingsListItem>
  );
}

export interface MarketplacePluginsSectionProps {
  actionError: string | null;
  actionId: string | null;
  activeMarketplaceId: string | null;
  busy: boolean;
  marketplaces: DenOrgMarketplaceResolved[];
  rowsByMarketplace: Record<string, CloudPluginRow[]>;
  statusError: string | null;
  onImportPlugin: (marketplaceId: string | null, plugin: DenOrgPlugin) => void | Promise<void>;
  onRefresh: () => void | Promise<void>;
  onSelectMarketplace: (marketplaceId: string) => void;
}

export function MarketplacePluginsSection({
  actionError,
  actionId,
  activeMarketplaceId,
  busy,
  marketplaces,
  rowsByMarketplace,
  statusError,
  onImportPlugin,
  onRefresh,
  onSelectMarketplace,
}: MarketplacePluginsSectionProps) {
  const { hasActiveOrg } = useCloudSession();
  const [searchQuery, setSearchQuery] = React.useState("");
  const selectedMarketplace =
    marketplaces.find((entry) => entry.marketplace.id === activeMarketplaceId) ?? marketplaces[0] ?? null;
  const selectedRows = selectedMarketplace ? rowsByMarketplace[selectedMarketplace.marketplace.id] ?? [] : [];
  const visibleRows = useSearch({ items: selectedRows, keys: pluginSearchKeys, query: searchQuery });
  const pluginGroups = [
    { value: "available", label: "Available", rows: visibleRows.filter((row) => row.status === "available") },
    { value: "out_of_sync", label: t("den.out_of_sync_badge"), rows: visibleRows.filter((row) => row.status === "out_of_sync") },
    { value: "imported", label: t("den.imported_badge"), rows: visibleRows.filter((row) => row.status === "imported") },
  ].filter((group) => group.rows.length > 0);

  return (
    <SettingsSection>
      <SettingsSectionHeader>
        <SettingsSectionHeaderContent>
          <SettingsSectionHeaderTitle>
            Marketplaces & Plugins
          </SettingsSectionHeaderTitle>
          <SettingsSectionHeaderDescription>
            Browse organization marketplaces and import plugin files into this workspace.
          </SettingsSectionHeaderDescription>
        </SettingsSectionHeaderContent>
        <SettingsSectionHeaderActions>
          <RefreshButton
            busy={busy}
            disabled={[busy, !hasActiveOrg].some(Boolean)}
            onRefresh={onRefresh}
          >
            {t("den.refresh")}
          </RefreshButton>
        </SettingsSectionHeaderActions>
      </SettingsSectionHeader>

      {actionError ?? statusError ? (
        <SettingsNotice tone="error">{actionError ?? statusError}</SettingsNotice>
      ) : null}

      {!busy && marketplaces.length === 0 ? (
        <SettingsListEmptyState>
          {hasActiveOrg ? "No marketplaces are available yet." : "Choose an organization to view marketplaces."}
        </SettingsListEmptyState>
      ) : null}

      {marketplaces.length > 0 ? (
        <Tabs
          value={selectedMarketplace?.marketplace.id}
          onValueChange={onSelectMarketplace}
          className="gap-y-3"
        >
          <TabsList className="max-w-full justify-start overflow-x-auto">
            {marketplaces.map((entry) => (
              <TabsTrigger
                key={entry.marketplace.id}
                value={entry.marketplace.id}
                className="flex-none"
              >
                {entry.marketplace.name}
              </TabsTrigger>
            ))}
          </TabsList>

          <Field>
            <FieldLabel className="sr-only" htmlFor="marketplace-plugin-search">
              Search
            </FieldLabel>
            <SettingsListSearchInput
              id="marketplace-plugin-search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.currentTarget.value)}
            />
            <FieldDescription className="sr-only">Search for a plugin.</FieldDescription>
          </Field>

          <TabsContent value={selectedMarketplace?.marketplace.id}>
            {visibleRows.length > 0 ? (
              <Accordion multiple defaultValue={["available", "out_of_sync"]}>
                {pluginGroups.map((group) => (
                  <AccordionItem key={group.value} value={group.value}>
                    <AccordionTrigger className="items-center hover:no-underline group gap-x-3">
                      <span className="group-hover:underline">{group.label}</span>
                      <SettingsPill>{group.rows.length}</SettingsPill>
                    </AccordionTrigger>
                    <AccordionContent className="px-1.5 pb-1.5">
                      <SettingsList>
                        {group.rows.map((row) => (
                          <MarketplacePluginListItem
                            key={row.plugin.id}
                            actionId={actionId}
                            row={row}
                            onImportPlugin={onImportPlugin}
                          />
                        ))}
                      </SettingsList>
                    </AccordionContent>
                  </AccordionItem>
                ))}
              </Accordion>
            ) : null}

            {selectedRows.length > 0 && visibleRows.length === 0 ? (
              <SettingsListEmptyState>No plugins match your search.</SettingsListEmptyState>
            ) : null}

            {selectedMarketplace && selectedRows.length === 0 ? (
              <SettingsListEmptyState>This marketplace does not have plugins yet.</SettingsListEmptyState>
            ) : null}
          </TabsContent>
        </Tabs>
      ) : null}
    </SettingsSection>
  );
}

export interface CloudProvidersSectionProps {
  actionError: string | null;
  actionId: string | null;
  busy: boolean;
  rows: CloudProviderRow[];
  onRefresh: () => void | Promise<void>;
  onRetry: (cloudProviderId: string) => void | Promise<void>;
}

export function CloudProvidersSection({
  actionError,
  actionId,
  busy,
  rows,
  onRefresh,
  onRetry,
}: CloudProvidersSectionProps) {
  const { hasActiveOrg } = useCloudSession();
  const [searchQuery, setSearchQuery] = React.useState("");
  const visibleRows = useSearch({ items: rows, keys: nameSearchKeys, query: searchQuery });
  const statuses: CloudProviderRowStatus[] = [
    "connected",
    "syncing",
    "error",
    "conflict",
    "blocked",
    "needs_credential",
    "needs_server",
    "unavailable",
  ];
  const providerGroups = statuses
    .map((status) => ({
      value: status,
      label: cloudProviderStatusLabel(status),
      rows: visibleRows.filter((row) => row.status === status),
    }))
    .filter((group) => group.rows.length > 0);

  return (
    <SettingsSection>
      <SettingsSectionHeader>
        <SettingsSectionHeaderContent>
          <SettingsSectionHeaderTitle>
            {t("den.cloud_providers_title")}
          </SettingsSectionHeaderTitle>
          <SettingsSectionHeaderDescription>{t("den.cloud_providers_hint")}</SettingsSectionHeaderDescription>
        </SettingsSectionHeaderContent>
        <SettingsSectionHeaderActions>
          <Button
            variant="outline"
            size="sm"
            disabled={[busy, !hasActiveOrg].some(Boolean)}
            onClick={() => void onRefresh()}
          >
            {busy ? t("den.cloud_provider_syncing") : t("den.sync_now")}
          </Button>
        </SettingsSectionHeaderActions>
      </SettingsSectionHeader>

      {actionError ? <SettingsNotice tone="error">{actionError}</SettingsNotice> : null}

      {!busy && rows.length === 0 ? (
        <SettingsListEmptyState>
          {hasActiveOrg ? t("den.no_cloud_providers") : t("den.choose_org_for_providers")}
        </SettingsListEmptyState>
      ) : null}

      {rows.length > 0 ? (
        <>
          <Field>
            <FieldLabel className="sr-only" htmlFor="cloud-provider-search">
              Search
            </FieldLabel>
            <SettingsListSearchInput
              id="cloud-provider-search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.currentTarget.value)}
            />
            <FieldDescription className="sr-only">Search for a provider.</FieldDescription>
          </Field>

          {visibleRows.length > 0 ? (
            <Accordion multiple defaultValue={statuses}>
              {providerGroups.map((group) => (
                <AccordionItem key={group.value} value={group.value}>
                  <AccordionTrigger className="items-center hover:no-underline group gap-x-3">
                    <span className="group-hover:underline">{group.label}</span>
                    <SettingsPill>{group.rows.length}</SettingsPill>
                  </AccordionTrigger>
                  <AccordionContent className="px-1.5 pb-1.5">
                    <SettingsList>
                      {group.rows.map((row) => (
                        <CloudProviderListItem
                          key={row.key}
                          actionId={actionId}
                          row={row}
                          onRetry={onRetry}
                        />
                      ))}
                    </SettingsList>
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          ) : (
            <SettingsListEmptyState>No providers match your search.</SettingsListEmptyState>
          )}
        </>
      ) : null}
    </SettingsSection>
  );
}
