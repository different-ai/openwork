"use client";

import Link from "next/link";
import { lazy, Suspense } from "react";
import type { AdminOrganizationInsights as Report } from "@openwork/types/den/admin-organization";
import { DenTable, type DenTableColumn } from "../../app/(den)/_components/ui/table";
import { AdminDeferredContent } from "./admin-deferred-content";

const AdminUsageChart = lazy(() => import("./admin-usage-chart").then((module) => ({ default: module.AdminUsageChart })));
const AdminRankingChart = lazy(() => import("./admin-usage-chart").then((module) => ({ default: module.AdminRankingChart })));

const count = (value: number) => new Intl.NumberFormat().format(value);
const percent = (value: number) => new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 }).format(value);
const usd = (value: number) => new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 4 }).format(value / 1_000_000);
type Totals = Pick<Report["insights"]["current"], "costMicroUsd" | "unpricedRequests">;
function Cost({ data }: { data: Totals }) {
  return <span>{data.costMicroUsd === 0 && data.unpricedRequests !== 0 ? "Unknown" : usd(data.costMicroUsd)}{data.unpricedRequests !== 0 && data.costMicroUsd > 0 ? <span className="ml-1 text-xs text-amber-800">(partial)</span> : null}</span>;
}
function Stat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div className="min-w-0 py-4"><dt className="text-xs font-medium text-slate-600">{label}</dt><dd className="mt-2 text-2xl font-semibold tabular-nums text-slate-950">{value}</dd><dd className="mt-2 text-xs text-slate-500">{detail}</dd></div>;
}

export function AdminOrganizationInsights({ organization, insights }: Pick<Report, "organization" | "insights">) {
  const current = insights.current;
  const previous = insights.previous;
  const change = previous.requests > 0 ? (current.requests - previous.requests) / previous.requests : null;
  const people: DenTableColumn<Report["insights"]["people"][number]>[] = [
    { key: "person", header: "Person", render: (person) => <div className="min-w-0 max-w-xs break-words">
      {person.userId ? <Link href={`/admin/users?${new URLSearchParams({ search: person.userId })}`} prefetch={false} className="font-medium text-slate-950 hover:underline">{person.name || person.email || "Unnamed member"}</Link> : <span>{person.name || person.email || "Unavailable member"}</span>}
      {person.email ? <p className="mt-1 text-xs text-slate-500">{person.email}</p> : null}
      {!person.currentMember ? <p className="mt-1 text-xs text-slate-500">Former or unavailable member</p> : null}
    </div> },
    { key: "requests", header: "Requests", align: "right", render: (person) => count(person.requests) },
    { key: "days", header: "Last active (UTC)", render: (person) => person.lastActiveDay ?? "Unknown" },
    { key: "tokens", header: "Reported tokens", align: "right", render: (person) => count(person.tokens) },
    { key: "cost", header: "Recorded cost", align: "right", render: (person) => <Cost data={person} /> },
  ];
  const models: DenTableColumn<Report["insights"]["models"][number]>[] = [
    { key: "model", header: "Model", render: (model) => <div className="max-w-xs break-words font-medium text-slate-950">{model.name}<p className="mt-1 text-xs font-normal text-slate-500">{model.provider}</p></div> },
    { key: "requests", header: "Requests", align: "right", render: (model) => count(model.requests) },
    { key: "share", header: "Share of requests", align: "right", render: (model) => current.requests > 0 ? percent(model.requests / current.requests) : "—" },
    { key: "tokens", header: "Reported tokens", align: "right", render: (model) => count(model.tokens) },
    { key: "cost", header: "Recorded cost", align: "right", render: (model) => <Cost data={model} /> },
  ];
  return <div data-testid="admin-organization-insights" className="min-w-0">
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 py-4 text-xs text-slate-500"><p>{insights.from} – {insights.to} UTC</p><p>Compared with {insights.previousFrom} – {insights.previousTo}</p></div>
    <dl aria-label="Organization adoption signals" className="grid grid-cols-2 gap-x-6 border-b border-slate-200 xl:grid-cols-4">
      <Stat label="Active member adoption" value={organization.memberCount > 0 ? percent(current.activeMembers / organization.memberCount) : "—"} detail={`${count(current.activeMembers)} of ${count(organization.memberCount)} current members used AI`} />
      <Stat label="Request trend" value={change === null ? "—" : `${change > 0 ? "+" : ""}${percent(change)}`} detail={`${count(current.requests)} requests · ${count(previous.requests)} in prior period`} />
      <Stat label="Seat utilization" value={organization.seatLimit > 0 ? percent(organization.memberCount / organization.seatLimit) : "—"} detail={`${count(organization.memberCount)} members / ${count(organization.seatLimit)} seats`} />
      <Stat label="Last recorded use" value={current.lastActiveDay ?? previous.lastActiveDay ?? "No usage"} detail={current.lastActiveDay || previous.lastActiveDay ? "UTC calendar day" : "No gateway requests in 60 days"} />
    </dl>
    <dl className="grid grid-cols-2 gap-x-6 border-b border-slate-200 xl:grid-cols-4">
      <Stat label="AI requests" value={count(current.requests)} detail="Last 30 days" />
      <Stat label="Reported tokens" value={count(current.tokens)} detail={current.unreportedRequests === null ? "Token coverage unknown" : `${count(current.unreportedRequests)} requests without tokens`} />
      <div className="py-4"><dt className="text-xs font-medium text-slate-600">Recorded cost</dt><dd className="mt-2 text-2xl font-semibold tabular-nums text-slate-950"><Cost data={current} /></dd><dd className="mt-2 text-xs text-slate-500">{current.unpricedRequests === null ? "Price coverage unknown" : `${count(current.unpricedRequests)} requests without a price`}</dd></div>
      <Stat label="Successful requests" value={current.requests > 0 ? percent(current.successfulRequests / current.requests) : "—"} detail={`${count(current.successfulRequests)} of ${count(current.requests)} requests`} />
    </dl>
    {current.requests === 0 ? <p className="border-b border-slate-200 py-5 text-sm text-slate-500">No recorded gateway requests in the current period.</p> : null}
    <section aria-label="Organization activity over time" className="border-b border-slate-200 py-6">
      <AdminDeferredContent label="Show organization activity chart" placeholderClassName="h-72">
        {() => <Suspense fallback={<div className="h-72" aria-busy="true" aria-label="Loading activity chart" />}><AdminUsageChart daily={insights.daily} showActiveMembers /></Suspense>}
      </AdminDeferredContent>
    </section>
    <section aria-label="Most active people" className="border-b border-slate-200 py-6">
      <h2 className="mb-4 text-sm font-semibold text-slate-950">Most active people</h2>
      {insights.people.length ? <AdminDeferredContent label="Show active people chart" placeholderClassName="h-64">
        {() => <Suspense fallback={<div className="h-64" aria-busy="true" aria-label="Loading people chart" />}><AdminRankingChart rows={insights.people.map((person) => ({ name: person.name || person.email || "Unavailable member", requests: person.requests }))} label="Top eight people by AI requests" /></Suspense>}
      </AdminDeferredContent> : null}
      <DenTable columns={people} rows={insights.people} getRowKey={(person) => person.memberId} density="compact" emptyLabel="No people have recorded AI usage in this period." />
    </section>
    <section aria-label="Most used models" className="border-b border-slate-200 py-6">
      <h2 className="mb-4 text-sm font-semibold text-slate-950">Most used models</h2>
      {insights.models.length ? <AdminDeferredContent label="Show model usage chart" placeholderClassName="h-64">
        {() => <Suspense fallback={<div className="h-64" aria-busy="true" aria-label="Loading model chart" />}><AdminRankingChart rows={insights.models.map((model) => ({ name: model.name, requests: model.requests }))} label="Top eight models by AI requests" /></Suspense>}
      </AdminDeferredContent> : null}
      <DenTable columns={models} rows={insights.models} getRowKey={(model) => model.id} density="compact" emptyLabel="No models have recorded usage in this period." />
    </section>
    <details className="py-4 text-xs leading-5 text-slate-500"><summary className="w-fit cursor-pointer font-medium text-slate-700 focus-visible:outline-2 focus-visible:outline-slate-500">Metric definitions</summary>
      <p className="mt-3">Activity measures recorded gateway requests, including customer-provided models and OpenWork Models. Adoption counts current members with usage; historical totals and leaderboards include former members. Each period contains 30 UTC calendar days; the current period includes today. Leaderboards show up to eight entries, while totals include everyone. Successful requests have an OK gateway outcome; other outcomes include provider errors, rejected and interrupted requests.</p>
      <p className="mt-2">Missing reported tokens and prices are kept unknown. Model names come from recorded model identifiers. Usage and model preferences are observable product signals; no prompts, conversation content or inferred customer intent are collected here.</p>
    </details>
  </div>;
}
