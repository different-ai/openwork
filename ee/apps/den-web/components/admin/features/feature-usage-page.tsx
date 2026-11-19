"use client";

import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { FEATURES, type FeatureKey } from "@openwork/features";
import { DenButton } from "../../../app/(den)/_components/ui/button";
import { DenNotice } from "../../../app/(den)/_components/ui/notice";
import { DenPageHeader } from "../../../app/(den)/_components/ui/page-header";
import { DenSegmented } from "../../../app/(den)/_components/ui/segmented";
import { DenSkeleton } from "../../../app/(den)/_components/ui/skeleton";
import { DenTable, type DenTableColumn } from "../../../app/(den)/_components/ui/table";
import { requestAdmin } from "../admin-request";
import {
  coverageLabel,
  dayBars,
  FEATURE_USAGE_RANGES,
  healthLabel,
  healthTone,
  lastActivity,
  parseFeatureUsageDetail,
  parseFeatureUsageReport,
  reasonLabel,
  showsSkips,
  sortFeatureUsage,
  unitCount,
  unitHeading,
  type FeatureOrganizationRow,
  type FeatureOutcomes,
  type FeatureUsageDetail,
  type FeatureUsageRange,
  type FeatureUsageReport,
  type FeatureUsageRow,
} from "./feature-usage-model";

/**
 * /admin › Features: every feature across organizations, whether it is used and working. One row per feature
 * (DESIGN.md S2); a row opens to its totals, reasons and organizations (S3). Counts only.
 */

const day = (value: string) => new Date(value).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });
const dayAndYear = (value: string) => new Date(value).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const number = (value: number) => value.toLocaleString("en-US");

const TONE_CLASS: Record<ReturnType<typeof healthTone>, string> = {
  failure: "text-red-700",
  attention: "text-amber-800",
  neutral: "text-gray-900",
  quiet: "text-gray-500",
};

function DayBars({ outcomes }: { outcomes: FeatureOutcomes }) {
  const bars = dayBars(outcomes.days);
  const failed = outcomes.days.reduce((sum, entry) => sum + entry.failed, 0);
  const label = `${unitCount(outcomes.runs, outcomes.unit)} in ${outcomes.days.length} days${failed ? `, ${number(failed)} failed` : ""}`;
  return (
    <div role="img" aria-label={label} title={label} className="flex h-6 items-end gap-px" data-testid="admin-feature-usage-bars">
      {bars.map((bar) => (
        <div key={bar.day} className="relative flex h-full w-1.5 flex-col justify-end rounded-[1px] bg-gray-100" title={`${day(bar.day)}: ${unitCount(bar.runs, outcomes.unit)}${bar.failed ? `, ${number(bar.failed)} failed` : ""}`}>
          <div className="w-full rounded-[1px] bg-slate-500" style={{ height: `${(bar.height - bar.failedHeight) * 100}%` }} />
          {bar.failedHeight > 0 ? <div className="w-full rounded-[1px] bg-red-600" data-failed="true" style={{ height: `${bar.failedHeight * 100}%` }} /> : null}
        </div>
      ))}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-gray-500">{label}</dt>
      <dd className="text-[13px] font-medium tabular-nums text-gray-900">{value}</dd>
    </div>
  );
}

function OrganizationRows({ detail }: { detail: FeatureUsageDetail }) {
  const outcomeColumns: DenTableColumn<FeatureOrganizationRow>[] = detail.outcomes ? [
    { key: "runs", header: unitHeading(detail.outcomes.unit), width: "90px", align: "right", render: (row) => number(row.outcomes?.runs ?? 0) },
    { key: "failed", header: "Failed", width: "80px", align: "right", render: (row) => row.outcomes?.failed ? <span className="text-red-700">{number(row.outcomes.failed)}</span> : "0" },
    ...(showsSkips(detail.outcomes.unit) ? [{ key: "skipped", header: "Skipped", width: "80px", align: "right", render: (row) => number(row.outcomes?.skipped ?? 0) } satisfies DenTableColumn<FeatureOrganizationRow>] : []),
  ] : [];
  const columns: DenTableColumn<FeatureOrganizationRow>[] = [
    { key: "organization", header: "Organization", render: (row) => (
      <Link href={`/admin/organizations/${encodeURIComponent(row.organizationId)}/features`} prefetch={false} className="font-medium text-gray-900 underline-offset-2 hover:underline"
        data-testid={`admin-feature-usage-organization-${row.organizationId}`}>
        {row.name}
      </Link>
    ) },
    { key: "state", header: "Feature", width: "80px", render: (row) => (row.enabled ? "On" : <span className="text-gray-500">Off</span>) },
    { key: "members", header: "Members using", width: "140px", align: "right", render: (row) => number(row.membersUsing) },
    ...outcomeColumns,
    { key: "last", header: "Last use", width: "110px", render: (row) => {
      const last = lastActivity(row);
      return last ? dayAndYear(last) : <span className="text-gray-500">Never</span>;
    } },
  ];
  return <DenTable columns={columns} rows={detail.byOrganization} getRowKey={(row) => row.organizationId} density="compact" emptyLabel="No organization has it on or used it in this range." />;
}

function FeatureDetail({ detail }: { detail: FeatureUsageDetail }) {
  const outcomes = detail.outcomes;
  const coverage = outcomes ? coverageLabel(outcomes.coverage, day) : null;
  return (
    <div className="flex flex-col gap-4 pl-5 pt-1" data-testid={`admin-feature-usage-detail-${detail.key}`}>
      {outcomes ? (
        <section aria-label="Totals" className="flex flex-col gap-1">
          <dl className="flex flex-wrap gap-x-10 gap-y-2">
            <Stat label={unitHeading(outcomes.unit)} value={number(outcomes.runs)} />
            <Stat label="Succeeded" value={number(outcomes.succeeded)} />
            <Stat label="Failed" value={number(outcomes.failed)} />
            {showsSkips(outcomes.unit) ? <Stat label="Skipped" value={number(outcomes.skipped)} /> : null}
            {/* Delivered only adds something when it differs from what succeeded (an agent's checks vs the messages they sent). */}
            {outcomes.delivered !== null && outcomes.delivered !== outcomes.succeeded ? <Stat label="Messages sent" value={number(outcomes.delivered)} /> : null}
            {outcomes.limited !== null ? <Stat label="Hit the limit" value={number(outcomes.limited)} /> : null}
          </dl>
          {coverage ? <p className="text-xs text-gray-500" data-testid="admin-feature-usage-coverage">{coverage}</p> : null}
        </section>
      ) : null}
      {detail.reasons.length > 0 ? (
        <section aria-labelledby={`admin-feature-usage-reasons-${detail.key}`} className="flex flex-col gap-1">
          <h3 id={`admin-feature-usage-reasons-${detail.key}`} className="text-xs font-medium text-gray-500">Why they didn't succeed</h3>
          <ul className="divide-y divide-[var(--dls-border)] border-y border-[var(--dls-border)]" data-testid={`admin-feature-usage-reasons-${detail.key}`}>
            {detail.reasons.map((entry) => (
              <li key={`${entry.outcome}:${entry.reason}`} className="flex min-h-9 items-center justify-between gap-4 py-1.5 text-[13px]">
                <span title={entry.reason} className="min-w-0 text-gray-900">{reasonLabel(entry.reason)}</span>
                <span className={`shrink-0 tabular-nums ${entry.outcome === "failed" ? "text-red-700" : "text-gray-700"}`}>
                  {number(entry.count)} {entry.outcome === "failed" ? "failed" : "skipped"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section aria-label="By organization" data-testid={`admin-feature-usage-organizations-${detail.key}`}>
        <OrganizationRows detail={detail} />
      </section>
    </div>
  );
}

type DetailState = { status: "loading" } | { status: "ready"; detail: FeatureUsageDetail } | { status: "error"; message: string };

function DetailRow({ featureKey, state, onRetry }: { featureKey: FeatureKey; state: DetailState | undefined; onRetry: () => void }) {
  if (!state || state.status === "loading") {
    return (
      <div className="grid gap-2 pl-5 pt-1" role="status" aria-label={`Loading ${FEATURES[featureKey].label}`}>
        <DenSkeleton className="h-9" />
        <DenSkeleton className="h-9" />
        <DenSkeleton className="h-9" />
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="flex items-center gap-3 pl-5 pt-1 text-[13px] text-red-700" role="alert">
        <span>{state.message}</span>
        <DenButton variant="secondary" size="sm" onClick={onRetry}>Retry this feature</DenButton>
      </div>
    );
  }
  return <FeatureDetail detail={state.detail} />;
}

export function FeatureUsagePage() {
  const [range, setRange] = useState<FeatureUsageRange>("7d");
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "ready"; report: FeatureUsageReport }
    | { status: "signed-out" | "forbidden" | "error"; message: string }
  >({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [open, setOpen] = useState<ReadonlySet<FeatureKey>>(new Set());
  const [details, setDetails] = useState<Readonly<Record<string, DetailState>>>({});

  useEffect(() => {
    const controller = new AbortController();
    setState((current) => (current.status === "ready" ? current : { status: "loading" }));
    void requestAdmin(`/v1/admin/feature-usage?range=${range}`, parseFeatureUsageReport, controller.signal).then((result) => {
      if (!controller.signal.aborted) setState(result.access === "ready" ? { status: "ready", report: result.data } : { status: result.access, message: result.message });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setState({ status: "error", message: error instanceof Error ? error.message : "Could not load features." });
    });
    return () => controller.abort();
  }, [range, attempt]);

  const loadDetail = useCallback((key: FeatureKey, forRange: FeatureUsageRange) => {
    const id = `${forRange}:${key}`;
    setDetails((current) => ({ ...current, [id]: { status: "loading" } }));
    void requestAdmin(`/v1/admin/feature-usage/${encodeURIComponent(key)}?range=${forRange}`, parseFeatureUsageDetail).then((result) => {
      setDetails((current) => ({ ...current, [id]: result.access === "ready" ? { status: "ready", detail: result.data } : { status: "error", message: result.message } }));
    }).catch((error: unknown) => {
      setDetails((current) => ({ ...current, [id]: { status: "error", message: error instanceof Error ? error.message : "Could not load this feature." } }));
    });
  }, []);

  // An open row follows the range: its detail loads once per range.
  useEffect(() => {
    for (const key of open) if (!details[`${range}:${key}`]) loadDetail(key, range);
  }, [open, range, details, loadDetail]);

  function toggle(key: FeatureKey) {
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const columns: DenTableColumn<FeatureUsageRow>[] = [
    { key: "feature", header: "Feature", render: (row) => (
      <DenButton variant="plain" size="inline" type="button" aria-expanded={open.has(row.key)} aria-controls={`admin-feature-usage-detail-${row.key}`}
        data-testid={`admin-feature-usage-toggle-${row.key}`} onClick={() => toggle(row.key)} className="-my-1 !h-auto max-w-full items-start text-left">
        <ChevronRight size={14} strokeWidth={1.5} aria-hidden="true" className={`mt-0.5 shrink-0 transition-transform duration-150 ease-out motion-reduce:transition-none ${open.has(row.key) ? "rotate-90" : ""}`} />
        <span className="flex min-w-0 flex-col">
          <span className="whitespace-normal text-[13px] font-medium text-gray-900">{FEATURES[row.key].label}</span>
          <span className="truncate font-mono text-xs font-normal text-gray-500">{row.key}</span>
        </span>
      </DenButton>
    ) },
    { key: "organizations", header: "Orgs on", width: "80px", align: "right", render: (row) => number(row.organizationsOn) },
    { key: "members", header: "Members using", width: "140px", align: "right", render: (row) => number(row.membersUsing) },
    { key: "runs", header: "Runs", width: "120px", align: "right", render: (row) => row.outcomes
      ? <span className="tabular-nums">{unitCount(row.outcomes.runs, row.outcomes.unit)}</span>
      : <span className="text-gray-500"><span aria-hidden="true">–</span><span className="sr-only">Not recorded</span></span> },
    { key: "days", header: range === "7d" ? "Last 7 days" : "Last 30 days", width: range === "7d" ? "96px" : "230px", render: (row) => row.outcomes ? <DayBars outcomes={row.outcomes} /> : null },
    { key: "health", header: "Health", width: "190px", render: (row) => (
      <span data-testid={`admin-feature-usage-health-${row.key}`} className={`font-medium ${TONE_CLASS[healthTone(row.health)]}`}>
        {healthLabel(row.health, row.outcomes?.unit)}
      </span>
    ) },
    { key: "last", header: "Last use", width: "110px", render: (row) => {
      const last = lastActivity(row);
      return last ? dayAndYear(last) : <span className="text-gray-500">Never</span>;
    } },
  ];

  return (
    <div className="flex flex-col gap-5" data-testid="admin-feature-usage">
      <DenPageHeader
        title="Features"
        size="compact"
        caption={state.status === "ready" ? `Across ${number(state.report.organizations)} ${state.report.organizations === 1 ? "organization" : "organizations"}` : undefined}
        action={<DenSegmented aria-label="Range" optionTestId={(value) => `admin-feature-usage-range-${value}`} options={FEATURE_USAGE_RANGES} value={range} onChange={setRange} />}
      />
      {state.status === "signed-out" || state.status === "forbidden" ? <DenNotice tone="warning" message={state.message} /> : null}
      {state.status === "error" ? (
        <div className="flex items-center gap-3" role="alert">
          <DenNotice message={state.message} />
          <DenButton variant="secondary" size="sm" onClick={() => setAttempt((value) => value + 1)}>Retry features</DenButton>
        </div>
      ) : null}
      {state.status === "loading" ? (
        <div className="grid gap-2" role="status" aria-label="Loading features" data-testid="admin-feature-usage-loading">
          {[0, 1, 2, 3, 4, 5].map((row) => <DenSkeleton key={row} className="h-11" />)}
        </div>
      ) : null}
      {state.status === "ready" ? (
        <DenTable
          columns={columns}
          rows={sortFeatureUsage(state.report.features)}
          getRowKey={(row) => row.key}
          density="compact"
          renderRowDetail={(row) => open.has(row.key)
            ? <div id={`admin-feature-usage-detail-${row.key}`}><DetailRow featureKey={row.key} state={details[`${range}:${row.key}`]} onRetry={() => loadDetail(row.key, range)} /></div>
            : null}
          emptyLabel="No features on this deployment."
        />
      ) : null}
    </div>
  );
}
