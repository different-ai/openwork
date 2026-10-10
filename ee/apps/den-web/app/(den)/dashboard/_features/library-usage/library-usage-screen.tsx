"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Activity, Blocks, CircleOff, Plus, TriangleAlert, Zap } from "lucide-react";
import { DenBrandMark } from "../../../_components/ui/brand-mark";
import { DenButton } from "../../../_components/ui/button";
import { DenNotice } from "../../../_components/ui/notice";
import { DenSegmented } from "../../../_components/ui/segmented";
import { DenSkeleton } from "../../../_components/ui/skeleton";
import { getAddConnectorRoute, getMcpConnectionRoute, getNewPluginRoute, getPluginRoute, getPluginSkillRoute } from "../../../_lib/den-org";
import { FilterInput, ItemRowsSkeleton } from "../../_components/item-list";
import { brandHintFor, LetterTile } from "../../_components/item-logo";
import { useOrgDashboard } from "../../_providers/org-dashboard-provider";
import { AnalyticsEmptyState, AnalyticsErrorState, AnalyticsPageHeader, analyticsPageClass, analyticsSurfaceClass } from "../analytics/analytics-layout";
import { StatCard } from "../analytics/stat-card";
import {
  countingSinceLabel,
  failureLabel,
  filterLibraryUsage,
  lastUsedLabel,
  libraryUsageCopy,
  libraryUsageKinds,
  libraryUsageWindows,
  parseLibraryUsageKind,
  parseLibraryUsageWindow,
  summarizeLibraryUsage,
  type LibraryUsageFilter,
  type LibraryUsageKind,
  type LibraryUsageRow,
} from "./library-usage-data";
import { useLibraryUsage, useLibraryUsageAvailable } from "./use-library-usage";

// The name lane is capped so the numbers stay next to what they describe (OW-LIST-LANES).
function columnsFor(tracksFailures: boolean) {
  return tracksFailures
    ? "grid grid-cols-[minmax(0,260px)_56px_56px_72px_104px] items-center gap-4 px-5"
    : "grid grid-cols-[minmax(0,260px)_56px_56px_104px] items-center gap-4 px-5";
}

function itemHref(kind: LibraryUsageKind, row: LibraryUsageRow, orgSlug: string | null | undefined) {
  if (kind === "skills") return row.pluginId ? getPluginSkillRoute(orgSlug, row.pluginId, row.id) : null;
  if (kind === "plugins") return getPluginRoute(orgSlug, row.id);
  return getMcpConnectionRoute(orgSlug, row.id);
}

function UsageRow({ kind, row, now, tracksFailures }: { kind: LibraryUsageKind; row: LibraryUsageRow; now: number; tracksFailures: boolean }) {
  const { activeOrg } = useOrgDashboard();
  const href = itemHref(kind, row, activeOrg?.slug);
  const lastUsed = lastUsedLabel(row.lastUsedAt, now);
  const failed = failureLabel(row);
  // Usage has no provider ID or service URL: resolve only exact known names,
  // never infer a service from a custom MCP connector's name.
  const brand = kind === "connectors" ? brandHintFor(row.name) : null;
  const name = (
    <span className="flex min-w-0 items-center gap-3">
      {brand && (brand.simpleIconSlug || brand.serviceUrl)
        ? <DenBrandMark name={row.name} {...brand} className="size-8 rounded-[7px]" imageClassName="size-[18px]" />
        : <LetterTile name={row.name} />}
      <span className="min-w-0">
        <span className="block truncate font-medium text-[#07192C]" title={row.name}>{row.name}</span>
        {row.detail ? <span className="block truncate text-[12px] text-[#637291]">{row.detail}</span> : null}
      </span>
    </span>
  );
  return (
    <li className={`${columnsFor(tracksFailures)} min-h-12 py-2 text-[13px]`} data-testid="library-usage-row" data-item={row.name}>
      {href ? <Link href={href} className="min-w-0 rounded-lg focus-visible:ring-2 focus-visible:ring-gray-300">{name}</Link> : name}
      <span className="tabular-nums text-[#07192C]" data-item-uses>{row.uses.toLocaleString()}</span>
      <span className="tabular-nums text-[#637291]">{row.people.toLocaleString()}</span>
      {tracksFailures ? <span className={`tabular-nums ${(row.failures ?? 0) > 0 ? "font-medium text-[#B42318]" : "text-[#637291]"}`} data-item-failures>{failed}</span> : null}
      {lastUsed && row.lastUsedAt
        ? <time dateTime={row.lastUsedAt} title={new Date(row.lastUsedAt).toLocaleString()} className="text-[#637291]">{lastUsed}</time>
        : <span className="text-[#637291]" data-item-unused>Not used</span>}
    </li>
  );
}

function UsageLoading() {
  return (
    <>
      <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-4" aria-hidden="true">
        {[0, 1, 2, 3].map((card) => <div key={card} className={`${analyticsSurfaceClass} p-5`}><DenSkeleton className="h-3 w-24" /><DenSkeleton className="mt-4 h-7 w-16" /><DenSkeleton className="mt-3 h-2.5 w-32" /></div>)}
      </div>
      <div className={analyticsSurfaceClass}><ItemRowsSkeleton label="Loading usage" rows={5} /></div>
    </>
  );
}

function KindEmpty({ kind }: { kind: LibraryUsageKind }) {
  const { activeOrg } = useOrgDashboard();
  const copy = libraryUsageCopy[kind];
  const href = kind === "connectors" ? getAddConnectorRoute(activeOrg?.slug) : getNewPluginRoute(activeOrg?.slug);
  return (
    <div className={analyticsSurfaceClass} data-testid="library-usage-empty">
      <AnalyticsEmptyState title={copy.emptyTitle} icon={Blocks} action={<DenButton href={href}><Plus className="mr-2 h-4 w-4" aria-hidden />{copy.emptyAction}</DenButton>}>
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
  const [filter, setFilter] = useState<LibraryUsageFilter>("all");
  const [name, setName] = useState("");
  const usage = useLibraryUsage(kind, days);
  const [now] = useState(() => Date.now());
  const copy = libraryUsageCopy[kind];

  function setParam(key: "view" | "days", value: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set(key, value);
    router.replace(`?${params.toString()}`, { scroll: false });
    if (key === "view") { setFilter("all"); setName(""); }
  }

  const report = usage.data?.kind === kind ? usage.data : undefined;
  const summary = report ? summarizeLibraryUsage(report.items) : null;
  const tracksFailures = summary?.failures !== null && summary?.failures !== undefined;
  const hasFailures = (summary?.failures ?? 0) > 0;
  const rows = report ? filterLibraryUsage(report.items, filter, name) : [];
  const since = report ? countingSinceLabel(report, now) : null;
  const nothingRecorded = report ? !report.trackingSince && report.items.every((row) => row.uses === 0) : false;

  return (
    <div className={`${analyticsPageClass} min-w-0`} data-testid="library-usage">
      <AnalyticsPageHeader orgSlug={activeOrg?.slug} active="library" title="Plugins & connectors"
        caption={since ? <span data-testid="library-usage-since">{since}</span> : undefined} />

      {!available ? (
        <div className={analyticsSurfaceClass}>
          <AnalyticsEmptyState title="Usage isn't on for this workspace" icon={Blocks}>Ask OpenWork to turn on plugin and connector usage for your organization.</AnalyticsEmptyState>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2" data-testid="library-usage-toolbar">
            <DenSegmented aria-label="What to show" value={kind} onChange={(value) => setParam("view", value)} options={libraryUsageKinds.map((option) => ({ value: option, label: libraryUsageCopy[option].label }))} />
            <DenSegmented aria-label="Time range" value={String(days)} onChange={(value) => setParam("days", value)} options={libraryUsageWindows.map((window) => ({ value: String(window), label: `${window} days` }))} />
          </div>

          {usage.isPending || (!report && usage.isFetching) ? <UsageLoading /> : usage.isError && !report ? (
            <AnalyticsErrorState title={`Couldn't load ${copy.plural} usage`} onRetry={() => void usage.refetch()} retrying={usage.isFetching} />
          ) : !report || !summary ? null : summary.total === 0 ? <KindEmpty kind={kind} /> : (
            <>
              {usage.isError ? <DenNotice tone="neutral" presentation="inline" message="Couldn't refresh. Showing the last counts." action={<DenButton variant="secondary" size="sm" onClick={() => void usage.refetch()}>Retry</DenButton>} /> : null}

              {nothingRecorded ? (
                <div className={analyticsSurfaceClass} data-testid="library-usage-no-usage">
                  <AnalyticsEmptyState title="No usage yet" icon={Activity} children={null} />
                </div>
              ) : (
                <div className={`grid gap-3.5 sm:grid-cols-2 ${tracksFailures ? "lg:grid-cols-4" : "lg:grid-cols-3"}`} data-testid="library-usage-summary">
                  <StatCard icon={<Blocks className="text-[#6F3DFF]" />} tone="violet" title="In use" value={`${summary.used} of ${summary.total}`} />
                  <StatCard icon={<Zap className="text-[#1D63FF]" />} tone="blue" title="Uses" value={summary.uses.toLocaleString()} />
                  {tracksFailures ? <div role="group" aria-label="Failed uses" data-testid="library-usage-failed" data-state={hasFailures ? "attention" : "neutral"}>
                    <StatCard icon={<TriangleAlert className={hasFailures ? "text-[var(--ow-danger)]" : "text-[var(--dls-text-secondary)]"} />} tone={hasFailures ? "amber" : "neutral"} title="Failed" value={(summary.failures ?? 0).toLocaleString()} sub={summary.uses > 0 ? `${Math.round(((summary.failures ?? 0) / summary.uses) * 100)}% of uses` : "Nothing has run yet"} />
                  </div> : null}
                  <StatCard icon={<CircleOff className="text-[#B7791F]" />} tone="amber" title="Not used" value={`${summary.unused}`} />
                </div>
              )}

              {nothingRecorded ? null : <div className="flex flex-wrap items-center gap-2" data-testid="library-usage-filters">
                <FilterInput value={name} onChange={setName} className="w-[240px] max-w-full" />
                <DenSegmented aria-label={`Which ${copy.plural}`} value={filter} onChange={setFilter}
                  options={[{ value: "all", label: "All" }, { value: "unused", label: "Not used" }, ...(tracksFailures ? [{ value: "failing" as const, label: "Failing" }] : [])]} />
              </div>}

              <div className={`${analyticsSurfaceClass} min-w-0 overflow-x-auto`} data-testid="library-usage-table">
                <div className={tracksFailures ? "min-w-[660px]" : "min-w-[580px]"}>
                  <div className={`${columnsFor(tracksFailures)} py-2.5 text-[12px] text-[#637291]`} data-testid="library-usage-columns">
                    <span>{copy.label.replace(/s$/, "")}</span><span>Uses</span><span>People</span>{tracksFailures ? <span>Failed</span> : null}<span>Last used</span>
                  </div>
                  {rows.length === 0
                    ? <p className="border-t border-[#e3e7ee] px-5 py-6 text-[13px] text-[#637291]">{filter === "unused" && !name.trim() ? `Every ${copy.noun} was used in this period.` : filter === "failing" && !name.trim() ? "Nothing failed in this period." : `No ${copy.plural} match. Try another name.`}</p>
                    : <ul className="divide-y divide-[#e3e7ee] border-t border-[#e3e7ee]">{rows.map((row) => <UsageRow key={row.id} kind={kind} row={row} now={now} tracksFailures={tracksFailures} />)}</ul>}
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
