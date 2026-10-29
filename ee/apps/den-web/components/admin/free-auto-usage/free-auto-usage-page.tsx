"use client";

import { useSearchParams } from "next/navigation";
import { AdminAccessScreen } from "../admin-access-screen";
import { AdminDeferredContent } from "../admin-deferred-content";
import { Download, RefreshCw, Search } from "lucide-react";
import { lazy, Suspense, useMemo, useState, type ReactNode } from "react";
import { DenBadge } from "../../../app/(den)/_components/ui/badge";
import { DenButton } from "../../../app/(den)/_components/ui/button";
import { DenCard } from "../../../app/(den)/_components/ui/card";
import { DenInput } from "../../../app/(den)/_components/ui/input";
import { DenNotice } from "../../../app/(den)/_components/ui/notice";
import { DenPageHeader } from "../../../app/(den)/_components/ui/page-header";
import { DenSegmented } from "../../../app/(den)/_components/ui/segmented";
import { DenSelect } from "../../../app/(den)/_components/ui/select";
import { DenTable, type DenTableColumn } from "../../../app/(den)/_components/ui/table";
import {
  FREE_AUTO_RANGES,
  organizationsCsv,
  selectOrganizations,
  useFreeAutoUsage,
  type FreeAutoOrganizationUsage,
  type FreeAutoRange,
  type FreeAutoUsageReport,
  type OrganizationSort,
} from "./free-auto-usage-data";
import { formatCount, formatRelative, formatShare, formatTokens, formatUsd } from "./format";

const FreeAutoConversions = lazy(() => import("./conversions").then((module) => ({ default: module.FreeAutoConversions })));
const FreeAutoSpendChart = lazy(() => import("./spend-chart"));
const SORTS: Array<{ value: OrganizationSort; label: string }> = [
  { value: "spend", label: "Spend" },
  { value: "requests", label: "Requests" },
  { value: "people", label: "Active people" },
  { value: "limit", label: "At weekly limit" },
  { value: "recent", label: "Last used" },
];

function Stat({ label, value, detail }: { label: string; value: ReactNode; detail?: ReactNode }) {
  return (
    <DenCard className="flex min-w-0 flex-col gap-1 !rounded-lg !p-5">
      <p className="text-[12px] font-medium uppercase tracking-[0.06em] text-gray-500">{label}</p>
      <p className="text-[26px] font-medium leading-8 tracking-[-0.5px] text-gray-900 tabular-nums">{value}</p>
      {detail ? <p className="text-[13px] leading-5 text-gray-500">{detail}</p> : null}
    </DenCard>
  );
}

function Section({ title, description, action, children }: { title: string; description?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <DenCard className="flex min-w-0 flex-col gap-5 !rounded-lg">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-[16px] font-medium text-gray-900">{title}</h2>
          {description ? <p className="mt-1 max-w-3xl text-[13px] leading-5 text-gray-500">{description}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </DenCard>
  );
}

function downloadCsv(report: FreeAutoUsageReport) {
  const blob = new Blob([organizationsCsv(report)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `free-auto-usage-${report.range.days}d-${report.generatedAt.slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function organizationColumns(now: number): DenTableColumn<FreeAutoOrganizationUsage>[] {
  return [
    {
      key: "organization", header: "Organization", render: (row) => (
        <div className="min-w-[12rem]">
          <p className="font-medium text-gray-900">{row.name}</p>
          {row.subscribed ? <div className="mt-1 flex flex-wrap items-center gap-1.5"><DenBadge tone="info">Pays for Models</DenBadge></div> : null}
        </div>
      ),
    },
    { key: "people", header: "Active / members", align: "right", render: (row) => <span className="tabular-nums">{formatCount(row.activePeople)} / {formatCount(row.memberCount)}</span> },
    {
      key: "requests", header: "Requests", align: "right", render: (row) => (
        <span className="tabular-nums">
          {formatCount(row.requests)}
          {row.estimatedRequests ? <span className="block text-[12px] text-gray-400">{formatCount(row.estimatedRequests)} estimated</span> : null}
        </span>
      ),
    },
    {
      key: "tokens", header: "Tokens in / out", align: "right", render: (row) => (
        <span className="tabular-nums">
          {formatTokens(row.inputTokens)} / {formatTokens(row.outputTokens)}
          {row.cachedInputTokens ? <span className="block text-[12px] text-gray-400">{formatShare(row.cachedInputTokens, row.inputTokens)} of input cached</span> : null}
        </span>
      ),
    },
    {
      key: "spend", header: "Spend", align: "right", render: (row) => (
        <span className="tabular-nums font-medium text-gray-900">
          {formatUsd(row.costMicroUsd)}
          {row.activePeople ? <span className="block text-[12px] font-normal text-gray-400">{formatUsd(Math.round(row.costMicroUsd / row.activePeople))} per person</span> : null}
        </span>
      ),
    },
    {
      key: "limit", header: "At weekly limit", align: "right", render: (row) => row.peopleAtWeeklyLimit
        ? <DenBadge tone="warning">{formatCount(row.peopleAtWeeklyLimit)} {row.peopleAtWeeklyLimit === 1 ? "person" : "people"}</DenBadge>
        : <span className="text-gray-400">—</span>,
    },
    {
      key: "last", header: "Last used", align: "right", render: (row) => (
        <span className="whitespace-nowrap text-gray-500" title={row.lastUsedAt ?? undefined}>{formatRelative(row.lastUsedAt, now)}</span>
      ),
    },
  ];
}

function Report({ report, refreshKey }: { report: FreeAutoUsageReport; refreshKey: number }) {
  const params = useSearchParams();
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<OrganizationSort>("spend");
  const rows = useMemo(() => selectOrganizations(report.organizations, { search, sort }), [report.organizations, search, sort]);
  const now = Date.parse(report.generatedAt);
  const { totals, members, guests, week, settings } = report;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-2" aria-label="Free Auto settings">
        <DenBadge tone={settings.membersEnabled ? "success" : "neutral"}>Members {settings.membersEnabled ? "on" : "off"}</DenBadge>
        <DenBadge>{formatUsd(settings.weeklyLimitMicroUsd)} a week per person</DenBadge>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Free spend" value={formatUsd(totals.costMicroUsd)} detail={`Members ${formatUsd(members.costMicroUsd)} · Guests ${formatUsd(guests.costMicroUsd)}`} />
        <Stat label="Requests" value={formatCount(totals.requests)} detail={`${formatShare(totals.estimatedRequests, totals.requests)} charged the estimate`} />
        <Stat label="Active people" value={formatCount(members.activePeople)} detail={`Signed in, across ${formatCount(totals.activeOrganizations)} organizations`} />
        <Stat label="At weekly limit" value={formatCount(week.peopleAtWeeklyLimit)} detail={`of ${formatCount(week.activePeople)} active this week`} />
      </div>

      <AdminDeferredContent label="Show activity after the free limit" placeholderClassName="h-96" eager={params.has("conversionStage") || params.has("search") || params.has("page")}>
        {() => <Suspense fallback={<div className="h-96 bg-slate-50" aria-busy="true" aria-label="Loading conversion activity" />}><FreeAutoConversions days={report.range.days} refreshKey={refreshKey} /></Suspense>}
      </AdminDeferredContent>

      <Section title="Daily spend" description="What free Auto cost each UTC day, split between signed-in members and signed-out desktops.">
        <AdminDeferredContent label="Show daily free Auto spend" placeholderClassName="h-64">
          {() => <Suspense fallback={<div className="h-64 bg-slate-50" aria-busy="true" aria-label="Loading daily spend chart" />}><FreeAutoSpendChart daily={report.daily} /></Suspense>}
        </AdminDeferredContent>
      </Section>

      <AdminDeferredContent label="Show organization usage" placeholderClassName="h-96">
      {() => <Section
        title="Organizations"
        description="Signed-in members' usage by organization. The weekly allowance is per person, so someone at their limit counts in every organization they used this week."
        action={<DenButton variant="secondary" size="sm" icon={Download} onClick={() => downloadCsv(report)}>Export CSV</DenButton>}
      >
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-[14rem] flex-1">
            <DenInput icon={Search} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search organizations" aria-label="Search organizations" />
          </div>
          <DenSelect aria-label="Sort organizations" value={sort} onChange={(event) => setSort(event.target.value as OrganizationSort)}>
            {SORTS.map((option) => <option key={option.value} value={option.value}>Sort: {option.label}</option>)}
          </DenSelect>
        </div>
        <DenTable columns={organizationColumns(now)} rows={rows} getRowKey={(row) => row.id} density="compact"
          emptyLabel={search ? "No organizations match this search." : "No organizations have used free Auto in this range."} />
        {report.otherOrganizations ? (
          <p className="text-[13px] text-gray-500">
            Plus {formatCount(report.otherOrganizations.organizations)} more organizations with {formatCount(report.otherOrganizations.requests)} requests
            and {formatUsd(report.otherOrganizations.costMicroUsd)} of spend.
          </p>
        ) : null}
      </Section>}
      </AdminDeferredContent>

      <Section title="Signed-out desktops" description="Guests have no account or organization, so they are only shown as totals.">
        <dl className="grid gap-4 sm:grid-cols-5">
          {[
            ["Spend", formatUsd(guests.costMicroUsd)],
            ["Requests", formatCount(guests.requests)],
            ["Charged the estimate", formatShare(guests.estimatedRequests, guests.requests)],
            ["Tokens in / out", `${formatTokens(guests.inputTokens)} / ${formatTokens(guests.outputTokens)}`],
            ["Input cached", formatShare(guests.cachedInputTokens, guests.inputTokens)],
          ].map(([label, value]) => (
            <div key={label}>
              <dt className="text-[12px] text-gray-500">{label}</dt>
              <dd className="mt-1 text-[18px] font-medium tabular-nums text-gray-900">{value}</dd>
            </div>
          ))}
        </dl>
      </Section>

      <p className="text-[12px] leading-5 text-gray-400">
        Spend is what free Auto charged each allowance: OpenAI&apos;s reported tokens at list price, or a fixed estimate when OpenAI reported no usage.
        Days are UTC. Updated {formatRelative(report.generatedAt)}.
      </p>
    </div>
  );
}

export function FreeAutoUsagePage() {
  const params = useSearchParams();
  const rawDays = params.get("days");
  const days: FreeAutoRange = rawDays === "7" ? 7 : rawDays === "90" ? 90 : 30;
  const [refreshKey, setRefreshKey] = useState(0);
  const setDays = (value: string) => {
    const query = new URLSearchParams(window.location.search);
    query.set("days", value); query.delete("page");
    window.history.pushState(null, "", `/admin/free-auto?${query}`);
  };
  const { state, refresh } = useFreeAutoUsage(days);
  const report = state.report;
  if (state.status === "signed-out" || state.status === "forbidden") return <AdminAccessScreen state={state.status} message={state.message} onRetry={refresh} />;
  if (!report && state.status === "loading") return <AdminAccessScreen state="checking" />;
  if (!report && state.status === "error") return <AdminAccessScreen state="error" message={state.message} onRetry={refresh} />;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <DenPageHeader title="Free Auto usage" description="What free Auto costs and who uses it, across every organization and signed-out desktop." />
        <div className="flex flex-wrap items-center gap-2">
          <DenSegmented aria-label="Date range" value={String(days)} onChange={setDays}
            options={FREE_AUTO_RANGES.map((range) => ({ value: String(range), label: `${range} days` }))} />
          <DenButton variant="secondary" size="sm" icon={RefreshCw} loading={state.status === "loading" && report !== null} onClick={() => { refresh(); setRefreshKey((value) => value + 1); }}>Refresh</DenButton>
        </div>
      </div>
      {state.status === "error" ? (
        <DenNotice message={<span>{state.message} <button type="button" className="underline underline-offset-2" onClick={refresh}>Try again</button></span>} />
      ) : null}
      {report ? <Report report={report} refreshKey={refreshKey} /> : null}
    </div>
  );
}
