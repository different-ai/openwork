/** @jsxImportSource react */
import type { CloudImportedPlugin, CloudImportedProvider, CloudImportedSkill } from "../../../../app/cloud/import-state";
import type {
  DenOrgMarketplaceResolved,
  DenOrgLlmProvider,
  DenOrgPlugin,
} from "../../../../app/lib/den";
import type { DenOrgSkillCard } from "../../../../app/types";
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

type ResourceActionKind = "import" | "remove" | "sync";

export type CloudProviderRow = {
  key: string;
  cloudProviderId: string;
  provider: DenOrgLlmProvider | null;
  imported: CloudImportedProvider | null;
  status: "available" | "imported" | "out_of_sync" | "removed_from_cloud";
  name: string;
};

export type CloudSkillRow = {
  key: string;
  cloudSkillId: string;
  skill: DenOrgSkillCard | null;
  imported: CloudImportedSkill | null;
  status: "available" | "installed" | "out_of_sync" | "removed_from_cloud";
  title: string;
  installedName: string | null;
};

export type CloudPluginRow = {
  marketplaceId: string;
  plugin: DenOrgPlugin;
  imported: CloudImportedPlugin | null;
  status: "available" | "imported" | "out_of_sync";
};

export type CloudWorker = {
  workerId: string;
  workerName: string;
  status: string;
  instanceUrl: string | null;
  provider: string | null;
  isMine: boolean;
  createdAt: string | null;
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

const skillSearchKeys = ["title"];
const pluginSearchKeys = ["plugin.name"];
const workerSearchKeys = ["workerName"];
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

function workerStatusValue(status: string) {
  return status.trim().toLowerCase() || "unknown";
}

function workerStatusMeta(status: string) {
  const normalized = workerStatusValue(status);

  switch (normalized) {
    case "healthy":
      return { label: t("dashboard.worker_status_ready"), tone: "ready" as const, canOpen: true };
    case "provisioning":
      return { label: t("dashboard.worker_status_starting"), tone: "warning" as const, canOpen: false };
    case "failed":
      return { label: t("dashboard.worker_status_attention"), tone: "error" as const, canOpen: false };
    case "stopped":
      return { label: t("dashboard.worker_status_stopped"), tone: "neutral" as const, canOpen: false };
    default:
      return {
        label: normalized
          ? `${normalized.slice(0, 1).toUpperCase()}${normalized.slice(1)}`
          : t("dashboard.worker_status_unknown"),
        tone: "neutral" as const,
        canOpen: normalized === "ready",
      };
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

interface CloudSkillListItemProps {
  actionId: string | null;
  actionKind: ResourceActionKind | null;
  row: CloudSkillRow;
  onImportSkill: (cloudSkillId: string, title: string) => void | Promise<void>;
  onRemoveSkill: (cloudSkillId: string, title: string) => void | Promise<void>;
  onSyncSkill: (cloudSkillId: string, title: string) => void | Promise<void>;
}

function CloudSkillListItem({
  actionId,
  actionKind,
  row,
  onImportSkill,
  onRemoveSkill,
  onSyncSkill,
}: CloudSkillListItemProps) {
  const actionBusy = actionId === row.cloudSkillId;
  const actionLabel = !actionBusy
    ? null
    : actionKind === "import"
      ? t("den.importing")
      : actionKind === "sync"
        ? t("den.syncing")
        : t("den.removing");

  return (
    <SettingsListItem>
      <SettingsListItemContent>
        <SettingsListTitle>
          <SettingsListItemTitle>{row.title}</SettingsListItemTitle>
          {row.skill?.shared === "public" ? <SettingsPill>{t("skills.cloud_shared_public")}</SettingsPill> : null}
          {row.skill?.shared === null ? <SettingsPill>{t("den.private_badge")}</SettingsPill> : null}
          {row.installedName ? <SettingsPill>{t("den.installed_name_badge", { name: row.installedName })}</SettingsPill> : null}
          {row.status !== "available" ? (
            <SettingsPill className={statusBadgeVariants({ tone: resourceStatusTone(row.status) })}>
              {row.status === "installed"
                ? t("den.imported_badge")
                : row.status === "out_of_sync"
                  ? t("den.out_of_sync_badge")
                  : t("den.removed_from_cloud_badge")}
            </SettingsPill>
          ) : null}
        </SettingsListTitle>
        <SettingsListItemDescription>
          {row.status === "available"
            ? t("den.cloud_skill_detail", { title: row.title })
            : row.status === "installed"
              ? t("den.cloud_skill_imported_detail", { name: row.installedName ?? row.title })
              : row.status === "out_of_sync"
                ? t("den.cloud_skill_sync_detail", { name: row.installedName ?? row.title })
                : t("den.cloud_skill_removed_detail", { name: row.installedName ?? row.title })}
        </SettingsListItemDescription>
      </SettingsListItemContent>
      <SettingsListItemActions>
        {row.status === "out_of_sync" && row.skill ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void onSyncSkill(row.cloudSkillId, row.title)}
            disabled={actionId !== null}
          >
            {actionBusy && actionKind === "sync" ? t("den.syncing") : t("den.sync")}
          </Button>
        ) : null}
        {row.status === "available" && row.skill ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void onImportSkill(row.cloudSkillId, row.title)}
            disabled={actionId !== null}
          >
            {actionBusy ? actionLabel : t("den.import_skill")}
          </Button>
        ) : null}
        {row.status !== "available" ? (
          <Button
            variant="destructive"
            size="sm"
            onClick={() => void onRemoveSkill(row.cloudSkillId, row.title)}
            disabled={actionId !== null}
          >
            {actionBusy ? actionLabel : t("den.uninstall")}
          </Button>
        ) : null}
      </SettingsListItemActions>
    </SettingsListItem>
  );
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
        {actionBusy ? t("den.importing") : row.status === "available" ? t("den.import_provider") : t("den.sync")}
      </Button>
    </SettingsListItem>
  );
}

interface CloudWorkerListItemProps {
  openingWorkerId: string | null;
  worker: CloudWorker;
  onOpenWorker: (workerId: string, workerName: string) => void | Promise<void>;
}

function CloudWorkerListItem({ openingWorkerId, worker, onOpenWorker }: CloudWorkerListItemProps) {
  const status = workerStatusMeta(worker.status);

  return (
    <SettingsListItem>
      <SettingsListItemContent>
        <SettingsListTitle>
          <SettingsListItemTitle>{worker.workerName}</SettingsListItemTitle>
          <SettingsPill className={statusBadgeVariants({ tone: status.tone })}>
            {status.label}
          </SettingsPill>
        </SettingsListTitle>
        <SettingsListItemDescription>
          {[
            worker.isMine ? t("den.worker_mine_badge") : null,
            worker.provider ? t("den.worker_provider_label", { provider: worker.provider }) : t("den.worker_secondary_cloud"),
            worker.instanceUrl,
          ].filter(Boolean).join(" · ")}
        </SettingsListItemDescription>
      </SettingsListItemContent>
      <Button
        variant="outline"
        size="sm"
        onClick={() => void onOpenWorker(worker.workerId, worker.workerName)}
        disabled={[openingWorkerId !== null, !status.canOpen].some(Boolean)}
        title={!status.canOpen ? t("den.worker_not_ready_title") : undefined}
      >
        {openingWorkerId === worker.workerId ? t("den.opening") : t("den.open")}
      </Button>
    </SettingsListItem>
  );
}

interface CloudProviderListItemProps {
  actionId: string | null;
  actionKind: ResourceActionKind | null;
  row: CloudProviderRow;
  onImport: (cloudProviderId: string, providerName: string) => void | Promise<void>;
  onRemove?: (cloudProviderId: string, providerName: string) => void | Promise<void>;
  onSync: (cloudProviderId: string, providerName: string) => void | Promise<void>;
}

function CloudProviderListItem({ actionId, actionKind, row, onImport, onRemove, onSync }: CloudProviderListItemProps) {
  const actionBusy = actionId === row.cloudProviderId;
  const actionLabel = !actionBusy
    ? null
    : actionKind === "import"
      ? t("den.importing")
      : actionKind === "sync"
        ? t("den.syncing")
        : t("den.removing");
  const source = row.provider?.source === "custom" ? "custom" : "managed";
  const modelCount = row.provider?.models.length ?? 0;
  const cloudProviderDetail = modelCount === 0
    ? `All Models · ${source} provider`
    : t("den.cloud_provider_detail", { count: modelCount, source });
  const cloudProviderSyncDetail = modelCount === 0
    ? `Cloud provider changed. Sync the All Models ${source} config into opencode.jsonc.`
    : t("den.cloud_provider_sync_detail", { count: modelCount, source });

  return (
    <SettingsListItem>
      <SettingsListItemContent>
        <SettingsListTitle>
          <SettingsListItemTitle>{row.name}</SettingsListItemTitle>
          {row.status !== "available" ? (
            <SettingsPill className={statusBadgeVariants({ tone: resourceStatusTone(row.status) })}>
              {row.status === "imported"
                ? t("den.imported_badge")
                : row.status === "out_of_sync"
                  ? t("den.out_of_sync_badge")
                  : t("den.removed_from_cloud_badge")}
            </SettingsPill>
          ) : null}
        </SettingsListTitle>
        <SettingsListItemDescription>
          {[
            row.provider?.providerId ?? row.imported?.providerId,
            row.provider?.hasApiKey ? t("den.credentials_ready_badge") : null,
            row.status === "removed_from_cloud"
              ? t("den.cloud_provider_removed_detail", {
                  providerId: row.imported?.providerId ?? row.name,
                })
              : row.status === "out_of_sync"
                ? cloudProviderSyncDetail
                : cloudProviderDetail,
          ].filter(Boolean).join(" · ")}
        </SettingsListItemDescription>
      </SettingsListItemContent>
      <SettingsListItemActions>
        {row.status === "out_of_sync" && row.provider ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void onSync(row.cloudProviderId, row.name)}
            disabled={actionId !== null}
          >
            {actionBusy && actionKind === "sync" ? t("den.syncing") : t("den.sync")}
          </Button>
        ) : null}
        {row.status === "available" && row.provider ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void onImport(row.cloudProviderId, row.name)}
            disabled={actionId !== null}
          >
            {actionBusy ? actionLabel : t("den.import_provider")}
          </Button>
        ) : null}
        {row.status !== "available" && onRemove ? (
          <Button
            variant="destructive"
            size="sm"
            onClick={() => void onRemove(row.cloudProviderId, row.name)}
            disabled={actionId !== null}
          >
            {actionBusy ? actionLabel : row.status === "removed_from_cloud" ? t("den.uninstall") : t("common.remove")}
          </Button>
        ) : null}
      </SettingsListItemActions>
    </SettingsListItem>
  );
}

export interface CloudSkillsSectionProps {
  actionError: string | null;
  actionId: string | null;
  actionKind: ResourceActionKind | null;
  busy: boolean;
  rows: CloudSkillRow[];
  statusError: string | null;
  onImportSkill: (cloudSkillId: string, title: string) => void | Promise<void>;
  onRefresh: () => void | Promise<void>;
  onRemoveSkill: (cloudSkillId: string, title: string) => void | Promise<void>;
  onSyncSkill: (cloudSkillId: string, title: string) => void | Promise<void>;
}

export function CloudSkillsSection({
  actionError,
  actionId,
  actionKind,
  busy,
  rows,
  statusError,
  onImportSkill,
  onRefresh,
  onRemoveSkill,
  onSyncSkill,
}: CloudSkillsSectionProps) {
  const { hasActiveOrg } = useCloudSession();
  const [searchQuery, setSearchQuery] = React.useState("");
  const visibleRows = useSearch({ items: rows, keys: skillSearchKeys, query: searchQuery });
  const skillGroups = [
    { value: "available", label: "Available", rows: visibleRows.filter((row) => row.status === "available") },
    { value: "out_of_sync", label: t("den.out_of_sync_badge"), rows: visibleRows.filter((row) => row.status === "out_of_sync") },
    { value: "installed", label: t("skills.cloud_status_installed"), rows: visibleRows.filter((row) => row.status === "installed") },
    { value: "removed_from_cloud", label: t("den.removed_from_cloud_badge"), rows: visibleRows.filter((row) => row.status === "removed_from_cloud") },
  ].filter((group) => group.rows.length > 0);

  return (
    <SettingsSection>
      <SettingsSectionHeader>
        <SettingsSectionHeaderContent>
          <SettingsSectionHeaderTitle>
            {t("den.cloud_skills_title")}
          </SettingsSectionHeaderTitle>
          <SettingsSectionHeaderDescription>{t("den.cloud_skills_hint")}</SettingsSectionHeaderDescription>
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

      {!busy && rows.length === 0 ? (
        <SettingsListEmptyState>
          {hasActiveOrg ? t("den.no_cloud_skills") : t("den.choose_org_for_skills")}
        </SettingsListEmptyState>
      ) : null}

      {rows.length > 0 ? (
        <>
          <Field>
            <FieldLabel className="sr-only" htmlFor="cloud-skill-search">
              Search
            </FieldLabel>
            <SettingsListSearchInput
              id="cloud-skill-search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.currentTarget.value)}
            />
            <FieldDescription className="sr-only">Search for a skill.</FieldDescription>
          </Field>

          {visibleRows.length > 0 ? (
            <Accordion multiple defaultValue={["available", "out_of_sync"]}>
              {skillGroups.map((group) => (
                <AccordionItem key={group.value} value={group.value}>
                  <AccordionTrigger className="items-center hover:no-underline group gap-x-3">
                    <span className="group-hover:underline">{group.label}</span>
                    <SettingsPill>{group.rows.length}</SettingsPill>
                  </AccordionTrigger>
                  <AccordionContent className="px-1.5 pb-1.5">
                    <SettingsList>
                      {group.rows.map((row) => (
                        <CloudSkillListItem
                          key={row.key}
                          actionId={actionId}
                          actionKind={actionKind}
                          row={row}
                          onImportSkill={onImportSkill}
                          onRemoveSkill={onRemoveSkill}
                          onSyncSkill={onSyncSkill}
                        />
                      ))}
                    </SettingsList>
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          ) : (
            <SettingsListEmptyState>No skills match your search.</SettingsListEmptyState>
          )}
        </>
      ) : null}
    </SettingsSection>
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

export interface CloudWorkersSectionProps {
  openingWorkerId: string | null;
  workers: CloudWorker[];
  workersBusy: boolean;
  workersError: string | null;
  onOpenWorker: (workerId: string, workerName: string) => void | Promise<void>;
  onRefreshWorkers: () => void | Promise<void>;
}

export function CloudWorkersSection({
  openingWorkerId,
  workers,
  workersBusy,
  workersError,
  onOpenWorker,
  onRefreshWorkers,
}: CloudWorkersSectionProps) {
  const { hasActiveOrg } = useCloudSession();
  const [searchQuery, setSearchQuery] = React.useState("");
  const visibleWorkers = useSearch({ items: workers, keys: workerSearchKeys, query: searchQuery });
  const workerGroups: { value: string; label: string; rows: CloudWorker[] }[] = [];
  const workerGroupsByValue = new Map<string, { value: string; label: string; rows: CloudWorker[] }>();

  for (const worker of visibleWorkers) {
    const value = workerStatusValue(worker.status);
    const group = workerGroupsByValue.get(value);

    if (group) {
      group.rows.push(worker);
    } else {
      const nextGroup = { value, label: workerStatusMeta(worker.status).label, rows: [worker] };
      workerGroups.push(nextGroup);
      workerGroupsByValue.set(value, nextGroup);
    }
  }

  const workerDefaultGroups = workerGroups.flatMap((group) => group.value !== "stopped" ? [group.value] : []);

  return (
    <SettingsSection>
      <SettingsSectionHeader>
        <SettingsSectionHeaderContent>
          <SettingsSectionHeaderTitle>
            {t("den.cloud_workers_title")}
          </SettingsSectionHeaderTitle>
          <SettingsSectionHeaderDescription>{t("den.cloud_workers_hint")}</SettingsSectionHeaderDescription>
        </SettingsSectionHeaderContent>
        <SettingsSectionHeaderActions>
          <RefreshButton
            busy={workersBusy}
            disabled={[workersBusy, !hasActiveOrg].some(Boolean)}
            onRefresh={onRefreshWorkers}
          >
            {t("den.refresh")}
          </RefreshButton>
        </SettingsSectionHeaderActions>
      </SettingsSectionHeader>

      {workersError ? <SettingsNotice tone="error">{workersError}</SettingsNotice> : null}

      {!workersBusy && workers.length === 0 ? (
        <SettingsListEmptyState>{t("den.no_cloud_workers")}</SettingsListEmptyState>
      ) : null}

      {workers.length > 0 ? (
        <>
          <Field>
            <FieldLabel className="sr-only" htmlFor="cloud-worker-search">
              Search
            </FieldLabel>
            <SettingsListSearchInput
              id="cloud-worker-search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.currentTarget.value)}
            />
            <FieldDescription className="sr-only">Search for a worker.</FieldDescription>
          </Field>

          {visibleWorkers.length > 0 ? (
            <Accordion multiple defaultValue={workerDefaultGroups}>
              {workerGroups.map((group) => (
                <AccordionItem key={group.value} value={group.value}>
                  <AccordionTrigger className="items-center hover:no-underline group gap-x-3">
                    <span className="group-hover:underline">{group.label}</span>
                    <SettingsPill>{group.rows.length}</SettingsPill>
                  </AccordionTrigger>
                  <AccordionContent className="px-1.5 pb-1.5">
                    <SettingsList>
                      {group.rows.map((worker) => (
                        <CloudWorkerListItem
                          key={worker.workerId}
                          openingWorkerId={openingWorkerId}
                          worker={worker}
                          onOpenWorker={onOpenWorker}
                        />
                      ))}
                    </SettingsList>
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          ) : (
            <SettingsListEmptyState>No workers match your search.</SettingsListEmptyState>
          )}
        </>
      ) : null}
    </SettingsSection>
  );
}


export interface CloudProvidersSectionProps {
  actionError: string | null;
  actionId: string | null;
  actionKind: ResourceActionKind | null;
  busy: boolean;
  rows: CloudProviderRow[];
  onImport: (cloudProviderId: string, providerName: string) => void | Promise<void>;
  onRefresh: () => void | Promise<void>;
  onRemove?: (cloudProviderId: string, providerName: string) => void | Promise<void>;
  onSync: (cloudProviderId: string, providerName: string) => void | Promise<void>;
}

export function CloudProvidersSection({
  actionError,
  actionId,
  actionKind,
  busy,
  rows,
  onImport,
  onRefresh,
  onRemove,
  onSync,
}: CloudProvidersSectionProps) {
  const { hasActiveOrg } = useCloudSession();
  const [searchQuery, setSearchQuery] = React.useState("");
  const visibleRows = useSearch({ items: rows, keys: nameSearchKeys, query: searchQuery });
  const providerGroups = [
    { value: "available", label: "Available", rows: visibleRows.filter((row) => row.status === "available") },
    { value: "out_of_sync", label: t("den.out_of_sync_badge"), rows: visibleRows.filter((row) => row.status === "out_of_sync") },
    { value: "imported", label: t("den.imported_badge"), rows: visibleRows.filter((row) => row.status === "imported") },
    { value: "removed_from_cloud", label: t("den.removed_from_cloud_badge"), rows: visibleRows.filter((row) => row.status === "removed_from_cloud") },
  ].filter((group) => group.rows.length > 0);

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
          <RefreshButton
            busy={busy}
            disabled={[busy, !hasActiveOrg].some(Boolean)}
            onRefresh={onRefresh}
          >
            {t("den.refresh")}
          </RefreshButton>
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
            <Accordion multiple defaultValue={["available", "imported", "out_of_sync"]}>
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
                          actionKind={actionKind}
                          row={row}
                          onImport={onImport}
                          onRemove={onRemove}
                          onSync={onSync}
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
