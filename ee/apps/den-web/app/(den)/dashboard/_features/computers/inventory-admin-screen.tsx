"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ORGANIZATION_COMPUTER_INVENTORY_TABS, type OrganizationComputerInventoryTab } from "@openwork/types/den/computer-inventory";
import { UnderlineTabs } from "../../../_components/ui/tabs";
import { getOrgSettingsRoute } from "../../../_lib/den-org";
import { FilterInput } from "../../_components/item-list";
import { ComputerMenu } from "./computer-action-controls";
import { focusRing, hairline, secondaryText } from "./computer-parts";
import { InventoryMergedSignIns, useInventoryActions } from "./inventory-actions";
import { useOrganizationInventory, useRefreshInventory, type InventoryScope } from "./inventory-data";
import { InventoryDetail } from "./inventory-detail";
import { INVENTORY_TAB_LABELS, computerRulesLine, inventoryEmptyLine, readInventoryFilters, writeInventoryFilters, type InventoryFilters } from "./inventory-format";
import { InventoryEmpty, InventoryError, InventoryHeader, InventoryOlder, InventoryPagination, InventoryRulesSkeleton, inventoryText } from "./inventory-parts";
import { InventoryRows, InventoryRowsSkeleton } from "./inventory-rows";

function changeInventoryUrl(changes: Partial<InventoryFilters>) {
  const url = new URL(window.location.href);
  const current = readInventoryFilters(url.searchParams);
  writeInventoryFilters(url.searchParams, { ...current, ...changes });
  window.history.replaceState(null, "", url);
}

function InventoryFilter({ search }: { search: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [previousSearch, setPreviousSearch] = useState(search);
  if (search !== previousSearch) {
    setPreviousSearch(search);
    setDraft(null);
  }
  useEffect(() => {
    if (draft === null || draft === search) return;
    const timeout = window.setTimeout(() => changeInventoryUrl({ search: draft, page: 1, computer: "" }), 300);
    return () => window.clearTimeout(timeout);
  }, [draft, search]);
  return <FilterInput className="my-3 w-64 max-w-full" placeholder="Filter by name or owner" value={draft ?? search} onChange={(value) => setDraft(value.slice(0, 160))} />;
}

function DesktopsTabHook() { return <span aria-hidden="true" className="absolute inset-0" data-testid="computer-inventory-tab-desktops" />; }
function CloudTabHook() { return <span aria-hidden="true" className="absolute inset-0" data-testid="computer-inventory-tab-cloud" />; }
function AttentionTabHook() { return <span aria-hidden="true" className="absolute inset-0" data-testid="computer-inventory-tab-attention" />; }
function FormerTabHook() { return <span aria-hidden="true" className="absolute inset-0" data-testid="computer-inventory-tab-former" />; }

const TAB_HOOKS: Record<OrganizationComputerInventoryTab, typeof DesktopsTabHook> = {
  desktops: DesktopsTabHook, cloud: CloudTabHook, attention: AttentionTabHook, former: FormerTabHook,
};

export function OrganizationInventoryScreen({ scope, orgSlug, canDisconnect }: { scope: InventoryScope; orgSlug: string | null; canDisconnect: boolean }) {
  const filters = readInventoryFilters(useSearchParams());
  const query = useOrganizationInventory(scope, filters);
  const refresh = useRefreshInventory(scope);
  const data = query.isPlaceholderData ? undefined : query.data;
  const metadata = query.data;
  const now = Date.now();
  const close = () => changeInventoryUrl({ computer: "" });
  const onRemoved = (id: string) => {
    if (readInventoryFilters(new URLSearchParams(window.location.search)).computer === id) close();
  };
  const { actionsFor, removeSignIn } = useInventoryActions(scope, onRemoved);
  const tabs = ORGANIZATION_COMPUTER_INVENTORY_TABS.map((tab) => ({ value: tab, label: INVENTORY_TAB_LABELS[tab], count: metadata?.counts[tab], icon: TAB_HOOKS[tab] }));
  const openOutsideList = filters.computer && data && !data.computers.some((row) => row.id === filters.computer);

  return <section className={`min-w-0 ${inventoryText}`} data-testid="computer-inventory" aria-busy={query.isFetching}>
    <InventoryHeader title="Computers" refreshing={query.isFetching} onRefresh={() => void refresh()} />
    {metadata ? <p className={`mb-4 ${secondaryText}`} data-testid="computer-inventory-rules">
      {computerRulesLine(metadata.rules)}{" "}<Link href={`${getOrgSettingsRoute(orgSlug)}#computers`} className={`underline underline-offset-2 ${focusRing}`}>Change rules</Link>
    </p> : query.isPending ? <InventoryRulesSkeleton /> : null}
    <UnderlineTabs activeTab={filters.tab} tabs={tabs} showZeroCounts className="[&_[role=tab]]:relative"
      onChange={(tab) => { if (tab !== filters.tab) changeInventoryUrl({ tab, page: 1, computer: "" }); }} />
    <InventoryFilter search={filters.search} />
    {query.error ? <InventoryError message={query.error.message} stale={data ? "Showing the last known list." : undefined} checkedAt={query.dataUpdatedAt} onRetry={() => void query.refetch()} /> : null}
    {openOutsideList ? <div className={`mb-3 border-y py-3 ${hairline}`}>
      <InventoryDetail id={filters.computer} scope={scope} onClose={close} onRemoved={onRemoved} canDisconnect={canDisconnect} now={now} />
    </div> : null}
    {data ? data.computers.length ? <InventoryRows admin rows={data.computers} now={now} openId={filters.computer}
      onToggle={(id) => changeInventoryUrl({ computer: filters.computer === id ? "" : id })}
      rowAction={(row) => row.owner?.former && row.canRemove ? <ComputerMenu idPrefix="computer-inventory" id={row.id}
        set={{ ...actionsFor(row, data.mergedSignIns), actions: ["remove"] }} /> : null}
      detail={(row) => <InventoryDetail id={row.id} scope={scope} onRemoved={onRemoved} canDisconnect={canDisconnect} now={now} />} />
      : <InventoryEmpty>{inventoryEmptyLine(filters)}</InventoryEmpty> : query.isPending || query.isPlaceholderData ? <InventoryRowsSkeleton admin /> : null}
    {data ? <>
      <InventoryMergedSignIns key={filters.tab} signIns={data.mergedSignIns} now={now} onRemove={removeSignIn} />
      <InventoryOlder hidden={data.olderHidden} shown={filters.older} onToggle={() => changeInventoryUrl({ older: !filters.older, page: 1, computer: "" })} />
      <InventoryPagination page={data.page} pageSize={data.pageSize} total={data.total} busy={query.isFetching}
        onPage={(page) => changeInventoryUrl({ page, computer: "" })} />
    </> : null}
  </section>;
}
