"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { clientFailureSummarySchema, type ClientFailureSummary } from "@openwork/types/den/diagnostics";
import { DenButton } from "../../app/(den)/_components/ui/button";
import { DenNotice } from "../../app/(den)/_components/ui/notice";
import { DenPageHeader } from "../../app/(den)/_components/ui/page-header";
import { DenSegmented } from "../../app/(den)/_components/ui/segmented";
import { DenSkeleton } from "../../app/(den)/_components/ui/skeleton";
import { DenTable, type DenTableColumn } from "../../app/(den)/_components/ui/table";
import { AdminAccessScreen } from "./admin-access-screen";
import { requestAdmin, type AdminResult } from "./admin-request";

type ClassRow = ClientFailureSummary["components"][number];
type VersionRow = ClientFailureSummary["versions"][number];
type ReportRow = ClientFailureSummary["latest"][number];
const date = (value: string) => new Date(value).toLocaleString();
const totals: DenTableColumn<ClassRow | VersionRow>[] = [
  { key: "reports", header: "Reports", align: "right", render: (row) => row.reports.toLocaleString() },
  { key: "failures", header: "Failures", align: "right", render: (row) => row.failures.toLocaleString() },
  { key: "organizations", header: "Organizations affected", align: "right", render: (row) => row.organizations.toLocaleString() },
  { key: "latest", header: "Latest occurrence", render: (row) => date(row.latestOccurrence) },
];
const classes: DenTableColumn<ClassRow>[] = [
  { key: "component", header: "Component", render: (row) => row.component.replaceAll("_", " ") },
  { key: "reason", header: "Reason", render: (row) => row.reason.replaceAll("_", " ") },
  ...totals,
];
const versions: DenTableColumn<VersionRow>[] = [
  { key: "version", header: "App version", render: (row) => row.appVersion }, ...totals,
];
const latest: DenTableColumn<ReportRow>[] = [
  { key: "at", header: "Occurred", render: (row) => date(row.occurredAt) },
  { key: "organization", header: "Organization", render: (row) => <Link className="underline" href={`/admin/organizations/${encodeURIComponent(row.organizationId)}`}>{row.organizationId}</Link> },
  { key: "component", header: "Component", render: (row) => row.component.replaceAll("_", " ") },
  { key: "phase", header: "Phase", render: (row) => row.phase },
  { key: "reason", header: "Reason", render: (row) => row.reason.replaceAll("_", " ") },
  { key: "version", header: "App version", render: (row) => row.appVersion },
  { key: "platform", header: "Platform", render: (row) => `${row.platform} ${row.arch}` },
  { key: "count", header: "Failures", align: "right", render: (row) => row.count.toLocaleString() },
];
function parse(payload: unknown) {
  const parsed = clientFailureSummarySchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}
export function ClientFailuresPage() {
  const [days, setDays] = useState("14");
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [state, setState] = useState<AdminResult<ClientFailureSummary> | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void requestAdmin(`/v1/admin/client-failures?days=${days}`, parse, controller.signal).then((result) => {
      if (!controller.signal.aborted) { setState(result); setLoading(false); }
    }).catch(() => {
      if (!controller.signal.aborted) { setState({ access: "error", message: "Client failures could not be verified. Try again." }); setLoading(false); }
    });
    return () => controller.abort();
  }, [days, attempt]);
  if (state && state.access !== "ready" && state.access !== "error") return <AdminAccessScreen state={state.access} message={state.message} />;
  const data = state?.access === "ready" ? state.data : null;
  return <div className="flex flex-col gap-5" data-testid="admin-client-failures">
    <DenPageHeader size="compact" title="Client failures" action={<DenButton variant="secondary" onClick={() => setAttempt((value) => value + 1)}>Refresh</DenButton>} />
    <DenSegmented aria-label="Time window" value={days} onChange={setDays} options={[{ value: "1", label: "24 hours" }, { value: "7", label: "7 days" }, { value: "14", label: "14 days" }, { value: "30", label: "30 days" }, { value: "90", label: "90 days" }]} />
    {state?.access === "error" ? <DenNotice message={state.message} action={<DenButton variant="plain" onClick={() => setAttempt((value) => value + 1)}>Try again</DenButton>} /> : null}
    {loading ? <div className="grid gap-3" role="status" aria-label="Loading client failures">{[1, 2, 3, 4].map((row) => <DenSkeleton key={row} className="h-10 w-full" />)}</div> : null}
    {!loading && data ? !data.latest.length ? <DenNotice tone="neutral" message="Unknown: no client failures reported in this window. Verify reporting is enabled for the organization and the desktop has connected." /> : <>
      <section aria-label="Failures by component and reason"><DenTable density="compact" rows={data.components} columns={classes} getRowKey={(row) => `${row.component}:${row.reason}`} /></section>
      <section aria-labelledby="failure-versions"><h2 id="failure-versions" className="mb-3 text-sm font-medium">By app version</h2><DenTable density="compact" rows={data.versions} columns={versions} getRowKey={(row) => row.appVersion} /></section>
      <section aria-labelledby="failure-latest"><h2 id="failure-latest" className="mb-3 text-sm font-medium">Latest 100 reports</h2><DenTable density="compact" rows={data.latest} columns={latest} getRowKey={(row) => row.reportId} /></section>
    </> : null}
  </div>;
}
