"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { auditOperationOutcomeSchema, auditOriginSchema, type AuditOperationSummary } from "@openwork/types/den/audit";
import { DenButton } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";
import { DenNotice } from "../../_components/ui/notice";
import { DenPageHeader } from "../../_components/ui/page-header";
import { DenSelect } from "../../_components/ui/select";
import { DenTable } from "../../_components/ui/table";
import { getOrgAccessFlags, type DenOrgContext, type DenOrgMember } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { auditQueryKey, isAuditAccessError, useAuditEventTypes, useAuditOperations, type AuditFilters, type AuditReadError, type AuditScope } from "./audit-logs-data";
import {
  AuditChevron, AuditLocked, AuditOutcome, AuditReadFailure, AuditSkeleton, AuditTime, AuditTimeline, AuditUsage,
  auditActorLabel, auditLabel, auditOriginLabels, auditOutcomeLabels, auditResourceLabel, auditSummaryClass,
} from "./audit-logs-details";

export function getAuditAccess(input: {
  orgId: string | null; orgContext: DenOrgContext | null; orgBusy: boolean; orgError: string | null; mutationBusy: string | null;
}): "checking" | "error" | "locked" | "allowed" {
  if (input.orgBusy || input.mutationBusy === "switch-organization") return "checking";
  if (input.orgError) return "error";
  if (!input.orgId || !input.orgContext || input.orgId !== input.orgContext.organization.id) return "checking";
  return getOrgAccessFlags(input.orgContext.currentMember.role, input.orgContext.currentMember.isOwner, input.orgContext.roles).isAdmin ? "allowed" : "locked";
}

function AuditPage({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return <section aria-label="Audit logs" className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-4 py-6 text-[13px] text-[var(--dls-text-primary)] sm:px-6">
    <DenPageHeader size="compact" title="Audit logs" action={action} />{children}
  </section>;
}

export function AuditLogsScreen() {
  const dashboard = useOrgDashboard();
  const access = getAuditAccess(dashboard);
  if (access === "error") return <AuditPage><DenNotice tone="error" message="Could not verify workspace access. Try again." /><DenButton variant="secondary" onClick={() => void dashboard.refreshOrgData()}>Retry access check</DenButton></AuditPage>;
  if (access === "checking") return <AuditPage><AuditSkeleton /></AuditPage>;
  if (access === "locked" || !dashboard.orgContext || !dashboard.orgId) return <AuditPage><AuditLocked /></AuditPage>;
  const member = dashboard.orgContext.currentMember;
  return <AuditLogsContent key={JSON.stringify([dashboard.orgId, member.id, member.userId, member.role, member.isOwner])} scope={{ orgId: dashboard.orgId, memberId: member.id }} members={dashboard.orgContext.members} />;
}

function AuditFiltersForm({ filters, members, operations, eventTypes, eventTypesPending, onApply }: {
  filters: AuditFilters; members: readonly DenOrgMember[]; operations: AuditOperationSummary[];
  eventTypes: readonly string[]; eventTypesPending: boolean; onApply: (filters: AuditFilters) => void;
}) {
  const [draft, setDraft] = useState(filters);
  function localDate(value?: string) {
    if (!value) return "";
    const date = new Date(value);
    return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  }
  const [from, setFrom] = useState(localDate(filters.from));
  const [to, setTo] = useState(localDate(filters.to));
  const [error, setError] = useState<string | null>(null);
  const actions = [...new Set([...eventTypes, ...(draft.action ? [draft.action] : [])])].sort();
  const actors = new Map(members.flatMap((member) => member.userId ? [[member.userId, member.user.name] satisfies [string, string]] : []));
  for (const operation of operations) if (operation.initiatingActor.id && !actors.has(operation.initiatingActor.id)) actors.set(operation.initiatingActor.id, auditActorLabel(operation.initiatingActor, members));
  if (draft.actorId && !actors.has(draft.actorId)) actors.set(draft.actorId, "Previously selected actor");
  function apply(event: FormEvent) {
    event.preventDefault();
    if ((from && !Number.isFinite(Date.parse(from))) || (to && !Number.isFinite(Date.parse(to))) || (from && to && Date.parse(from) > Date.parse(to))) {
      setError("Choose a valid date range with the start before the end.");
      return;
    }
    setError(null);
    onApply({ ...draft, searchId: draft.searchId?.trim() || undefined, from: from ? new Date(from).toISOString() : undefined, to: to ? new Date(to).toISOString() : undefined });
  }
  function clear() { setDraft({}); setFrom(""); setTo(""); setError(null); onApply({}); }
  return <form onSubmit={apply} aria-label="Filter audit operations" className="flex flex-col gap-3">
    <div className="flex flex-wrap items-end gap-3" data-testid="audit-primary-filters">
      <label className="flex min-w-48 flex-1 flex-col gap-1">From (local time)<DenInput type="datetime-local" aria-label="From (local time)" title="Operation start time" value={from} onChange={(event) => setFrom(event.target.value)} aria-invalid={Boolean(error)} /></label>
      <label className="flex min-w-48 flex-1 flex-col gap-1">To (local time)<DenInput type="datetime-local" aria-label="To (local time)" title="Operation start time" value={to} onChange={(event) => setTo(event.target.value)} aria-invalid={Boolean(error)} /></label>
      <label className="flex min-w-56 flex-1 flex-col gap-1" aria-busy={eventTypesPending}>Event type<DenSelect aria-label="Event type" disabled={eventTypesPending} value={draft.action ?? ""} onChange={(event) => setDraft({ ...draft, action: event.target.value || undefined })}>
        <option value="">All event types</option>{actions.map((action) => <option key={action} value={action}>{auditLabel(action)}</option>)}
      </DenSelect></label>
      <label className="flex min-w-56 flex-1 flex-col gap-1">Search IDs<DenInput aria-label="Search IDs" placeholder="Operation, event, request, or resource ID" title="Exact operation, event, request, or resource ID" maxLength={255} value={draft.searchId ?? ""} onChange={(event) => setDraft({ ...draft, searchId: event.target.value })} /></label>
      <DenButton type="submit" variant="secondary">Apply filters</DenButton><DenButton variant="ghost" onClick={clear}>Clear filters</DenButton>
    </div>
    <details className="group"><summary className={auditSummaryClass}><AuditChevron />More filters</summary>
      <div className="flex flex-wrap gap-3 pb-3">
        <label className="flex min-w-44 flex-1 flex-col gap-1">Actor<DenSelect aria-label="Actor" value={draft.actorId ?? ""} onChange={(event) => setDraft({ ...draft, actorId: event.target.value || undefined })}>
          <option value="">All actors</option>{[...actors].map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </DenSelect></label>
        <label className="flex min-w-44 flex-1 flex-col gap-1">Result<DenSelect aria-label="Result" value={draft.outcome ?? ""} onChange={(event) => setDraft({ ...draft, outcome: auditOperationOutcomeSchema.safeParse(event.target.value).data })}>
          <option value="">All results</option>{auditOperationOutcomeSchema.options.map((outcome) => <option key={outcome} value={outcome}>{auditOutcomeLabels[outcome]}</option>)}
        </DenSelect></label>
        <label className="flex min-w-44 flex-1 flex-col gap-1">Origin<DenSelect aria-label="Origin" value={draft.origin ?? ""} onChange={(event) => setDraft({ ...draft, origin: auditOriginSchema.safeParse(event.target.value).data })}>
          <option value="">All origins</option>{auditOriginSchema.options.map((origin) => <option key={origin} value={origin}>{auditOriginLabels[origin]}</option>)}
        </DenSelect></label>
      </div>
    </details>
    {error ? <DenNotice tone="error" message={error} /> : null}
  </form>;
}

export function AuditLogsContent({ scope, members }: { scope: AuditScope; members: readonly DenOrgMember[] }) {
  const client = useQueryClient();
  const [filters, setFilters] = useState<AuditFilters>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [usageOpen, setUsageOpen] = useState(false);
  const [detailAccessError, setDetailAccessError] = useState<AuditReadError | null>(null);
  const query = useAuditOperations(scope, filters);
  const eventTypes = useAuditEventTypes(scope);
  const operations = query.data?.pages.flatMap((page) => page.operations) ?? [];
  const accessError = isAuditAccessError(query.error) ? query.error : isAuditAccessError(eventTypes.error) ? eventTypes.error : detailAccessError;
  const refreshing = query.isFetching || eventTypes.isFetching;
  function applyFilters(next: AuditFilters) { setExpanded(null); setFilters(next); }
  if (accessError) return <AuditPage><AuditLocked error={accessError}>
    <DenButton variant="secondary" disabled={refreshing} onClick={() => {
      setExpanded(null); setUsageOpen(false);
      void Promise.all([query.refetch(), eventTypes.refetch()]).then((results) => { if (results.every((result) => !result.error)) setDetailAccessError(null); });
    }}>Retry access check</DenButton>
  </AuditLocked></AuditPage>;
  return <AuditPage action={<DenButton variant="secondary" size="sm" disabled={refreshing} onClick={() => void client.invalidateQueries({ queryKey: auditQueryKey(scope) })}>Refresh history</DenButton>}>
    <AuditFiltersForm key={JSON.stringify(filters)} filters={filters} members={members} operations={operations} eventTypes={eventTypes.data?.eventTypes ?? []} eventTypesPending={eventTypes.isPending} onApply={applyFilters} />
    {eventTypes.isError ? <div className="flex flex-wrap items-center gap-3">
      <DenNotice tone="error" message={eventTypes.data ? "Could not refresh event types. Showing the last verified catalog." : "Could not load event types. Try again."} />
      <DenButton variant="secondary" size="sm" disabled={eventTypes.isFetching} onClick={() => void eventTypes.refetch()}>Retry event types</DenButton>
    </div> : null}
    <div aria-busy={query.isFetching}>
      {query.isError ? <AuditReadFailure retained={Boolean(query.data)} verifiedAt={query.dataUpdatedAt} retry={() => { void (query.isFetchNextPageError ? query.fetchNextPage() : query.refetch()); }} busy={query.isFetching} /> : null}
      {query.isPending ? <AuditSkeleton /> : operations.length ? <DenTable<AuditOperationSummary> density="compact" rows={operations} getRowKey={(operation) => operation.id} columns={[
        { key: "action", header: "Operation", render: (operation) => <span className="font-medium">{auditLabel(operation.action)}</span> },
        { key: "actor", header: "Actor", render: (operation) => auditActorLabel(operation.initiatingActor, members) },
        { key: "origin", header: "Origin", render: (operation) => <>{auditOriginLabels[operation.origin]}{operation.originTrust === "reported" ? <span className="block text-xs text-[var(--dls-text-secondary)]">Reported origin</span> : null}</> },
        { key: "started", header: "Started", render: (operation) => <AuditTime value={operation.startedAt} /> },
        { key: "outcome", header: "Result", render: (operation) => <AuditOutcome outcome={operation.outcome} /> },
        { key: "resources", header: "First recorded target", render: (operation) => operation.resources.filter((resource) => resource.relationship === "target").map(auditResourceLabel).join(", ") || "Not recorded" },
        { key: "details", header: "Details", render: (operation) => <DenButton variant="ghost" size="sm" aria-label={`${expanded === operation.id ? "Hide" : "View"} changes for ${auditLabel(operation.action)}`} aria-expanded={expanded === operation.id} aria-controls={`audit-operation-${operation.id}`} onClick={() => setExpanded(expanded === operation.id ? null : operation.id)}>{expanded === operation.id ? "Hide changes" : "View changes"}</DenButton> },
      ]} renderRowDetail={(operation) => expanded === operation.id ? <div id={`audit-operation-${operation.id}`}>
        <p className="pt-2 text-xs text-[var(--dls-text-secondary)]">{operation.eventCount.toLocaleString()} recorded events</p>
        <AuditTimeline scope={scope} operationId={operation.id} members={members} onAccessError={setDetailAccessError} />
        <details className="group"><summary className={auditSummaryClass}><AuditChevron />Operation identifiers</summary><dl className="flex flex-col gap-2 break-all text-xs"><div><dt>Operation</dt><dd className="font-mono">{operation.id}</dd></div><div><dt>Actor</dt><dd className="font-mono">{operation.initiatingActor.id ?? "Unknown"}</dd></div><div><dt>Scope</dt><dd className="font-mono">{operation.scope}</dd></div></dl></details>
      </div> : null} /> : !query.isError ? <div role="status" className="flex flex-col items-start gap-3 py-8" data-testid="audit-empty">
        <p>{Object.values(filters).some(Boolean) ? "No operations match these filters." : "No retained audit operations yet. Review capture and storage for the current capture state."}</p>
        {Object.values(filters).some(Boolean) ? <DenButton variant="secondary" size="sm" onClick={() => applyFilters({})}>Show all operations</DenButton> : null}
      </div> : null}
    </div>
    {query.hasNextPage ? <div className="flex items-center justify-between gap-3"><span className="text-[var(--dls-text-secondary)]">{operations.length} operations loaded</span><DenButton variant="secondary" size="sm" disabled={query.isFetching} onClick={() => void query.fetchNextPage()}>Load more operations</DenButton></div> : null}
    <details className="group border-t border-[var(--dls-border)]" onToggle={(event) => { if (event.currentTarget.open) setUsageOpen(true); }}>
      <summary className={auditSummaryClass}><AuditChevron />Capture and storage</summary>
      {usageOpen ? <AuditUsage scope={scope} onAccessError={setDetailAccessError} /> : null}
    </details>
  </AuditPage>;
}
