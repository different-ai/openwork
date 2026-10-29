"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import { adminFreeAutoConversionsSchema, freeAutoConversionStageSchema, type AdminFreeAutoConversions } from "@openwork/types/den/admin-free-auto";
import { DenButton } from "../../../app/(den)/_components/ui/button";
import { DenInput } from "../../../app/(den)/_components/ui/input";
import { DenSelect } from "../../../app/(den)/_components/ui/select";
import { DenNotice } from "../../../app/(den)/_components/ui/notice";
import { DenTable, type DenTableColumn } from "../../../app/(den)/_components/ui/table";
import { useAdminListLocation } from "../admin-list-location";
import { requestAdmin } from "../admin-request";
import { AdminDeferredContent } from "../admin-deferred-content";
import { formatCount, formatShare } from "./format";

const Chart = dynamic(() => import("./conversion-chart"), { loading: () => <div className="h-64 bg-slate-50" aria-label="Loading conversion chart" /> });
const STAGES = [
  { value: "all", label: "All outcomes" }, { value: "signed-in", label: "Signed in afterward" },
  { value: "new-account", label: "Created an account" }, { value: "subscribed", label: "Paid subscription" }, { value: "unlinked", label: "Unlinked guests" },
];
type Row = AdminFreeAutoConversions["rows"][number];
function date(value: string | null) {
  return value ? new Date(value).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) : "—";
}
function elapsed(after: string | null, before: string) {
  if (!after) return null;
  const minutes = Math.max(0, Math.floor((Date.parse(after) - Date.parse(before)) / 60_000));
  return minutes < 60 ? `${minutes}m after limit` : minutes < 1440 ? `${Math.floor(minutes / 60)}h after limit` : `${Math.floor(minutes / 1440)}d after limit`;
}
function milestone(value: string | null, before: string) {
  return <span className="whitespace-nowrap" title={value ?? "No recorded event"}>{date(value)}{value ? <span className="block text-xs text-slate-500">{elapsed(value, before)}</span> : null}</span>;
}
const columns: DenTableColumn<Row>[] = [
  { key: "person", header: "Person / journey", render: (row) => <div className="min-w-44">
    {row.userId ? <Link prefetch={false} className="font-medium text-slate-900 underline-offset-4 hover:underline" href={`/admin/users?search=${encodeURIComponent(row.email ?? row.userId)}`}>{row.name ?? row.email ?? "Account"}</Link> : <span className="text-slate-500">Unlinked guest journey</span>}
    <p className="text-xs text-slate-500">{row.email ?? "No identified account"}</p>
    <p className="mt-1 text-xs text-slate-500">{row.startedAsGuest ? "Guest journey" : "Signed-in member"}</p>
  </div> },
  { key: "limit", header: "Limit observed", render: (row) => <span className="whitespace-nowrap" title={row.exhaustedAt}>{date(row.exhaustedAt)}</span> },
  { key: "signin", header: "Signed in afterward", render: (row) => milestone(row.signedInAt, row.exhaustedAt) },
  { key: "signup", header: "New account", render: (row) => milestone(row.signedUpAt, row.exhaustedAt) },
  { key: "subscription", header: "Paid subscription", render: (row) => milestone(row.subscribedAt, row.exhaustedAt) },
];

export function FreeAutoConversions({ days, refreshKey }: { days: number; refreshKey: number }) {
  const params = useSearchParams();
  const parsed = freeAutoConversionStageSchema.safeParse(params.get("conversionStage") ?? "all");
  const stage = parsed.success ? parsed.data : "all";
  const { search, draftSearch, page, setSearch, setPage } = useAdminListLocation();
  const [report, setReport] = useState<AdminFreeAutoConversions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    const timer = setTimeout(() => {
      const query = new URLSearchParams({ days: String(days), page: String(page), search, stage });
      requestAdmin(`/v1/admin/free-auto/conversions?${query}`, (value) => {
        const result = adminFreeAutoConversionsSchema.safeParse(value);
        return result.success ? result.data : null;
      }, controller.signal).then((result) => {
        if (controller.signal.aborted) return;
        if (result.access === "ready") { setReport(result.data); setError(null); }
        else { setError(result.message); if (result.access !== "error") setReport(null); }
        setLoading(false);
      }).catch(() => { if (!controller.signal.aborted) { setError("Could not load free Auto conversions."); setLoading(false); } });
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [days, page, refreshKey, search, stage]);
  const changeStage = (value: string) => {
    const query = new URLSearchParams(window.location.search);
    if (value === "all") query.delete("conversionStage"); else query.set("conversionStage", value);
    query.delete("page");
    window.history.pushState(null, "", `/admin/free-auto${query.size ? `?${query}` : ""}`);
  };
  const metrics = report ? [
    { label: "Reached limit", value: report.totals.reachedLimit, filter: "all" }, { label: "Signed in afterward", value: report.totals.signedIn, filter: "signed-in" },
    { label: "New accounts", value: report.totals.newAccounts, filter: "new-account" }, { label: "Paid subscriptions", value: report.totals.subscribed, filter: "subscribed" },
  ] : [];
  return <section className="flex min-w-0 flex-col gap-5 rounded-lg border border-slate-200 bg-white p-5" aria-labelledby="free-auto-conversions-title" aria-busy={loading}>
    <div><h2 id="free-auto-conversions-title" className="text-base font-medium text-slate-900">After the free limit</h2>
</div>
    {error ? <DenNotice message={error} /> : null}
    {!report && loading ? <p className="text-sm text-slate-500" role="status">Loading conversion activity…</p> : null}
    {report ? <>
      <div className="grid grid-cols-2 border-y border-slate-200 md:grid-cols-4">{metrics.map((metric) => <button key={metric.filter} type="button" onClick={() => changeStage(metric.filter)}
        className="min-w-0 px-3 py-4 text-left transition-colors hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-slate-500" aria-label={`Show ${metric.label}`} aria-pressed={stage === metric.filter}>
        <span className="block text-xs text-slate-500">{metric.label}</span><span className="mt-2 block text-2xl font-medium tabular-nums text-slate-900">{formatCount(metric.value)}</span>
        <span className="mt-1 block text-xs text-slate-500">{metric.filter === "all" ? "Accounts and anonymous journeys" : `${formatShare(metric.value, report.totals.reachedLimit)} of the limit cohort`}</span>
      </button>)}</div>
      {report.totals.reachedLimit ? <div><AdminDeferredContent label="Show conversion activity chart" placeholderClassName="h-64">{() => <Chart daily={report.daily} />}</AdminDeferredContent><p className="mt-2 text-xs text-slate-500">Grouped by the UTC day the limit was first observed in this range. Recent cohorts still have time to convert.</p></div>
        : <p className="rounded-md bg-slate-50 p-4 text-sm text-slate-500">No tracked limit observations in this range. New activity will appear here after tracking is deployed.</p>}
      <div className="flex flex-wrap gap-3"><div className="min-w-48 flex-1"><DenInput icon={Search} aria-label="Search conversion people" placeholder="Search people by name, email, or user ID" value={draftSearch} onChange={(event) => setSearch(event.target.value.slice(0, 160))} /></div>
        <DenSelect aria-label="Conversion outcome" value={stage} onChange={(event) => changeStage(event.target.value)}>{STAGES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</DenSelect></div>
      <DenTable columns={columns} rows={report.rows} getRowKey={(row) => row.id} density="compact" emptyLabel="No journeys match these filters." />
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-slate-500"><span>{formatCount(report.page.total)} matching accounts / journeys · page {page} · dates in UTC</span>
        <div className="flex gap-2"><DenButton variant="secondary" size="sm" disabled={loading || page <= 1} onClick={() => setPage(page - 1)}>Previous</DenButton><DenButton variant="secondary" size="sm" disabled={loading || !report.page.hasMore} onClick={() => setPage(page + 1)}>Next</DenButton></div></div>
      <details className="text-xs leading-5 text-slate-500"><summary className="cursor-pointer text-slate-600">How attribution works</summary>
        <p className="mt-2">Known accounts count once per selected range; unlinked guests count by random journey, so they are not a count of unique people. Guest sign-in means the app was seen authenticated with the same client-reported identifier. Member sign-in means a new session was created after the limit. A new account must have been created after the guest limit.</p>
        <p className="mt-2">Paid conversion requires a positive payment for a subscription started after the limit, attributed to its checkout creator. Existing subscriptions, renewals of older subscriptions, trials, failed payments, and teammates are excluded. Sign-in and purchase are separate outcomes, and each has a 30-day attribution window.</p>
        <p className="mt-2">Only activity recorded by the updated clients and services is available. We do not match guests by IP or backfill historical guest identities. Shared app profiles can share a journey. Guest observations are capped at 100 new journeys per network per UTC day to bound abuse. {formatCount(report.totals.unlinkedGuests)} guest journeys remain unlinked in this range. {report.firstRecordedAt ? `Earliest retained observation: ${date(report.firstRecordedAt)} UTC.` : "No observations recorded yet."}</p>
      </details>
    </> : null}
  </section>;
}
