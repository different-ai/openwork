/** @jsxImportSource react */
import { formatRelativeTime } from "@/app/utils";
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
import { ArrowUpRight, RefreshCcw, Users } from "lucide-react";
import { OrganizationMark, ProviderList, ProviderMeta, ProviderRow, ProviderStatus, ProviderTile } from "../pages/provider-rows";

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
  /** Monospace id at the start of the meta line, e.g. Den's provider id. */
  metaId?: string;
  /** Who Den grants it to: "Everyone", team names, or a member count. */
  access?: string | null;
  /** The provider has a credential this member can use. */
  credentialReady?: boolean;
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
      warning: "border-dls-border bg-dls-hover text-dls-text",
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

function cloudProviderRowStatus(status: CloudProviderRowStatus) {
  switch (status) {
    case "connected":
      return <ProviderStatus tone="ready">Ready to use</ProviderStatus>;
    case "error":
    case "conflict":
      return <ProviderStatus tone="error">{cloudProviderStatusLabel(status)}</ProviderStatus>;
    case "needs_credential":
    case "needs_server":
      return <ProviderStatus tone="attention">{cloudProviderStatusLabel(status)}</ProviderStatus>;
    default:
      return <ProviderStatus tone="neutral">{cloudProviderStatusLabel(status)}</ProviderStatus>;
  }
}

function CloudProviderListItem({ actionId, row, onRetry }: CloudProviderListItemProps) {
  const actionBusy = actionId === row.cloudProviderId;
  const status = actionBusy ? "syncing" : row.status;
  const providerId = row.imported?.sourceProviderId ?? row.provider?.providerId ?? "";

  return (
    <ProviderRow
      scope="organization"
      tile={<ProviderTile providerId={providerId} name={row.name} />}
      name={row.name}
      status={cloudProviderRowStatus(status)}
      meta={<ProviderMeta id={row.metaId} parts={[row.detail]} />}
      aside={row.access ? <><Users className="size-3.5" aria-hidden />{row.access}</> : null}
      actions={row.status === "error" && row.provider ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => void onRetry(row.cloudProviderId)}
          disabled={actionId !== null}
        >
          {actionBusy ? t("den.cloud_provider_syncing") : t("den.cloud_provider_retry")}
        </Button>
      ) : null}
    />
  );
}

export interface CloudProvidersSectionProps {
  actionError: string | null;
  actionId: string | null;
  busy: boolean;
  rows: CloudProviderRow[];
  onRefresh: () => void | Promise<void>;
  onRetry: (cloudProviderId: string) => void | Promise<void>;
  onOpenDen?: () => void;
  onOpenModelConnections?: () => void;
  lastVerifiedAt?: string | number | null;
  additionalRows?: React.ReactNode;
  additionalCount?: number;
}

export function CloudProvidersSection({ actionError, actionId, busy, rows, onRefresh, onRetry, onOpenDen, onOpenModelConnections, lastVerifiedAt, additionalRows, additionalCount = 0 }: CloudProvidersSectionProps) {
  const { hasActiveOrg, activeOrgName } = useCloudSession();
  const organizationName = activeOrgName || "your organization";
  const verified = lastVerifiedAt ? new Date(lastVerifiedAt) : null;
  const timestamp = verified && Number.isFinite(verified.getTime()) ? formatRelativeTime(verified.getTime()) : null;
  const providerCount = rows.length + additionalCount;
  const credentialCount = rows.filter((row) => row.credentialReady).length;
  return <section className="flex flex-col gap-3" aria-labelledby="ai-providers-organization">
    <div className="space-y-1">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          {activeOrgName ? <OrganizationMark name={activeOrgName} /> : null}
          <h2 id="ai-providers-organization" className="min-w-0 truncate text-base font-medium text-dls-text">From {organizationName}</h2>
          <span className="shrink-0 rounded-full bg-blue-3 px-2 py-0.5 text-xs font-medium text-blue-11">Managed in Den</span>
        </div>
        <div className="-mr-2 flex shrink-0 items-center gap-1">
          {onOpenModelConnections ? <Button variant="ghost" size="sm" onClick={onOpenModelConnections}>My model connections</Button> : null}
          {onOpenDen ? <Button variant="ghost" size="sm" onClick={onOpenDen}>Open in Den<ArrowUpRight className="size-3.5" aria-hidden /></Button> : null}
        </div>
      </div>
      <p className="text-sm text-muted-foreground">Your organization pays for and manages these. Members call them through the OpenWork Gateway; upstream credentials never reach this device.</p>
    </div>
    {actionError ? <SettingsNotice tone="error">{actionError}</SettingsNotice> : null}
    {busy && !providerCount ? <div role="status" aria-label="Loading organization providers" className="grid gap-2">{[0, 1].map((key) => <div key={key} className="h-16 animate-pulse rounded-2xl bg-muted" />)}</div> : null}
    {!busy && !providerCount ? <SettingsListEmptyState>{hasActiveOrg ? t("den.no_cloud_providers") : t("den.choose_org_for_providers")}</SettingsListEmptyState> : null}
    {providerCount ? <ProviderList>
      {rows.map((row) => <CloudProviderListItem key={row.key} actionId={actionId} row={row} onRetry={onRetry} />)}
      {additionalRows}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-dls-surface-muted px-4 py-2.5 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-2"><RefreshCcw className="size-3.5" aria-hidden />{timestamp ? `Synced with Den ${timestamp}` : "Not synced with Den yet"} · {providerCount === 1 ? "1 provider" : `${providerCount} providers`}, {credentialCount === 1 ? "1 credential" : `${credentialCount} credentials`}</span>
        <Button variant="ghost" size="sm" disabled={busy || !hasActiveOrg} onClick={() => void onRefresh()}>{busy ? "Syncing…" : "Sync now"}</Button>
      </div>
    </ProviderList> : null}
  </section>;
}
