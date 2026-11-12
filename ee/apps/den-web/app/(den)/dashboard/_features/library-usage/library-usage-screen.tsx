"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Plus } from "lucide-react";
import { DenButton } from "../../../_components/ui/button";
import { DenNotice } from "../../../_components/ui/notice";
import { DenSegmented } from "../../../_components/ui/segmented";
import { DenSkeleton } from "../../../_components/ui/skeleton";
import { getAddConnectorRoute, getNewPluginRoute } from "../../../_lib/den-org";
import { AUTOMATION_CARD_CLASS } from "../../../_components/ui/dashboard-styles";
import { FilterInput } from "../../_components/item-list";
import { ListRow, RowList } from "../computers/computer-rows";
import { useOrgDashboard } from "../../_providers/org-dashboard-provider";
import { libraryUsageIntroFacts } from "../../_components/analytics-intro-facts";
import { useFeatureIntro } from "../feature-intros";
import { AnalyticsEmptyState, AnalyticsErrorState, AnalyticsPageHeader, analyticsPageClass, analyticsSurfaceClass } from "../analytics/analytics-layout";
import { StatCard } from "../analytics/stat-card";
import {
  countingSinceLabel,
  filterLibraryUsage,
  libraryUsageCopy,
  libraryUsageKinds,
  libraryUsageWindows,
  parseLibraryUsageFocus,
  parseLibraryUsageKind,
  parseLibraryUsageWindow,
  summarizeLibraryUsage,
  type LibraryUsageFilter,
  type LibraryUsageKind,
  type LibraryUsageRow,
} from "./library-usage-data";
import { ItemUsageDetail, PersonUsageDetail, UsageItemLead, UsageLanes, UsageListHeader, UsageRowsLoading, usageLead, type UsageHref } from "./library-usage-detail";
import { useLibraryUsage, useLibraryUsageAvailable } from "./use-library-usage";

/** A row opens the item's usage: who uses it and how often; that page links to where it is managed. */
function UsageRow({ kind, row, now, tracksFailures, usageHref }: { kind: LibraryUsageKind; row: LibraryUsageRow; now: number; tracksFailures: boolean; usageHref: UsageHref }) {
  return <div role="presentation" data-testid="library-usage-row" data-item={row.name} data-analytics-row>
    <ListRow lead={<UsageItemLead kind={kind} name={row.name} />} name={row.name} secondLine={row.detail} href={usageHref({ item: row.id, member: null })}
      lanes={<UsageLanes row={row} now={now} tracksFailures={tracksFailures} people={row.people} />} />
  </div>;
}

/** Skeleton in the destination's layout: the same number of stat cards, then its list. */
function UsageLoading({ cards = 4 }: { cards?: number }) {
  return (
    <>
      <div className={`grid gap-3 sm:grid-cols-2 ${cards === 4 ? "lg:grid-cols-4" : cards === 3 ? "lg:grid-cols-3" : ""}`} aria-hidden="true">
        {Array.from({ length: cards }, (_, card) => card).map((card) => <div key={card} className={`${AUTOMATION_CARD_CLASS} p-4`}><DenSkeleton className="h-3 w-24" /><DenSkeleton className="mt-3 h-7 w-16" /><DenSkeleton className="mt-2 h-2.5 w-32" /></div>)}
      </div>
      <UsageRowsLoading label="Loading usage" rows={5} />
    </>
  );
}

function KindEmpty({ kind }: { kind: LibraryUsageKind }) {
  const { activeOrg } = useOrgDashboard();
  const copy = libraryUsageCopy[kind];
  const href = kind === "connectors" ? getAddConnectorRoute(activeOrg?.slug) : getNewPluginRoute(activeOrg?.slug);
  return (
    <div className={analyticsSurfaceClass} data-testid="library-usage-empty">
      <AnalyticsEmptyState title={copy.emptyTitle} action={<DenButton href={href}><Plus className="mr-2 h-4 w-4" aria-hidden />{copy.emptyAction}</DenButton>}>
        {copy.emptyBody}
      </AnalyticsEmptyState>
    </div>
  );
}

export function LibraryUsageScreen() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { activeOrg } = useOrgDashboard();
  const available = useLibraryUsageAvailable();
  const kind = parseLibraryUsageKind(searchParams.get("view"));
  const days = parseLibraryUsageWindow(searchParams.get("days"));
  const focus = parseLibraryUsageFocus(searchParams);
  const [filter, setFilter] = useState<LibraryUsageFilter>("all");
  const [name, setName] = useState("");
  const usage = useLibraryUsage(kind, days);
  const [now] = useState(() => Date.now());
  const copy = libraryUsageCopy[kind];

  function setParam(key: "view" | "days", value: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set(key, value);
    // An item belongs to one kind; switching kinds goes back to its list.
    if (key === "view") params.delete("item");
    router.replace(`?${params.toString()}`, { scroll: false });
    if (key === "view") { setFilter("all"); setName(""); }
  }

  /** Drill-down links keep the kind and range, so Back returns to the same list. */
  const usageHref: UsageHref = (change) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("view", kind);
    for (const [key, value] of Object.entries(change)) {
      if (value === null) params.delete(key);
      else params.set(key, value);
    }
    return `?${params.toString()}`;
  };

  const report = usage.data?.kind === kind ? usage.data : undefined;
  const summary = report ? summarizeLibraryUsage(report.items) : null;
  const tracksFailures = summary?.failures !== null && summary?.failures !== undefined;
  const hasFailures = (summary?.failures ?? 0) > 0;
  const rows = report ? filterLibraryUsage(report.items, filter, name) : [];
  const since = report ? countingSinceLabel(report, now) : null;
  const nothingRecorded = report ? !report.trackingSince && report.items.every((row) => row.uses === 0) : false;
  const focusedItem = report && focus && "itemId" in focus ? report.items.find((row) => row.id === focus.itemId) ?? null : null;
  // With `featureIntros` on, the list view gets a box in place of "No {kind} yet" and a banner
  // instead of "No usage yet". Drill-downs (one item or person) never show it.
  const intro = useFeatureIntro("analytics.library", focus ? null : libraryUsageIntroFacts(kind, report));
  const introBanner = intro.size === "banner";

  return (
    <div className={`${analyticsPageClass} min-w-0`} data-testid="library-usage">
      <AnalyticsPageHeader orgSlug={activeOrg?.slug} active="library" title="Plugins & connectors"
        caption={since ? <span data-testid="library-usage-since">{since}</span> : undefined} />

      {!available ? (
        <div className={analyticsSurfaceClass}>
          <AnalyticsEmptyState title="Usage isn't available to you">Ask an admin for access to usage analytics.</AnalyticsEmptyState>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2" data-testid="library-usage-toolbar">
            {focus && "itemId" in focus ? <span /> : <DenSegmented aria-label="What to show" value={kind} onChange={(value) => setParam("view", value)} options={libraryUsageKinds.map((option) => ({ value: option, label: libraryUsageCopy[option].label }))} />}
            <DenSegmented aria-label="Time range" value={String(days)} onChange={(value) => setParam("days", value)} options={libraryUsageWindows.map((window) => ({ value: String(window), label: `${window} days` }))} />
          </div>

          {usage.isPending || (!report && usage.isFetching) ? <UsageLoading cards={focus && "memberId" in focus ? (kind === "skills" ? 2 : 3) : kind === "skills" ? 3 : 4} /> : usage.isError && !report ? (
            <AnalyticsErrorState title={`Couldn't load ${copy.plural} usage`} onRetry={() => void usage.refetch()} retrying={usage.isFetching} />
          ) : !report || !summary ? null : focus && "memberId" in focus ? (
            <PersonUsageDetail kind={kind} days={days} memberId={focus.memberId} report={report} now={now} usageHref={usageHref} />
          ) : focus && "itemId" in focus ? (focusedItem
            ? <ItemUsageDetail kind={kind} days={days} item={focusedItem} now={now} usageHref={usageHref} />
            : <div className={analyticsSurfaceClass} data-testid="library-usage-item-missing">
              <AnalyticsEmptyState title={`This ${copy.noun} is no longer in your library`} action={<DenButton variant="secondary" href={usageHref({ item: null })}>{`All ${copy.plural}`}</DenButton>} />
            </div>
          ) : intro.size === "box" || intro.size === "fullscreen" ? intro.element : summary.total === 0 ? <KindEmpty kind={kind} /> : (
            <>
              {introBanner ? intro.element : null}
              {usage.isError ? <DenNotice tone="neutral" presentation="inline" message="Couldn't refresh. Showing the last counts." action={<DenButton variant="secondary" size="sm" onClick={() => void usage.refetch()}>Retry</DenButton>} /> : null}

              {nothingRecorded ? (introBanner ? null : (
                <div className={analyticsSurfaceClass} data-testid="library-usage-no-usage">
                  <AnalyticsEmptyState title="No usage yet" />
                </div>
              )) : (
                <div className={`grid gap-3 sm:grid-cols-2 ${tracksFailures ? "lg:grid-cols-4" : "lg:grid-cols-3"}`} data-testid="library-usage-summary">
                  <StatCard title="In use" value={`${summary.used} of ${summary.total}`} />
                  <StatCard title="Uses" value={summary.uses.toLocaleString()} />
                  {tracksFailures ? <div role="group" aria-label="Failed uses" data-testid="library-usage-failed" data-state={hasFailures ? "attention" : "neutral"}>
                    <StatCard attention={hasFailures} title="Failed" value={(summary.failures ?? 0).toLocaleString()} sub={summary.uses > 0 ? `${Math.round(((summary.failures ?? 0) / summary.uses) * 100)}% of uses` : "Nothing has run yet"} />
                  </div> : null}
                  <StatCard title="Not used" value={`${summary.unused}`} />
                </div>
              )}

              {nothingRecorded ? null : <div className="flex flex-wrap items-center gap-2" data-testid="library-usage-filters">
                <FilterInput value={name} onChange={setName} className="w-[240px] max-w-full" />
                <DenSegmented aria-label={`Which ${copy.plural}`} value={filter} onChange={setFilter}
                  options={[{ value: "all", label: "All" }, { value: "unused", label: "Not used" }, ...(tracksFailures ? [{ value: "failing" as const, label: "Failing" }] : [])]} />
              </div>}

              <RowList label={`${copy.label} usage`} testId="library-usage-table"
                header={<div role="presentation" data-testid="library-usage-columns"><UsageListHeader lead={usageLead(kind)} people tracksFailures={tracksFailures} /></div>}>
                {rows.length === 0
                  ? <div role="row"><p role="cell" className="border-b border-[var(--den-list-line)] py-6 text-[13px] text-[var(--dls-text-secondary)]">{filter === "unused" && !name.trim() ? `Every ${copy.noun} was used in this period.` : filter === "failing" && !name.trim() ? "Nothing failed in this period." : `No ${copy.plural} match. Try another name.`}</p></div>
                  : rows.map((row) => <UsageRow key={row.id} kind={kind} row={row} now={now} tracksFailures={tracksFailures} usageHref={usageHref} />)}
              </RowList>
            </>
          )}
        </>
      )}
    </div>
  );
}
