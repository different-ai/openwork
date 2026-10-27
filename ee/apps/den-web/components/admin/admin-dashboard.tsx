"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight, Building2, CircleAlert, Search, TrendingUp, Users } from "lucide-react";
import { adminActiveUsersSchema, adminDashboardSchema, type AdminActiveUsers, type AdminDashboard as Dashboard, type AdminOrganizationUsageTotals } from "@openwork/types/den/admin-organization";
import { DenButton, buttonVariants } from "../../app/(den)/_components/ui/button";
import { DenTable, type DenTableColumn } from "../../app/(den)/_components/ui/table";
import { requestAdmin } from "./admin-request";
import { AdminDeferredContent } from "./admin-deferred-content";
import { AdminRecentOrganizationsPanel } from "./admin-recent-organizations";

const AdminUsageChart = lazy(() => import("./admin-usage-chart").then((module) => ({ default: module.AdminUsageChart })));

const count = (value: number) => new Intl.NumberFormat().format(value);
const compact = (value: number) => new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
const usd = (value: number) => new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value / 1_000_000);
const recordedCost = (totals: AdminOrganizationUsageTotals) => totals.costMicroUsd === 0 && totals.unpricedRequests !== 0 ? "Unknown" : usd(totals.costMicroUsd);

function Coverage({ totals }: { totals: AdminOrganizationUsageTotals }) {
  if (totals.unpricedRequests === 0 && totals.unreportedRequests === 0) return null;
  return <p data-testid="admin-dashboard-coverage" className="mt-3 text-xs text-amber-800">
    {totals.unpricedRequests === null ? "Price coverage unknown" : `${count(totals.unpricedRequests)} requests without a recorded price`}
    {" · "}{totals.unreportedRequests === null ? "Token coverage unknown" : `${count(totals.unreportedRequests)} requests without reported tokens`}
  </p>;
}

type Day = Dashboard["daily"][number];
type UsageWindow = { requests: number; tokens: number; costMicroUsd: number };
const sumDays = (days: Day[]): UsageWindow => days.reduce((total, day) => ({ requests: total.requests + day.requests, tokens: total.tokens + day.tokens, costMicroUsd: total.costMicroUsd + day.costMicroUsd }), { requests: 0, tokens: 0, costMicroUsd: 0 });

/** Last 7 complete-or-current UTC days against the 7 before them. */
function weekOverWeek(daily: Day[]) {
  const days = [...daily].sort((a, b) => a.date.localeCompare(b.date));
  return { current: sumDays(days.slice(-7)), previous: sumDays(days.slice(-14, -7)), days };
}

function change(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return Math.round(((current - previous) / previous) * 100);
}

function ChangeBadge({ value }: { value: number | null }) {
  if (value === null) return <span className="text-xs font-medium text-slate-500">New</span>;
  if (value === 0) return <span className="text-xs font-medium text-slate-500">No change</span>;
  const Icon = value > 0 ? ArrowUpRight : ArrowDownRight;
  return <span className={`inline-flex items-center gap-0.5 text-xs font-medium tabular-nums ${value > 0 ? "text-emerald-700" : "text-rose-700"}`}><Icon size={13} aria-hidden="true" />{Math.abs(value)}%</span>;
}

type Signal = { id: string; tone: "warn" | "info"; text: string; href?: string; action?: string };

function attentionSignals(data: Dashboard): Signal[] {
  const signals: Signal[] = [];
  const { current, previous, days } = weekOverWeek(data.daily);
  const requestChange = change(current.requests, previous.requests);
  if (data.totals.requests > 0 && days.slice(-3).every((day) => day.requests === 0)) {
    signals.push({ id: "idle", tone: "warn", text: "No gateway requests in the last 3 days. Check provider keys and gateway health." });
  } else if (requestChange !== null && requestChange <= -30) {
    signals.push({ id: "drop", tone: "warn", text: `AI requests fell ${Math.abs(requestChange)}% compared with the previous 7 days.` });
  } else if (requestChange !== null && requestChange >= 50 && current.requests >= 20) {
    signals.push({ id: "spike", tone: "info", text: `AI requests grew ${requestChange}% compared with the previous 7 days.` });
  }
  const costChange = change(current.costMicroUsd, previous.costMicroUsd);
  if (costChange !== null && costChange >= 50 && current.costMicroUsd >= 1_000_000) {
    signals.push({ id: "cost", tone: "warn", text: `Recorded cost rose ${costChange}% week over week (${usd(current.costMicroUsd)} in the last 7 days).` });
  }
  const leader = data.organizations[0];
  if (leader && data.organizations.length > 1 && data.totals.costMicroUsd > 0) {
    const share = Math.round((leader.costMicroUsd / data.totals.costMicroUsd) * 100);
    if (share >= 50) signals.push({ id: "concentration", tone: "info", text: `${leader.name} accounts for ${share}% of recorded cost.`, href: `/admin/organizations/${encodeURIComponent(leader.id)}/insights`, action: "Open insights" });
  }
  if (data.totals.unpricedRequests !== 0) {
    signals.push({ id: "pricing", tone: "warn", text: data.totals.unpricedRequests === null ? "Some requests may be missing a price, so recorded cost can be understated." : `${count(data.totals.unpricedRequests)} requests have no recorded price, so cost is understated.` });
  }
  return signals;
}

function QuickFind() {
  const router = useRouter();
  const [organization, setOrganization] = useState("");
  const [user, setUser] = useState("");
  const go = (event: FormEvent, path: string, value: string) => {
    event.preventDefault();
    const search = value.trim();
    router.push(search ? `${path}?${new URLSearchParams({ search })}` : path);
  };
  const field = "w-full rounded-md border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm text-slate-900 outline-hidden transition focus:border-slate-400";
  return <div className="grid gap-3 pt-5 sm:grid-cols-2" data-testid="admin-quick-find">
    <form role="search" onSubmit={(event) => go(event, "/admin/organizations", organization)} className="relative">
      <Building2 size={16} strokeWidth={1.75} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
      <input aria-label="Find an organization" maxLength={160} value={organization} onChange={(event) => setOrganization(event.target.value)} placeholder="Find an organization by name, slug, or id" className={field} />
    </form>
    <form role="search" onSubmit={(event) => go(event, "/admin/users", user)} className="relative">
      <Users size={16} strokeWidth={1.75} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
      <input aria-label="Find a user" maxLength={160} value={user} onChange={(event) => setUser(event.target.value)} placeholder="Find a user by email, name, or id" className={field} />
    </form>
  </div>;
}

function WeekOverWeek({ data }: { data: Dashboard }) {
  const { current, previous } = weekOverWeek(data.daily);
  const rows = [
    { label: "AI requests", current: count(current.requests), previous: count(previous.requests), change: change(current.requests, previous.requests) },
    { label: "Reported tokens", current: compact(current.tokens), previous: compact(previous.tokens), change: change(current.tokens, previous.tokens) },
    { label: "Recorded cost", current: usd(current.costMicroUsd), previous: usd(previous.costMicroUsd), change: change(current.costMicroUsd, previous.costMicroUsd) },
  ];
  return <table className="w-full text-sm" aria-label="Last 7 days compared with the previous 7 days">
    <thead><tr className="text-left text-xs text-slate-500"><th className="pb-2 font-medium">Metric</th><th className="pb-2 text-right font-medium">Last 7 days</th><th className="pb-2 text-right font-medium">Previous 7</th><th className="pb-2 text-right font-medium">Change</th></tr></thead>
    <tbody className="divide-y divide-slate-100">
      {rows.map((row) => <tr key={row.label}>
        <td className="py-2 text-slate-700">{row.label}</td>
        <td className="py-2 text-right font-medium tabular-nums text-slate-950">{row.current}</td>
        <td className="py-2 text-right tabular-nums text-slate-500">{row.previous}</td>
        <td className="py-2 text-right"><ChangeBadge value={row.change} /></td>
      </tr>)}
    </tbody>
  </table>;
}

function Attention({ data }: { data: Dashboard }) {
  const signals = attentionSignals(data);
  return <section aria-label="Needs attention" data-testid="admin-dashboard-attention" className="min-w-0 rounded-lg border border-slate-200 bg-white">
    <h2 className="flex items-center gap-2 border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-950"><TrendingUp size={15} strokeWidth={1.75} aria-hidden="true" className="text-slate-500" />This week</h2>
    <div className="px-4 py-3"><WeekOverWeek data={data} /></div>
    <div className="border-t border-slate-200 px-4 py-3">
      <h3 className="text-xs font-medium text-slate-500">Needs attention</h3>
      {signals.length ? <ul className="mt-2 grid gap-2">
        {signals.map((signal) => <li key={signal.id} className="flex items-start gap-2 text-sm">
          <CircleAlert size={15} strokeWidth={1.75} aria-hidden="true" className={`mt-0.5 shrink-0 ${signal.tone === "warn" ? "text-amber-600" : "text-sky-600"}`} />
          <span className="min-w-0 text-slate-700">{signal.text}{signal.href ? <> <Link href={signal.href} prefetch={false} className="whitespace-nowrap font-medium text-slate-950 underline-offset-2 hover:underline">{signal.action}</Link></> : null}</span>
        </li>)}
      </ul> : <p className="mt-2 text-sm text-slate-500">Nothing unusual in the last 7 days.</p>}
    </div>
  </section>;
}

function Metric({ label, value, detail, href, testId }: { label: string; value: string; detail: ReactNode; href?: string; testId: string }) {
  return <div data-testid={testId} className="min-w-0 px-5 py-5 first:pl-0 sm:odd:pl-0 xl:odd:pl-5 xl:first:pl-0">
    <dt className="text-[13px] font-medium text-slate-600">{href ? <Link href={href} prefetch={false} className="hover:text-slate-950 hover:underline">{label}</Link> : label}</dt>
    <dd className="mt-2 text-3xl font-semibold tracking-tight tabular-nums text-slate-950">{value}</dd>
    <dd className="mt-2 text-xs text-slate-500">{detail}</dd>
  </div>;
}

function UsageChart({ data }: { data: Dashboard }) {
  const columns: DenTableColumn<Dashboard["daily"][number]>[] = [
    { key: "date", header: "Date (UTC)", render: (day) => day.date },
    { key: "requests", header: "Requests", align: "right", render: (day) => count(day.requests) },
    { key: "tokens", header: "Reported tokens", align: "right", render: (day) => count(day.tokens) },
    { key: "cost", header: "Recorded cost", align: "right", render: recordedCost },
  ];
  return <section aria-label="AI usage trend" className="min-w-0 border-b border-slate-200 py-6">
    <AdminDeferredContent label="Show activity chart" placeholderClassName="h-72">
      {() => <Suspense fallback={<div className="h-72" aria-busy="true" aria-label="Loading usage chart" />}><AdminUsageChart daily={data.daily} /></Suspense>}
    </AdminDeferredContent>
    {data.totals.requests === 0 ? <p className="text-sm text-slate-500">No recorded gateway requests in this period.</p> : null}
    <Coverage totals={data.totals} />
    <details className="mt-4 text-xs text-slate-600">
      <summary className="w-fit cursor-pointer py-1 font-medium focus-visible:outline-2 focus-visible:outline-slate-500">Daily breakdown</summary>
      <div className="mt-3"><DenTable columns={columns} rows={data.daily} getRowKey={(day) => day.date} density="compact" /></div>
    </details>
  </section>;
}

export function AdminDashboard({ totalOrganizations, totalUsers, refreshKey, onAccessDenied }: {
  totalOrganizations: number; totalUsers: number; refreshKey: string | null; onAccessDenied: (access: "signed-out" | "forbidden") => void;
}) {
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void requestAdmin("/v1/admin/dashboard", (payload) => {
      const parsed = adminDashboardSchema.safeParse(payload);
      return parsed.success ? parsed.data : null;
    }, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.access === "ready") setData(result.data);
      else if (result.access === "forbidden" || result.access === "signed-out") onAccessDenied(result.access);
      else setError(result.message);
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Could not load dashboard metrics.");
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [attempt, onAccessDenied, refreshKey]);
  // Counting active users scans 30 days of platform activity, so it runs only when an admin asks for it.
  const [activeUsers, setActiveUsers] = useState<AdminActiveUsers | null>(null);
  const [activeUsersLoading, setActiveUsersLoading] = useState(false);
  const [activeUsersError, setActiveUsersError] = useState<string | null>(null);
  const activeUsersController = useRef<AbortController | null>(null);
  useEffect(() => () => activeUsersController.current?.abort(), []);
  const loadActiveUsers = useCallback(() => {
    activeUsersController.current?.abort();
    const controller = new AbortController();
    activeUsersController.current = controller;
    setActiveUsersLoading(true);
    setActiveUsersError(null);
    void requestAdmin("/v1/admin/dashboard/active-users", (payload) => {
      const parsed = adminActiveUsersSchema.safeParse(payload);
      return parsed.success ? parsed.data : null;
    }, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.access === "ready") setActiveUsers(result.data);
      else if (result.access === "forbidden" || result.access === "signed-out") onAccessDenied(result.access);
      else setActiveUsersError(result.message);
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setActiveUsersError(error instanceof Error ? error.message : "Could not count active users.");
    }).finally(() => { if (!controller.signal.aborted) setActiveUsersLoading(false); });
  }, [onAccessDenied]);
  const activeUsersDetail = activeUsers
    ? <span>{count(activeUsers.days7)} in 7 days · {count(activeUsers.today)} today · <button type="button" onClick={loadActiveUsers} disabled={activeUsersLoading} className="font-medium underline-offset-2 hover:underline disabled:opacity-60">Recount</button></span>
    : <span>{activeUsersError ? `${activeUsersError} ` : null}<button type="button" data-testid="admin-dashboard-active-users-load" onClick={loadActiveUsers} disabled={activeUsersLoading} className="font-medium text-slate-700 underline-offset-2 hover:underline disabled:opacity-60">{activeUsersLoading ? "Counting 30-day activity…" : activeUsersError ? "Retry" : "Count active users"}</button></span>;
  const organizations: DenTableColumn<Dashboard["organizations"][number]>[] = [
    { key: "organization", header: "Organization", render: (org) => <Link href={`/admin/organizations/${encodeURIComponent(org.id)}/insights`} prefetch={false} className="font-medium text-slate-950 hover:underline">{org.name}</Link> },
    { key: "requests", header: "Requests", align: "right", render: (org) => count(org.requests) },
    { key: "tokens", header: "Reported tokens", align: "right", render: (org) => compact(org.tokens) },
    { key: "share", header: "Share of cost", align: "right", render: (org) => data && data.totals.costMicroUsd > 0 ? <span className="tabular-nums text-slate-600">{Math.round((org.costMicroUsd / data.totals.costMicroUsd) * 100)}%</span> : <span className="text-slate-500">—</span> },
    { key: "cost", header: "Recorded cost", align: "right", render: (org) => <span>{recordedCost(org)}{org.unpricedRequests !== 0 ? <span className="ml-1 text-xs text-amber-800" title="Some prices are missing or coverage is unknown">(partial)</span> : null}</span> },
  ];
  return <div data-testid="admin-dashboard">
    <QuickFind />
    <div className="flex flex-wrap items-center justify-between gap-3 pt-5 text-xs text-slate-500">
      <p>{data ? `${data.from} – ${data.to} UTC` : "Last 30 days · UTC"}</p>
      <p role={loading ? "status" : undefined}>{loading ? "Updating metrics…" : data ? `Updated ${new Date(data.generatedAt).toLocaleTimeString()}` : "Metrics unavailable"}</p>
    </div>
    <dl className="grid grid-cols-2 divide-y divide-slate-200 border-b border-slate-200 sm:divide-y-0 xl:grid-cols-4" aria-label="Platform metrics" aria-busy={loading}>
      <Metric label="Organizations" value={count(totalOrganizations)} detail={data ? `${count(data.activeOrganizations)} with AI usage in 30 days` : "All organizations"} href="/admin/organizations" testId="admin-dashboard-organizations" />
      <Metric label="Active users" value={activeUsers ? count(activeUsers.days30) : "—"} detail={activeUsersDetail} href="/admin/users" testId="admin-dashboard-active-users" />
      <Metric label="AI requests" value={data ? count(data.totals.requests) : "—"} detail={data ? `${count(data.totals.tokens)} reported tokens` : loading ? "Loading 30-day usage…" : "Usage unavailable"} testId="admin-dashboard-requests" />
      <Metric label="Recorded cost" value={data ? recordedCost(data.totals) : "—"} detail={data && data.totals.unpricedRequests !== 0 ? "Partial cost · USD · 30 days" : "USD · 30 days"} testId="admin-dashboard-cost" />
    </dl>
    {error ? <div role="alert" className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 py-4 text-sm text-red-700"><p>{error}{data ? " Showing the last successful snapshot." : " Retry to load activity and usage."}</p><DenButton variant="secondary" size="sm" onClick={() => setAttempt((value) => value + 1)}>Retry metrics</DenButton></div> : null}
    <div className={`grid gap-4 border-b border-slate-200 py-6 ${data || loading ? "lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]" : ""}`}>
      {data ? <Attention data={data} /> : loading ? <div className="min-h-40 rounded-lg border border-slate-200 bg-slate-50/60" aria-hidden="true" /> : null}
      <AdminRecentOrganizationsPanel />
    </div>
    {data ? <>
      <UsageChart data={data} />
      <section aria-label="Most active organizations" className="py-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-semibold text-slate-950">Most active organizations</h2><Link href="/admin/organizations" prefetch={false} className={buttonVariants({ variant: "ghost", size: "sm" })}>View organizations</Link></div>
        <DenTable columns={organizations} rows={data.organizations} getRowKey={(org) => org.id} density="compact" emptyLabel="No organizations have recorded AI usage in this period." />
      </section>
      <div className="flex flex-wrap justify-between gap-2 border-t border-slate-200 py-3 text-xs text-slate-500"><p>{count(totalUsers)} total users · Activity includes sign-ins and telemetry</p></div>
    </> : loading ? <p role="status" className="py-10 text-sm text-slate-500">Loading activity and AI usage…</p> : null}
  </div>;
}
