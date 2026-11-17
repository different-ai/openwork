"use client";

import { ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { adminOrganizationTimelineSchema, adminTimelineKindLabels, adminTimelineSourceLabels, adminTimelineSourceSchema, type AdminOrganizationTimeline, type AdminTimelineEntry } from "@openwork/types/den/admin-organization-timeline";
import { DenButton } from "../../app/(den)/_components/ui/button";
import { DenCheckbox } from "../../app/(den)/_components/ui/checkbox";
import { DenSelect } from "../../app/(den)/_components/ui/select";
import { DenSkeleton } from "../../app/(den)/_components/ui/skeleton";
import { DenTable, type DenTableColumn } from "../../app/(den)/_components/ui/table";
import type { AdminFeatureAccessFailure } from "./admin-organization-feature-controls";
import { requestAdmin } from "./admin-request";

const time = (at: string) => new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
const count = (value: number) => new Intl.NumberFormat().format(value);
type SourceSummary = AdminOrganizationTimeline["sources"][number];
const summaryColumns: DenTableColumn<SourceSummary>[] = [
  { key: "source", header: "Source", render: (row) => adminTimelineSourceLabels[row.source] },
  { key: "reports", header: "Reports", align: "right", render: (row) => `${row.limited ? "At least " : ""}${count(row.count)}` },
  { key: "failures", header: "Failures", align: "right", render: (row) => <span className={row.failureCount ? "text-red-700" : undefined}>{row.limited ? "At least " : ""}{count(row.failureCount)}</span> },
  { key: "state", header: "Recorded state", render: (row) => row.count === 0 ? "Unknown — no reports" : row.outcome === "failed" ? "Failures reported" : row.outcome === "unknown" ? "Not fully known" : "No recorded failures" },
  { key: "last", header: "Last seen", render: (row) => row.lastSeenAt ? time(row.lastSeenAt) : "Not reported" },
];
const entryColumns: DenTableColumn<AdminTimelineEntry>[] = [
  { key: "at", header: "When", render: (entry) => <time dateTime={entry.at} className="whitespace-nowrap tabular-nums">{time(entry.at)}</time> },
  { key: "source", header: "Source", render: (entry) => adminTimelineSourceLabels[entry.source] },
  { key: "kind", header: "Activity", render: (entry) => adminTimelineKindLabels[entry.kind] },
  { key: "outcome", header: "Outcome", render: (entry) => <span className={entry.outcome === "failed" ? "text-red-700" : "text-gray-500"}>{entry.outcome === "failed" ? "Failed" : entry.outcome === "ok" ? "Completed" : "Unknown"}</span> },
];

export function AdminOrganizationTimeline({ organizationId, refreshKey, onAccessFailure }: {
  organizationId: string; refreshKey: number; onAccessFailure: (failure: AdminFeatureAccessFailure) => void;
}) {
  const [source, setSource] = useState("");
  const [failuresOnly, setFailuresOnly] = useState(false);
  const [days, setDays] = useState("7");
  const [retryKey, setRetryKey] = useState(0);
  const [snapshot, setSnapshot] = useState<{ key: string; data: AdminOrganizationTimeline } | null>(null);
  const [loading, setLoading] = useState(true);
  const [moreCursor, setMoreCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const query = new URLSearchParams({ days, failuresOnly: failuresOnly ? "1" : "0" });
  if (source) query.set("source", source);
  const path = `/v1/admin/organizations/${encodeURIComponent(organizationId)}/timeline?${query}`;
  const key = `${path}:${refreshKey}:${retryKey}`;
  const data = snapshot?.key === path ? snapshot.data : null;

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setMoreCursor(null);
    setError(null);
    void requestAdmin(path, (payload) => adminOrganizationTimelineSchema.safeParse(payload).data ?? null, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.access === "ready") setSnapshot({ key: path, data: result.data });
      else if (result.access === "error") setError(result.message);
      else { setSnapshot(null); onAccessFailure({ access: result.access, message: result.message }); }
    }).catch(() => { if (!controller.signal.aborted) setError("Could not read the timeline. Try again."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [path, key, onAccessFailure]);

  useEffect(() => {
    if (!moreCursor) return;
    const controller = new AbortController();
    const cursor = moreCursor;
    void requestAdmin(`${path}&cursor=${encodeURIComponent(cursor)}`, (payload) => adminOrganizationTimelineSchema.safeParse(payload).data ?? null, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.access === "ready") setSnapshot((current) => current?.key === path && current.data.nextCursor === cursor ? {
        key: path, data: { ...result.data, entries: [...current.data.entries, ...result.data.entries] },
      } : current);
      else if (result.access === "error") setError(result.message);
      else { setSnapshot(null); onAccessFailure({ access: result.access, message: result.message }); }
    }).catch(() => { if (!controller.signal.aborted) setError("Could not read more activity. Try Load more again."); })
      .finally(() => { if (!controller.signal.aborted) setMoreCursor(null); });
    return () => controller.abort();
  }, [moreCursor, path, key, onAccessFailure]);

  return <section aria-label="Failure and activity timeline" aria-busy={loading || moreCursor !== null} data-testid="admin-organization-timeline" className="py-5">
    <div className="flex flex-wrap items-end gap-4">
      <label className="space-y-1 text-xs text-gray-500"><span className="block">Window</span><DenSelect aria-label="Timeline window" size="sm" value={days} onChange={(event) => setDays(event.target.value)}><option value="7">Last 7 days</option><option value="30">Last 30 days</option></DenSelect></label>
      <label className="space-y-1 text-xs text-gray-500"><span className="block">Source</span><DenSelect aria-label="Timeline source" size="sm" value={source} onChange={(event) => setSource(event.target.value)}><option value="">All sources</option>{adminTimelineSourceSchema.options.map((value) => <option key={value} value={value}>{adminTimelineSourceLabels[value]}</option>)}</DenSelect></label>
      <label className="flex h-8 items-center gap-2 text-sm text-gray-700"><DenCheckbox checked={failuresOnly} onCheckedChange={setFailuresOnly} />Failures only</label>
    </div>
    {error ? <div role="alert" className="mt-4 flex items-center gap-3 text-sm text-red-700">{error}{!data ? <DenButton variant="secondary" size="sm" onClick={() => setRetryKey((value) => value + 1)}>Try again</DenButton> : null}</div> : null}
    {loading && !data ? <div aria-label="Loading timeline" aria-busy="true" className="mt-5 space-y-3"><DenSkeleton className="h-56 w-full" /><DenSkeleton className="h-96 w-full" /></div> : null}
    {data ? <>
      <div className="mt-5" data-testid="admin-timeline-summary"><DenTable density="compact" columns={summaryColumns} rows={data.sources} getRowKey={(row) => row.source} /></div>
      <details className="group mt-4 text-xs text-gray-500"><summary className="flex cursor-pointer list-none items-center gap-1"><ChevronRight size={16} strokeWidth={1.5} className="group-open:rotate-90" />Report coverage</summary>
        <ul className="mt-3 space-y-2">{data.sources.map((row) => <li key={row.source}><span className="font-medium">{adminTimelineSourceLabels[row.source]}: </span>{row.coverage}{row.limited ? " Counts are lower bounds from the latest 10,000 reports." : ""}</li>)}{data.excludedSources.map((row) => <li key={row.source}><span className="font-medium">{row.source} not included: </span>{row.reason}</li>)}</ul>
      </details>
      <div className="mb-3 mt-6 flex flex-wrap items-baseline justify-between gap-2"><h2 className="text-sm font-semibold text-gray-900">Failure and activity timeline</h2><span className="text-xs text-gray-500">{time(data.window.since)} – {time(data.window.until)}</span></div>
      {data.entries.length ? <DenTable density="compact" columns={entryColumns} rows={data.entries} getRowKey={(entry) => `${entry.source}:${entry.recordId}`} renderRowDetail={(entry) => <details className="group text-xs text-gray-500"><summary className="flex cursor-pointer list-none items-center gap-1"><ChevronRight size={16} strokeWidth={1.5} className="group-open:rotate-90" />Record details</summary><dl className="mt-2 space-y-1 font-mono"><div><dt className="inline font-sans">Record: </dt><dd className="inline break-all">{entry.recordId}</dd></div>{entry.memberId ? <div><dt className="inline font-sans">Member: </dt><dd className="inline break-all">{entry.memberId}</dd></div> : null}<div><dt className="inline font-sans">Reason code: </dt><dd className="inline">{entry.kind}</dd></div></dl></details>} /> : <p className="py-8 text-sm text-gray-500">No matching reports in this window. Try all sources, include activity, or choose a longer window.</p>}
      {data.nextCursor ? <div className="mt-4"><DenButton size="sm" variant="secondary" loading={moreCursor !== null} onClick={() => { setError(null); setMoreCursor(data.nextCursor); }}>Load more</DenButton></div> : null}
    </> : null}
  </section>;
}
