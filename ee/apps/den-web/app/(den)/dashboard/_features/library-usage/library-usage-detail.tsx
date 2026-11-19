"use client";

import { DenBrandMark } from "../../../_components/ui/brand-mark";
import { brandHintFor, LetterTile } from "../../_components/item-logo";
import { PersonLead } from "../computers/computer-parts";
import Link from "next/link";
import { ArrowLeft, FileText, Package, Plug, User, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { DenButton } from "../../../_components/ui/button";
import { DenNotice } from "../../../_components/ui/notice";
import { DenSkeleton } from "../../../_components/ui/skeleton";
import { getMcpConnectionRoute, getPluginRoute, getPluginSkillRoute } from "../../../_lib/den-org";
import { AUTOMATION_CARD_CLASS, CARD_TITLE_CLASS } from "../../../_components/ui/dashboard-styles";
import { LinkButton } from "../../_components/item-list";
import { ListRow, RowLane, RowLaneLabel, RowList, RowListHeader, RowListSkeleton } from "../computers/computer-rows";
import { useOrgDashboard } from "../../_providers/org-dashboard-provider";
import { AnalyticsEmptyState, AnalyticsErrorState, analyticsSurfaceClass } from "../analytics/analytics-layout";
import { StatCard } from "../analytics/stat-card";
import { TrendChart } from "../analytics/trend-chart";
import {
  dailyLibraryUsage,
  failureLabel,
  lastUsedLabel,
  libraryUsageCopy,
  libraryUsageMember,
  sumLibraryUsageSources,
  type LibraryUsageBreakdownRow,
  type LibraryUsageKind,
  type LibraryUsageReport,
  type LibraryUsageRow,
  type LibraryUsageWindow,
} from "./library-usage-data";
import { useLibraryUsageBreakdown } from "./use-library-usage";

/** Builds a link to another usage view from the current search params. */
export type UsageHref = (change: Record<string, string | null>) => string;

/** Fixed lanes for the usage lists, so rows line up like Computers. Literal classes, so Tailwind generates each one. */
export const USAGE_LANE = {
  uses: "w-14 tabular-nums",
  people: "hidden w-14 tabular-nums @md:block",
  failed: "hidden w-[72px] tabular-nums @lg:block",
  lastUsed: "hidden w-28 tabular-nums @2xl:block",
} as const;

/** The leading tile for a usage row: what kind of thing it is. */
export const USAGE_KIND_ICON: Record<LibraryUsageKind, LucideIcon> = { skills: FileText, plugins: Package, connectors: Plug };

/**
 * A usage row's lead lane says which item it is: the service's logo when the
 * name is a known one, otherwise its first letter. Never the same icon on every row.
 */
export function UsageItemLead({ kind, name }: { kind: LibraryUsageKind; name: string }) {
  // Usage has no provider ID or service URL: resolve only exact known names,
  // never infer a service from a custom MCP connector's name.
  const brand = kind === "connectors" || kind === "plugins" ? brandHintFor(name) : null;
  return brand && (brand.simpleIconSlug || brand.serviceUrl)
    ? <DenBrandMark name={name} {...brand} className="size-8 rounded-lg" imageClassName="size-[18px]" />
    : <LetterTile name={name} />;
}

/** A usage list's first column: "Skill", "Plugin", "Connector" or "Person". */
export function usageLead(kind: LibraryUsageKind) {
  return libraryUsageCopy[kind].label.replace(/s$/, "");
}

/** Column labels over the usage lanes. `people` is the item list's own lane. */
export function UsageListHeader({ lead, people = false, tracksFailures }: { lead: string; people?: boolean; tracksFailures: boolean }) {
  return <RowListHeader lead={lead}>
    <RowLaneLabel lane={USAGE_LANE.uses}>Uses</RowLaneLabel>
    {people ? <RowLaneLabel lane={USAGE_LANE.people}>People</RowLaneLabel> : null}
    {tracksFailures ? <RowLaneLabel lane={USAGE_LANE.failed}>Failed</RowLaneLabel> : null}
    <RowLaneLabel lane={USAGE_LANE.lastUsed}>Last used</RowLaneLabel>
  </RowListHeader>;
}

/** Uses, then people (item lists), failures (where the kind can fail) and when last used, each in its lane. */
export function UsageLanes({ row, now, tracksFailures, people }: {
  row: { uses: number; failures: number | null; lastUsedAt: string | null }; now: number; tracksFailures: boolean; people?: number;
}) {
  const lastUsed = lastUsedLabel(row.lastUsedAt, now);
  return <>
    <RowLane lane={USAGE_LANE.uses}><span data-item-uses className="text-[var(--dls-text-primary)]">{row.uses.toLocaleString()}</span></RowLane>
    {people !== undefined ? <RowLane lane={USAGE_LANE.people} className="text-[var(--dls-text-secondary)]">{people.toLocaleString()}</RowLane> : null}
    {tracksFailures ? <RowLane lane={USAGE_LANE.failed}>
      <span data-item-failures className={(row.failures ?? 0) > 0 ? "font-medium text-[var(--ow-danger)]" : "text-[var(--dls-text-secondary)]"}>{failureLabel({ failures: row.failures ?? 0, uses: row.uses })}</span>
    </RowLane> : null}
    <RowLane lane={USAGE_LANE.lastUsed} className="truncate text-[var(--dls-text-secondary)]">
      {lastUsed && row.lastUsedAt ? <time dateTime={row.lastUsedAt} title={new Date(row.lastUsedAt).toLocaleString()}>{lastUsed}</time> : <span data-item-unused>Not used</span>}
    </RowLane>
  </>;
}

/** A usage list that is loading: rows the size of the real ones. */
export function UsageRowsLoading({ label, rows = 3 }: { label: string; rows?: number }) {
  return <div role="status" aria-label={label}><RowListSkeleton rows={rows} /></div>;
}

/** Where the item is managed: its Library page, or its Connectors page. */
export function libraryItemHref(kind: LibraryUsageKind, row: Pick<LibraryUsageRow, "id" | "pluginId">, orgSlug: string | null | undefined) {
  if (kind === "skills") return row.pluginId ? getPluginSkillRoute(orgSlug, row.pluginId, row.id) : null;
  if (kind === "plugins") return getPluginRoute(orgSlug, row.id);
  return getMcpConnectionRoute(orgSlug, row.id);
}

function DetailHeading({ backHref, backLabel, title, action, testId }: { backHref: string; backLabel: string; title: string; action?: ReactNode; testId: string }) {
  return <div className="flex flex-wrap items-center justify-between gap-3" data-testid={testId}>
    <div className="flex min-w-0 items-center gap-2">
      <Link href={backHref} aria-label={backLabel} title={backLabel} className="rounded-lg p-2 text-[var(--dls-text-secondary)] outline-none hover:bg-[var(--dls-hover)] hover:text-[var(--dls-text-primary)] focus-visible:ring-2 focus-visible:ring-gray-300">
        <ArrowLeft className="h-4 w-4" aria-hidden />
      </Link>
      <h2 className="truncate text-[16px] font-semibold tracking-[-0.01em] text-[var(--dls-text-primary)]">{title}</h2>
    </div>
    {action}
  </div>;
}

/** The rows of a list that is loading, flat like the list it will become. */
function ListLoading({ label }: { label: string }) {
  return <UsageRowsLoading label={label} />;
}

/** Stat cards that are loading, in the grid the real cards will fill. */
function StatsLoading({ cards }: { cards: number }) {
  return <div className={`grid gap-3 sm:grid-cols-2 ${cards === 4 ? "lg:grid-cols-4" : cards === 3 ? "lg:grid-cols-3" : ""}`} aria-hidden="true">
    {Array.from({ length: cards }, (_, card) => <div key={card} className={`${AUTOMATION_CARD_CLASS} p-4`}><DenSkeleton className="h-3 w-24" /><DenSkeleton className="mt-3 h-7 w-16" /></div>)}
  </div>;
}

/** The chart's frame with a placeholder where the bars will be, never loading prose. */
function ChartLoading() {
  return <div className={`${AUTOMATION_CARD_CLASS} p-4`} role="status" aria-label="Loading uses per day" data-testid="library-usage-daily-loading">
    <DenSkeleton className="h-3.5 w-24" /><DenSkeleton className="mt-2 h-3 w-20" />
    <DenSkeleton className="mt-4 h-[168px] w-full" />
    <div className="mt-3 flex justify-between"><DenSkeleton className="h-2.5 w-10" /><DenSkeleton className="h-2.5 w-10" /></div>
  </div>;
}

/** Kept counts with a way to try again when a refresh fails; the last rows stay on screen. */
function RefreshFailed({ onRetry }: { onRetry: () => void }) {
  return <DenNotice tone="neutral" presentation="inline" message="Couldn't refresh. Showing the last counts." action={<DenButton variant="secondary" size="sm" onClick={onRetry}>Retry</DenButton>} />;
}

/** Uses per UTC day, with failures beside them where the kind can fail. */
function DailyUses({ kind, days, scope }: { kind: LibraryUsageKind; days: LibraryUsageWindow; scope: { itemId: string } | { memberId: string } }) {
  const daily = useLibraryUsageBreakdown(kind, days, "day", scope);
  if (daily.isError && !daily.data) return <AnalyticsErrorState title="Couldn't load uses per day" onRetry={() => void daily.refetch()} retrying={daily.isFetching} />;
  if (!daily.data) return <ChartLoading />;
  const points = dailyLibraryUsage(daily.data);
  const failed = kind !== "skills" && points.some((point) => point.failures > 0);
  return <div data-testid="library-usage-daily">
    <TrendChart title="Uses per day" subtitle={`Last ${days} days`} intervalLabel=""
      weeks={points.map((point) => ({ weekStart: point.date }))}
      series={[{ label: "Uses", values: points.map((point) => point.uses) }, ...(failed ? [{ label: "Failed", values: points.map((point) => point.failures) }] : [])]} />
  </div>;
}

/** What started the uses: agents, Workflows, Automations, Apps or live views. */
function StartedBy({ rows }: { rows: readonly LibraryUsageBreakdownRow[] }) {
  const sources = sumLibraryUsageSources(rows);
  if (sources.length === 0) return null;
  return <section className={`${AUTOMATION_CARD_CLASS} p-4`} aria-label="Started by" data-testid="library-usage-sources">
    <h3 className={CARD_TITLE_CLASS}>Started by</h3>
    <ul className="mt-2 divide-y divide-[var(--den-list-line)]">
      {sources.map((entry) => <li key={entry.source} data-source={entry.source} className="flex items-center justify-between gap-4 py-2 text-[13px]">
        <span className="text-[var(--dls-text-primary)]">{entry.label}</span>
        <span className="tabular-nums text-[var(--dls-text-secondary)]">{entry.uses.toLocaleString()}</span>
      </li>)}
    </ul>
  </section>;
}

/** One skill, plugin or connector: who uses it, how often per day, and what started the uses. */
export function ItemUsageDetail({ kind, days, item, now, usageHref }: {
  kind: LibraryUsageKind; days: LibraryUsageWindow; item: LibraryUsageRow; now: number; usageHref: UsageHref;
}) {
  const { activeOrg, orgContext } = useOrgDashboard();
  const copy = libraryUsageCopy[kind];
  const people = useLibraryUsageBreakdown(kind, days, "member", { itemId: item.id });
  const tracksFailures = item.failures !== null;
  const manageHref = libraryItemHref(kind, item, activeOrg?.slug);
  const members = orgContext?.members ?? [];
  const lastUsed = lastUsedLabel(item.lastUsedAt, now);

  return <section className="grid gap-6" data-testid="library-usage-item" data-item={item.name}>
    <DetailHeading testId="library-usage-item-heading" backHref={usageHref({ item: null, member: null })} backLabel={`All ${copy.plural}`} title={item.name}
      action={manageHref ? <LinkButton href={manageHref} size="sm">{kind === "connectors" ? "Open connector" : "Open in Library"}</LinkButton> : undefined} />

    <div className={`grid gap-3 sm:grid-cols-2 ${tracksFailures ? "lg:grid-cols-4" : "lg:grid-cols-3"}`} data-testid="library-usage-item-summary">
      <StatCard title="Uses" value={item.uses.toLocaleString()} />
      <StatCard title="People" value={item.people.toLocaleString()} />
      {tracksFailures ? <StatCard attention={(item.failures ?? 0) > 0} title="Failed" value={(item.failures ?? 0).toLocaleString()} /> : null}
      <StatCard title="Last used" value={lastUsed ?? "Not used"} />
    </div>

    {item.uses === 0 ? (
      <div className={analyticsSurfaceClass}><AnalyticsEmptyState title={`Nobody used this ${copy.noun} in the last ${days} days`} /></div>
    ) : <>
      {people.isError && !people.data ? <AnalyticsErrorState title="Couldn't load who uses it" onRetry={() => void people.refetch()} retrying={people.isFetching} />
        : !people.data ? <><ListLoading label="Loading who uses it" /><ChartLoading /></>
        : <>
          {people.isError ? <RefreshFailed onRetry={() => void people.refetch()} /> : null}
          <RowList label={`Who uses ${item.name}`} testId="library-usage-people" header={<UsageListHeader lead="Person" tracksFailures={tracksFailures} />}>
            {people.data.rows.map((row) => {
              const person = libraryUsageMember(members, row.memberId);
              return <div role="presentation" key={row.memberId ?? "former"} data-testid="library-usage-person" data-person={person.name}>
                <ListRow lead={<PersonLead name={person.name} />} name={person.name} secondLine={person.email}
                  href={row.memberId ? usageHref({ member: row.memberId, item: null }) : undefined}
                  lanes={<UsageLanes row={row} now={now} tracksFailures={tracksFailures} />} />
              </div>;
            })}
          </RowList>
          <DailyUses kind={kind} days={days} scope={{ itemId: item.id }} />
          <StartedBy rows={people.data.rows} />
        </>}
    </>}
  </section>;
}

/** One person: which skills, plugins or connectors they used, how often per day, and what started the uses. */
export function PersonUsageDetail({ kind, days, memberId, report, now, usageHref }: {
  kind: LibraryUsageKind; days: LibraryUsageWindow; memberId: string; report: LibraryUsageReport; now: number; usageHref: UsageHref;
}) {
  const { orgContext } = useOrgDashboard();
  const copy = libraryUsageCopy[kind];
  const person = libraryUsageMember(orgContext?.members ?? [], memberId);
  const items = useLibraryUsageBreakdown(kind, days, "item", { memberId });
  const tracksFailures = kind !== "skills";
  const names = new Map(report.items.map((entry) => [entry.id, entry]));
  const rows = items.data?.rows ?? [];
  const uses = rows.reduce((sum, row) => sum + row.uses, 0);
  const failures = rows.reduce((sum, row) => sum + (row.failures ?? 0), 0);

  return <section className="grid gap-6" data-testid="library-usage-member" data-person={person.name}>
    <DetailHeading testId="library-usage-member-heading" backHref={usageHref({ member: null, item: null })} backLabel={`All ${copy.plural}`} title={person.name} />

    {items.isError && !items.data ? <AnalyticsErrorState title={`Couldn't load ${person.name}'s usage`} onRetry={() => void items.refetch()} retrying={items.isFetching} />
      : !items.data ? <><StatsLoading cards={tracksFailures ? 3 : 2} /><ListLoading label={`Loading ${person.name}'s usage`} /><ChartLoading /></>
      : <>
        {items.isError ? <RefreshFailed onRetry={() => void items.refetch()} /> : null}
        <div className={`grid gap-3 sm:grid-cols-2 ${tracksFailures ? "lg:grid-cols-3" : "lg:grid-cols-2"}`} data-testid="library-usage-member-summary">
          <StatCard title={`${copy.label} used`} value={`${rows.length} of ${report.items.length}`} />
          <StatCard title="Uses" value={uses.toLocaleString()} />
          {tracksFailures ? <StatCard attention={failures > 0} title="Failed" value={failures.toLocaleString()} /> : null}
        </div>
        {rows.length === 0 ? (
          <div className={analyticsSurfaceClass}><AnalyticsEmptyState title={`${person.name} used no ${copy.plural} in the last ${days} days`} /></div>
        ) : <>
          <RowList label={`${copy.label} ${person.name} used`} testId="library-usage-member-items" header={<UsageListHeader lead={usageLead(kind)} tracksFailures={tracksFailures} />}>
            {rows.map((row) => {
              const item = row.itemId ? names.get(row.itemId) : undefined;
              const name = item?.name ?? `Removed ${copy.noun}`;
              return <div role="presentation" key={row.itemId ?? "removed"} data-testid="library-usage-member-item" data-item={name}>
                <ListRow lead={<UsageItemLead kind={kind} name={name} />} name={name} secondLine={item?.detail ?? undefined}
                  href={item ? usageHref({ item: item.id, member: null }) : undefined}
                  lanes={<UsageLanes row={row} now={now} tracksFailures={tracksFailures} />} />
              </div>;
            })}
          </RowList>
          <DailyUses kind={kind} days={days} scope={{ memberId }} />
          <StartedBy rows={rows} />
        </>}
      </>}
  </section>;
}
