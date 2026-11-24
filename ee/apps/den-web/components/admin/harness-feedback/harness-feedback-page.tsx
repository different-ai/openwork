"use client";

import Link from "next/link";
import { ChevronRight, RefreshCw } from "lucide-react";
import { useState } from "react";
import { z } from "zod";
import { DenBadge } from "../../../app/(den)/_components/ui/badge";
import { DenButton } from "../../../app/(den)/_components/ui/button";
import { DenCard } from "../../../app/(den)/_components/ui/card";
import { DenNotice } from "../../../app/(den)/_components/ui/notice";
import { DenPageHeader } from "../../../app/(den)/_components/ui/page-header";
import { AdminAccessScreen } from "../admin-access-screen";
import { useAdminReport } from "../use-admin-report";
import { formatCount } from "../free-auto-usage/format";

const PATH = "/v1/admin/harness-feedback";
const surface = z.enum(["tool", "instructions", "skill", "connector", "environment", "other"]);
const report = z.object({
  id: z.string(), organizationId: z.string(), surface, tool: z.string().nullable(), errorCode: z.string().nullable(),
  state: z.enum(["pending", "classified", "rejected", "needs_review"]), createdAt: z.iso.datetime(),
});
const group = z.object({
  id: z.string(), organizationId: z.string(), title: z.string(), categoryLabel: z.string().nullish(), surface, tool: z.string().nullable(),
  reportCount: z.number(), firstSeenAt: z.iso.datetime(), lastSeenAt: z.iso.datetime(), notifyState: z.enum(["pending", "delivered", "failed"]),
});
const inbox = z.object({
  summary: z.object({ groups: z.number(), reports: z.number(), ungrouped: z.number(), pending: z.number() }),
  groups: z.array(group), ungroupedReports: z.array(report),
});
const detail = z.object({ reports: z.array(report.extend({ symptom: z.string(), workaround: z.string().nullable() })) });
const parseInbox = (input: unknown) => inbox.safeParse(input).data ?? null;
const parseDetail = (input: unknown) => detail.safeParse(input).data ?? null;

const surfaces: Record<z.infer<typeof surface>, string> = {
  tool: "Tool", instructions: "Instructions", skill: "Skill", connector: "Connection", environment: "Environment", other: "Other",
};
const states: Record<z.infer<typeof report>["state"], string> = {
  pending: "Awaiting classification", classified: "Classified", rejected: "Not a harness issue", needs_review: "Needs review",
};
const notifications: Record<z.infer<typeof group>["notifyState"], string> = {
  pending: "Not posted", delivered: "Posted to Slack", failed: "Slack post failed",
};

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
function DateTime({ value }: { value: string }) {
  return <time dateTime={value}>{dateFormat.format(new Date(value))}</time>;
}

function Organization({ id }: { id: string }) {
  return <Link href={`/admin/organizations/${encodeURIComponent(id)}`} className="break-all font-mono underline underline-offset-2">{id}</Link>;
}

function ReportMetadata({ item }: { item: z.infer<typeof report> }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-gray-600">
      <DenBadge tone={item.state === "needs_review" ? "warning" : "neutral"}>{states[item.state]}</DenBadge>
      <span>{surfaces[item.surface]}</span>
      {item.tool ? <code className="break-all">{item.tool}</code> : null}
      {item.errorCode ? <span>Error: <code className="break-all">{item.errorCode}</code></span> : null}
      <DateTime value={item.createdAt} />
    </div>
  );
}

function ReportDetails({ path, revision, groupCount }: { path: string; revision: number; groupCount?: number }) {
  const [retry, setRetry] = useState(0);
  const result = useAdminReport(path, parseDetail, revision + retry);
  if (result.status === "loading" && !result.data) return <div role="status" aria-label="Loading reports" className="h-16 animate-pulse rounded-md bg-gray-100 motion-reduce:animate-none" />;
  if (result.status !== "loading" && result.status !== "ready") return <DenNotice message={<span>{result.message} <button type="button" className="underline underline-offset-2" onClick={() => setRetry((value) => value + 1)}>Try again</button></span>} />;
  const reports = result.data?.reports ?? [];
  return reports.length ? (
    <>
      {groupCount !== undefined && groupCount > reports.length ? <p className="text-sm text-gray-600">Showing the latest {formatCount(reports.length)} reports.</p> : null}
      <ul className="divide-y divide-gray-100">
        {reports.map((entry) => (
          <li key={entry.id} className="flex flex-col gap-2 py-3 text-sm">
            {groupCount !== undefined ? <ReportMetadata item={entry} /> : null}
            <p className="whitespace-pre-wrap break-words">{entry.symptom}</p>
            {entry.workaround ? <p className="whitespace-pre-wrap break-words"><span className="font-medium">Workaround:</span> {entry.workaround}</p> : null}
          </li>
        ))}
      </ul>
    </>
  ) : <p className="text-sm text-gray-600">No reports found.</p>;
}

function DisclosureRow({ summary, children }: { summary: React.ReactNode; children: (open: boolean) => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="group py-3" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-500 [&::-webkit-details-marker]:hidden">
        <ChevronRight size={16} strokeWidth={1.5} aria-hidden="true" className="shrink-0 text-gray-500 transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none" />
        {summary}
      </summary>
      {children(open)}
    </details>
  );
}

function GroupRow({ item, revision }: { item: z.infer<typeof group>; revision: number }) {
  return (
    <div className="border-t border-gray-100">
      <DisclosureRow summary={<>
        <span className="min-w-0 flex-1 break-words text-sm font-medium">{item.title}</span>
        <span className="shrink-0 text-sm text-gray-600">{formatCount(item.reportCount)} {item.reportCount === 1 ? "report" : "reports"}</span>
      </>}>
        {(open) => <>
          <div className="ml-6 mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-gray-600">
            <Organization id={item.organizationId} />
            <span>{surfaces[item.surface]}</span>
            {item.categoryLabel ? <span>{item.categoryLabel}</span> : null}
            {item.tool ? <code className="break-all">{item.tool}</code> : null}
            <DenBadge tone={item.notifyState === "failed" ? "warning" : "neutral"}>{notifications[item.notifyState]}</DenBadge>
            <span>First seen <DateTime value={item.firstSeenAt} /></span>
            <span>Last seen <DateTime value={item.lastSeenAt} /></span>
          </div>
          {open ? <div className="ml-6 mt-3"><ReportDetails path={`${PATH}/${encodeURIComponent(item.organizationId)}/${encodeURIComponent(item.id)}`} revision={revision} groupCount={item.reportCount} /></div> : null}
        </>}
      </DisclosureRow>
    </div>
  );
}

function UngroupedReportRow({ item, revision }: { item: z.infer<typeof report>; revision: number }) {
  return (
    <li>
      <DisclosureRow summary={<ReportMetadata item={item} />}>
        {(open) => open ? (
          <div className="ml-6 mt-2 text-sm">
            <Organization id={item.organizationId} />
            <ReportDetails path={`${PATH}/reports/${encodeURIComponent(item.organizationId)}/${encodeURIComponent(item.id)}`} revision={revision} />
          </div>
        ) : null}
      </DisclosureRow>
    </li>
  );
}

export function HarnessFeedbackPage() {
  const [revision, setRevision] = useState(0);
  const refresh = () => setRevision((value) => value + 1);
  const result = useAdminReport(PATH, parseInbox, revision);
  if (result.status === "signed-out" || result.status === "forbidden" || (result.status === "error" && !result.data)) {
    return <AdminAccessScreen state={result.status} message={result.message} onRetry={refresh} />;
  }
  const data = result.data;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <DenPageHeader title="Harness feedback" size="compact" />
        <DenButton size="sm" variant="secondary" icon={RefreshCw} loading={result.status === "loading"} onClick={refresh}>Refresh</DenButton>
      </div>
      {result.status === "error" ? <DenNotice message="Couldn't refresh feedback. The last loaded results are still shown." /> : null}
      {!data ? <div role="status" aria-label="Loading feedback" className="h-48 animate-pulse rounded-lg bg-gray-100 motion-reduce:animate-none" /> : (
        <>
          <dl className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            {[["Reports", data.summary.reports], ["Groups", data.summary.groups], ["Ungrouped", data.summary.ungrouped], ["Awaiting classification", data.summary.pending]].map(([label, count]) => (
              <div className="flex gap-2" key={label}><dt className="text-gray-600">{label}</dt><dd className="font-medium tabular-nums">{formatCount(Number(count))}</dd></div>
            ))}
          </dl>
          {data.summary.reports === 0 && data.summary.groups === 0 ? (
            <DenCard><p role="status" className="text-sm text-gray-600">No harness feedback yet. Reports from agents in approved organizations will appear here.</p></DenCard>
          ) : (
            <>
              <DenCard className="!rounded-lg">
                <h2 className="mb-3 text-sm font-semibold">Groups</h2>
                {data.summary.groups > data.groups.length ? <p className="mb-3 text-sm text-gray-600">Showing the latest {formatCount(data.groups.length)} groups.</p> : null}
                {data.groups.length ? data.groups.map((item) => <GroupRow key={item.id} item={item} revision={revision} />) : <p className="text-sm text-gray-600">No groups yet.</p>}
              </DenCard>
              <DenCard className="!rounded-lg">
                <h2 className="mb-3 text-sm font-semibold">Ungrouped reports</h2>
                {data.summary.ungrouped > data.ungroupedReports.length ? <p className="mb-3 text-sm text-gray-600">Showing {formatCount(data.ungroupedReports.length)} ungrouped reports, with reports that need review first.</p> : null}
                {data.ungroupedReports.length ? (
                  <ul className="divide-y divide-gray-100">
                    {data.ungroupedReports.map((item) => <UngroupedReportRow key={item.id} item={item} revision={revision} />)}
                  </ul>
                ) : <p className="text-sm text-gray-600">No ungrouped reports.</p>}
              </DenCard>
            </>
          )}
        </>
      )}
    </div>
  );
}
