"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ChevronRight, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { DenBadge, type DenBadgeTone } from "../../../app/(den)/_components/ui/badge";
import { DenButton } from "../../../app/(den)/_components/ui/button";
import { DenCard } from "../../../app/(den)/_components/ui/card";
import { DenNotice } from "../../../app/(den)/_components/ui/notice";
import { DenPageHeader } from "../../../app/(den)/_components/ui/page-header";
import { DenSegmented } from "../../../app/(den)/_components/ui/segmented";
import { DenTable, type DenTableColumn } from "../../../app/(den)/_components/ui/table";
import { AdminAccessScreen } from "../admin-access-screen";
import { formatCount, formatRelative, formatUsd } from "../free-auto-usage/format";
import {
  SECURITY_RANGES,
  severityCounts,
  sortBySeverity,
  targetHref,
  useSecurity,
  type SecurityCategory,
  type SecurityEntity,
  type SecurityFinding,
  type SecurityRange,
  type SecurityRequests,
  type SecuritySeverity,
} from "./security-data";

const SEVERITY_TONE: Record<SecuritySeverity, DenBadgeTone> = { high: "danger", medium: "warning", low: "info", clear: "success" };
const SEVERITY_LABEL: Record<SecuritySeverity, string> = { high: "High", medium: "Medium", low: "Low", clear: "Clear" };
const CATEGORY_LABEL: Record<SecurityCategory, string> = { access: "Sign-in and access", accounts: "Accounts", automation: "Bot-like use", credentials: "Credentials and admins", usage: "Usage" };
/** Findings whose entity values are amounts of money. */
const MONEY_FINDINGS = new Set(["spend-spikes", "instant-allowance"]);
type CategoryFilter = "all" | SecurityCategory;
const CATEGORY_OPTIONS: Array<{ value: CategoryFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "access", label: "Access" },
  { value: "accounts", label: "Accounts" },
  { value: "automation", label: "Bots" },
  { value: "credentials", label: "Credentials" },
  { value: "usage", label: "Usage" },
];

function SeverityBadge({ severity }: { severity: SecuritySeverity }) {
  return <DenBadge size="sm" tone={SEVERITY_TONE[severity]}>{SEVERITY_LABEL[severity]}</DenBadge>;
}

function entityColumns(finding: SecurityFinding): DenTableColumn<SecurityEntity>[] {
  return [
    {
      key: "entity", header: "Review", render: (entity) => {
        const href = targetHref(entity.target);
        return (
          <div className="min-w-[12rem]">
            {href ? <Link href={href} prefetch={false} className="font-medium text-gray-900 underline-offset-2 hover:underline">{entity.label}</Link>
              : <p className="break-all font-medium text-gray-900">{entity.label}</p>}
            {entity.detail ? <p className="mt-0.5 text-[12px] leading-5 text-gray-500">{entity.detail}</p> : null}
          </div>
        );
      },
    },
    { key: "value", header: MONEY_FINDINGS.has(finding.id) ? "Spend" : "Count", align: "right", render: (entity) => <span className="tabular-nums">{MONEY_FINDINGS.has(finding.id) ? formatUsd(entity.value) : formatCount(entity.value)}</span> },
    { key: "severity", header: "Severity", align: "right", width: "96px", render: (entity) => <SeverityBadge severity={entity.severity} /> },
  ];
}

function FindingRow({ finding }: { finding: SecurityFinding }) {
  return (
    <details className="group border-b border-gray-100 last:border-b-0" data-testid={`security-finding-${finding.id}`} data-severity={finding.severity}>
      <summary className="flex cursor-pointer list-none items-start gap-3 px-1 py-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-500 [&::-webkit-details-marker]:hidden">
        <ChevronRight size={16} strokeWidth={1.5} aria-hidden="true" className="mt-0.5 shrink-0 text-gray-500 transition-transform duration-150 ease-out group-open:rotate-90" />
        <span className="w-16 shrink-0"><SeverityBadge severity={finding.severity} /></span>
        <span className="min-w-0 flex-1">
          <span className="block text-[14px] font-medium text-gray-900">{finding.title}</span>
          <span className="mt-0.5 block text-[13px] leading-5 text-gray-500">{finding.summary}</span>
        </span>
        <span className="hidden shrink-0 text-[12px] text-gray-500 sm:block">{CATEGORY_LABEL[finding.category]}</span>
      </summary>
      <div className="flex flex-col gap-4 pb-5 pl-[6.25rem] pr-1">
        <dl className="grid max-w-3xl gap-3 text-[13px] leading-5 sm:grid-cols-2">
          <div><dt className="font-medium text-gray-700">Why it matters</dt><dd className="mt-0.5 text-gray-500">{finding.why}</dd></div>
          <div><dt className="font-medium text-gray-700">What to review</dt><dd className="mt-0.5 text-gray-500">{finding.review}</dd></div>
        </dl>
        {finding.entities.length ? (
          <div className="min-w-0">
            <DenTable columns={entityColumns(finding)} rows={finding.entities} getRowKey={(entity) => entity.id} density="compact" headerTone="plain" />
            {finding.entityCount > finding.entities.length ? (
              <p className="mt-2 text-[12px] text-gray-500">Showing {formatCount(finding.entities.length)} of {formatCount(finding.entityCount)}, highest first.</p>
            ) : null}
          </div>
        ) : null}
        <p className="max-w-3xl text-[12px] leading-5 text-gray-500">{finding.rule}</p>
      </div>
    </details>
  );
}

function Sparkline({ values, label }: { values: number[]; label: string }) {
  const max = Math.max(0, ...values);
  return (
    <div role="img" aria-label={label} className="flex h-8 w-full min-w-[10rem] items-end gap-px">
      {values.map((value, index) => (
        <span key={index} aria-hidden="true" className="block min-w-0 flex-1 rounded-[1px] bg-slate-400"
          style={{ height: `${max > 0 ? Math.max(value > 0 ? 6 : 2, (value / max) * 100) : 2}%`, opacity: value > 0 ? 1 : 0.3 }} />
      ))}
    </div>
  );
}

const REQUEST_SERIES: Array<{ key: "refused" | "rateLimited" | "failed" | "failedSignIns"; label: string }> = [
  { key: "failedSignIns", label: "Failed sign-ins" },
  { key: "rateLimited", label: "Rate limited" },
  { key: "refused", label: "Refused" },
  { key: "failed", label: "Failed" },
];

function RequestActivity({ requests }: { requests: SecurityRequests }) {
  const endpointColumns: DenTableColumn<SecurityRequests["endpoints"][number]>[] = [
    { key: "action", header: "Endpoint", render: (row) => <span className="break-all font-mono text-[12px] text-gray-800">{row.action}</span> },
    { key: "refused", header: "Refused", align: "right", render: (row) => <span className="tabular-nums">{formatCount(row.refused)}</span> },
    { key: "limited", header: "Rate limited", align: "right", render: (row) => <span className="tabular-nums">{formatCount(row.rateLimited)}</span> },
    { key: "failed", header: "Failed", align: "right", render: (row) => <span className="tabular-nums">{formatCount(row.failed)}</span> },
    { key: "peak", header: "Busiest hour", align: "right", render: (row) => <span className="tabular-nums">{formatCount(row.peakHour)} <span className="text-gray-500">/ {formatCount(Math.round(row.typicalHour))} typical</span></span> },
  ];
  return (
    <DenCard className="flex min-w-0 flex-col gap-5 !rounded-lg" data-testid="security-request-activity">
      <div>
        <h2 className="text-[16px] font-medium text-gray-900">Refused and failed requests, last 24 hours</h2>
        <p className="mt-1 max-w-3xl text-[13px] leading-5 text-gray-500">Sign-in, token, app registration and other calls without a trusted organization. Addresses are not kept, so this shows volume and timing, not sources.</p>
      </div>
      <div className="grid gap-x-6 gap-y-3 sm:grid-cols-[10rem_minmax(0,1fr)_6rem]">
        {REQUEST_SERIES.map((series) => {
          const values = requests.hourly.map((hour) => hour[series.key]);
          const total = values.reduce((sum, value) => sum + value, 0);
          return (
            <div key={series.key} className="contents">
              <p className="self-center text-[13px] text-gray-700">{series.label}</p>
              <Sparkline values={values} label={`${series.label} per hour for the last 24 hours, ${formatCount(total)} in total`} />
              <p className="self-center text-right text-[13px] font-medium tabular-nums text-gray-900">{formatCount(total)}</p>
            </div>
          );
        })}
      </div>
      <DenTable columns={endpointColumns} rows={requests.endpoints} getRowKey={(row) => row.action} density="compact" emptyLabel="No refused or failed requests in the last 24 hours." />
    </DenCard>
  );
}

export function SecurityPage() {
  const params = useSearchParams();
  const days: SecurityRange = params.get("days") === "30" ? 30 : 7;
  const [category, setCategory] = useState<CategoryFilter>("all");
  const { report, requests, refresh } = useSecurity(days);
  const setDays = (value: string) => {
    const query = new URLSearchParams(window.location.search);
    query.set("days", value);
    window.history.pushState(null, "", `/admin/security?${query}`);
  };

  const findings = useMemo(() => sortBySeverity([...(report.data?.findings ?? []), ...(requests.data?.findings ?? [])]), [report.data, requests.data]);
  const visible = findings.filter((finding) => category === "all" || finding.category === category);
  const open = visible.filter((finding) => finding.severity !== "clear");
  const clear = visible.filter((finding) => finding.severity === "clear");
  const counts = severityCounts(findings);

  if (report.status === "signed-out" || report.status === "forbidden") return <AdminAccessScreen state={report.status} message={report.message} onRetry={refresh} />;
  if (!report.data && report.status === "loading") return <AdminAccessScreen state="checking" />;
  if (!report.data && report.status === "error") return <AdminAccessScreen state="error" message={report.message} onRetry={refresh} />;

  const loading = report.status === "loading" || requests.status === "loading";
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <DenPageHeader title="Security" description="Unusual sign-in, account, credential and usage patterns across OpenWork Cloud, ranked for review. Findings are prompts to look, not verdicts." />
        <div className="flex flex-wrap items-center gap-2">
          <DenSegmented aria-label="Date range" value={String(days)} onChange={setDays}
            options={SECURITY_RANGES.map((range) => ({ value: String(range), label: `${range} days` }))} />
          <DenButton variant="secondary" size="sm" icon={RefreshCw} loading={loading && report.data !== null} onClick={refresh}>Refresh</DenButton>
        </div>
      </div>

      {report.status === "error" ? <DenNotice message={<span>{report.message} <button type="button" className="underline underline-offset-2" onClick={refresh}>Try again</button></span>} /> : null}

      <DenCard className="flex min-w-0 flex-col gap-4 !rounded-lg" data-testid="security-findings">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2" aria-label="Findings by severity" data-testid="security-severity-counts">
            {(["high", "medium", "low"] as const).map((severity) => (
              <DenBadge key={severity} tone={counts[severity] ? SEVERITY_TONE[severity] : "neutral"}>{formatCount(counts[severity])} {SEVERITY_LABEL[severity].toLowerCase()}</DenBadge>
            ))}
            <DenBadge tone="neutral">{formatCount(counts.clear)} clear</DenBadge>
          </div>
          <div className="max-w-full overflow-x-auto">
            <DenSegmented aria-label="Category" value={category} onChange={setCategory} options={CATEGORY_OPTIONS} />
          </div>
        </div>

        {open.length ? (
          <div>{open.map((finding) => <FindingRow key={finding.id} finding={finding} />)}</div>
        ) : (
          <p role="status" className="rounded-md bg-gray-50 px-4 py-3 text-[13px] text-gray-500">
            {category === "all" ? "Nothing needs review in this range." : `Nothing in ${CATEGORY_LABEL[category].toLowerCase()} needs review in this range.`}
          </p>
        )}

        {requests.status === "loading" && !requests.data ? <p role="status" aria-busy="true" className="text-[13px] text-gray-500">Checking the last 24 hours of sign-in and request activity…</p> : null}
        {requests.status === "error" ? (
          <DenNotice message={<span>Sign-in and request activity did not load. {requests.message} <button type="button" className="underline underline-offset-2" onClick={refresh}>Try again</button></span>} />
        ) : null}

        {clear.length ? (
          <details className="group">
            <summary className="flex cursor-pointer list-none items-center gap-2 text-[13px] font-medium text-gray-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-500 [&::-webkit-details-marker]:hidden">
              <ChevronRight size={16} strokeWidth={1.5} aria-hidden="true" className="text-gray-500 transition-transform duration-150 ease-out group-open:rotate-90" />
              {formatCount(clear.length)} {clear.length === 1 ? "check" : "checks"} with nothing to review
            </summary>
            <div className="mt-2">{clear.map((finding) => <FindingRow key={finding.id} finding={finding} />)}</div>
          </details>
        ) : null}
      </DenCard>

      {requests.data ? <RequestActivity requests={requests.data} /> : null}

      {report.data ? (
        <p className="text-[12px] leading-5 text-gray-500">
          Account, credential and usage checks cover the last {report.data.range.days} days and compare with the {report.data.range.days} days before. Networks are IPv4 /24 or IPv6 /64 ranges of sign-in addresses.
          Updated {formatRelative(report.data.generatedAt)}.
        </p>
      ) : null}
    </div>
  );
}
