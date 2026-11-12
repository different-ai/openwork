"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Cog, Plug, SlidersHorizontal } from "lucide-react";
import { COMPACT_INPUT_CLASS, DASHBOARD_PAGE_CLASS } from "../../_components/ui/dashboard-styles";
import { ListRow, RowLaneLabel, RowList, RowListHeader, RowLane, RowListSkeleton, RowTile, StatusLane, TimeLane } from "../_features/computers/computer-rows";
import { PersonLead, RefreshButton, hairline, secondaryText } from "../_features/computers/computer-parts";
import { FilterInput } from "./item-list";
import { auditOperationOutcomeSchema, auditOriginSchema, type AuditOperationSummary } from "@openwork/types/den/audit";
import { DenButton } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";
import { DenNotice } from "../../_components/ui/notice";
import { DenPageHeader } from "../../_components/ui/page-header";
import { DenSelect } from "../../_components/ui/select";
import { getOrgAccessFlags, type DenOrgContext, type DenOrgMember } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

import { auditLogsIntroFacts } from "./audit-logs-intro-facts";
import { useFeatureIntro } from "../_features/feature-intros";
import { auditQueryKey, isAuditAccessError, useAuditEventTypes, useAuditOperations, type AuditFilters, type AuditReadError, type AuditScope } from "./audit-logs-data";
import {
  AuditChevron, AuditLocked, AuditReadFailure, AuditSkeleton, AuditTime, AuditTimeline, AuditUsage,
  auditActionSentence, auditActorLabel, auditLabel, auditOriginLabels, auditOutcomeLabels, auditOutcomeStatus, auditResourceLabel, auditSummaryClass, auditTechnicalSummaryClass,
} from "./audit-logs-details";

export function getAuditAccess(input: {
  orgId: string | null; orgContext: DenOrgContext | null; orgBusy: boolean; orgError: string | null; mutationBusy: string | null;
}): "checking" | "error" | "unavailable" | "locked" | "allowed" {
  if (input.orgBusy || input.mutationBusy === "switch-organization") return "checking";
  if (input.orgError) return "error";
  if (!input.orgId || !input.orgContext || input.orgId !== input.orgContext.organization.id) return "checking";
  if (!input.orgContext.capabilities.auditLogs) return "unavailable";
  return getOrgAccessFlags(input.orgContext.currentMember.role, input.orgContext.currentMember.isOwner, input.orgContext.currentMember.permissions).canViewAuditLogs ? "allowed" : "locked";
}

/** One line of state under the title, as Computers has "2 of 6 online". */
function auditStateLine(shown: number, more: boolean, filtered: boolean) {
  if (!shown) return filtered ? "Nothing matches these filters" : "Nothing recorded yet";
  const count = `${shown.toLocaleString()}${more ? "+" : ""} ${shown === 1 && !more ? "operation" : "operations"}`;
  return filtered ? `${count} match these filters` : `${count}, newest first`;
}

function AuditPage({ children, action, state }: { children: ReactNode; action?: ReactNode; state?: ReactNode }) {
  return <section aria-label="Audit logs" className={`${DASHBOARD_PAGE_CLASS} flex flex-col gap-6 text-[13px] text-[var(--dls-text-primary)]`}>
    <DenPageHeader size="compact" title="Audit logs" state={state} action={action} />{children}
  </section>;
}

export function AuditLogsScreen() {
  const dashboard = useOrgDashboard();
  const access = getAuditAccess(dashboard);
  if (access === "error") return <AuditPage><DenNotice tone="error" message="Could not verify workspace access. Try again." /><DenButton variant="secondary" onClick={() => void dashboard.refreshOrgData()}>Retry access check</DenButton></AuditPage>;
  if (access === "checking") return <AuditPage><AuditSkeleton /></AuditPage>;
  if (access === "unavailable") return <AuditPage><AuditLocked unavailable /></AuditPage>;
  if (access === "locked" || !dashboard.orgContext || !dashboard.orgId) return <AuditPage><AuditLocked /></AuditPage>;
  const member = dashboard.orgContext.currentMember;
  return <AuditLogsContent key={JSON.stringify([dashboard.orgId, member.id, member.userId, member.role, member.isOwner, member.permissions])} scope={{ orgId: dashboard.orgId, memberId: member.id }} members={dashboard.orgContext.members} captureIncluded={dashboard.orgContext.entitlements.auditLogs} />;
}

const PERIODS = [
  { value: "", label: "Any time", hours: 0 },
  { value: "1", label: "Last hour", hours: 1 },
  { value: "24", label: "Last 24 hours", hours: 24 },
  { value: "168", label: "Last 7 days", hours: 168 },
  { value: "720", label: "Last 30 days", hours: 720 },
] as const;

function localDate(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

/**
 * The Computers toolbar for audit history: one line, an ID filter on the left
 * and the facets on the right, each applied as soon as it changes. An exact
 * date range, the actor and the origin sit behind the Filters button.
 */
function AuditToolbar({ filters, members, operations, eventTypes, eventTypesPending, onApply }: {
  filters: AuditFilters; members: readonly DenOrgMember[]; operations: AuditOperationSummary[];
  eventTypes: readonly string[]; eventTypesPending: boolean; onApply: (filters: AuditFilters) => void;
}) {
  const [searchId, setSearchId] = useState(filters.searchId ?? "");
  const [period, setPeriod] = useState("");
  const [more, setMore] = useState(Boolean(filters.to || filters.actorId || filters.origin));
  const [error, setError] = useState<string | null>(null);
  const actions = [...new Set([...eventTypes, ...(filters.action ? [filters.action] : [])])].sort();
  const actors = new Map(members.flatMap((member) => member.userId ? [[member.userId, member.user.name] satisfies [string, string]] : []));
  for (const { initiatingActor: actor, origin } of operations) {
    if (!actor.id || actors.has(actor.id)) continue;
    const label = auditActorLabel(actor, members, origin);
    actors.set(actor.id, label === "Platform administrator" ? `${label} (${actor.id})` : label);
  }
  if (filters.actorId && !actors.has(filters.actorId)) actors.set(filters.actorId, "Previously selected actor");
  const change = (changes: AuditFilters) => { setError(null); onApply({ ...filters, ...changes }); };
  // Typing an ID applies once the person pauses, as the Computers filter does.
  useEffect(() => {
    const next = searchId.trim() || undefined;
    if (next === filters.searchId) return;
    const timeout = window.setTimeout(() => onApply({ ...filters, searchId: next }), 300);
    return () => window.clearTimeout(timeout);
  }, [searchId, filters, onApply]);
  function range(key: "from" | "to", value: string) {
    const next = { ...filters, [key]: value ? new Date(value).toISOString() : undefined };
    if (next.from && next.to && Date.parse(next.from) > Date.parse(next.to)) { setError("Choose a start before the end."); return; }
    setPeriod("");
    change({ [key]: next[key] });
  }
  const filtered = Object.values(filters).some(Boolean);
  function clear() { setSearchId(""); setPeriod(""); setError(null); onApply({}); }
  return <div className="flex flex-col gap-3" role="group" aria-label="Filter audit operations">
    <div className="flex flex-wrap items-center justify-between gap-2" data-testid="audit-primary-filters">
      <FilterInput className="w-64 max-w-full" placeholder="Filter by exact ID" value={searchId} onChange={(value) => setSearchId(value.slice(0, 255))} />
      <div className="flex flex-wrap items-center gap-2">
        {filtered ? <DenButton size="sm" variant="ghost" onClick={clear}>Clear filters</DenButton> : null}
        <div className="w-44" aria-busy={eventTypesPending}><DenSelect size="sm" aria-label="Event type" searchLabel="Search event types" searchEmptyLabel="No event types match. Try another word." disabled={eventTypesPending} value={filters.action ?? ""} onChange={(event) => change({ action: event.target.value || undefined })}>
          <option value="">Any event</option>{actions.map((action) => <option key={action} value={action}>{auditLabel(action)}</option>)}
        </DenSelect></div>
        <div className="w-36"><DenSelect size="sm" aria-label="Result" value={filters.outcome ?? ""} onChange={(event) => change({ outcome: auditOperationOutcomeSchema.safeParse(event.target.value).data })}>
          <option value="">Any result</option>{auditOperationOutcomeSchema.options.map((outcome) => <option key={outcome} value={outcome}>{auditOutcomeLabels[outcome]}</option>)}
        </DenSelect></div>
        <div className="w-36"><DenSelect size="sm" aria-label="Period" value={period} onChange={(event) => {
          const chosen = PERIODS.find((entry) => entry.value === event.target.value) ?? PERIODS[0];
          setPeriod(chosen.value);
          change({ from: chosen.hours ? new Date(Date.now() - chosen.hours * 3_600_000).toISOString() : undefined, to: undefined });
        }}>
          {PERIODS.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
        </DenSelect></div>
        <DenButton size="sm" variant="secondary" icon={SlidersHorizontal} aria-expanded={more} aria-controls="audit-more-filters" onClick={() => setMore((open) => !open)}>Filters</DenButton>
      </div>
    </div>
    {more ? <div id="audit-more-filters" className={`flex flex-wrap items-end gap-3 border-y ${hairline} py-3 text-[12px] ${secondaryText}`}>
      <label className="flex w-56 flex-col gap-1">From<DenInput className={COMPACT_INPUT_CLASS} type="datetime-local" aria-label="From (local time)" value={localDate(filters.from)} onChange={(event) => range("from", event.target.value)} aria-invalid={Boolean(error)} /></label>
      <label className="flex w-56 flex-col gap-1">To<DenInput className={COMPACT_INPUT_CLASS} type="datetime-local" aria-label="To (local time)" value={localDate(filters.to)} onChange={(event) => range("to", event.target.value)} aria-invalid={Boolean(error)} /></label>
      <label className="flex w-44 flex-col gap-1">Actor<DenSelect size="sm" aria-label="Actor" value={filters.actorId ?? ""} onChange={(event) => change({ actorId: event.target.value || undefined })}>
        <option value="">Anyone</option>{[...actors].map(([id, name]) => <option key={id} value={id}>{name}</option>)}
      </DenSelect></label>
      <label className="flex w-44 flex-col gap-1">Origin<DenSelect size="sm" aria-label="Origin" value={filters.origin ?? ""} onChange={(event) => change({ origin: auditOriginSchema.safeParse(event.target.value).data })}>
        <option value="">Any origin</option>{auditOriginSchema.options.map((origin) => <option key={origin} value={origin}>{auditOriginLabels[origin]}</option>)}
      </DenSelect></label>
    </div> : null}
    {error ? <DenNotice tone="error" message={error} /> : null}
  </div>;
}

/** Who did it, in the row's lead lane: a person's initials, or a quiet mark for the system and services. */
function AuditLead({ operation, members }: { operation: AuditOperationSummary; members: readonly DenOrgMember[] }) {
  const actor = operation.initiatingActor;
  if (actor.type === "user" && actor.id) return <PersonLead name={auditActorLabel(actor, members, operation.origin)} />;
  return <RowTile icon={actor.type === "service" ? Plug : Cog} />;
}

/** Lanes of the audit list, as wide as the matching Computers lanes. */
const AUDIT_LANE = { result: "flex w-[120px] @md:w-40", origin: "hidden w-28 @3xl:block", time: "hidden w-24 @2xl:block" } as const;

function AuditCompactOperations({ operations, scope, members, expanded, onExpand, onAccessError }: {
  operations: AuditOperationSummary[]; scope: AuditScope; members: readonly DenOrgMember[]; expanded: string | null;
  onExpand: (id: string | null) => void; onAccessError: (error: AuditReadError) => void;
}) {
  const now = Date.now();
  return <RowList label="Audit operations" testId="audit-compact-list" header={<RowListHeader lead="Activity" chevron>
    <RowLaneLabel lane={AUDIT_LANE.result}>Result</RowLaneLabel>
    <RowLaneLabel lane={AUDIT_LANE.origin}>Origin</RowLaneLabel>
    <RowLaneLabel lane={AUDIT_LANE.time}>When</RowLaneLabel>
  </RowListHeader>}>
    {operations.map((operation) => {
      const open = expanded === operation.id;
      const targets = [...new Set(operation.resources.filter((resource) => resource.relationship === "target").map((resource) => auditResourceLabel(resource)))].join(", ");
      return <ListRow key={operation.id} lead={<AuditLead operation={operation} members={members} />}
        name={`${auditActorLabel(operation.initiatingActor, members, operation.origin)} ${auditActionSentence(operation.action)}`}
        secondLine={targets}
        testId={`audit-operation-toggle-${operation.id}`} rowTestId="audit-compact-operation"
        toggle={{ expanded: open, controls: `audit-operation-${operation.id}`, onToggle: () => onExpand(open ? null : operation.id) }}
        lanes={<>
          <StatusLane lane={AUDIT_LANE.result} {...auditOutcomeStatus(operation.outcome)} />
          <RowLane lane={AUDIT_LANE.origin} className={`truncate ${secondaryText}`}>{auditOriginLabels[operation.origin]}</RowLane>
          <TimeLane lane={AUDIT_LANE.time} iso={operation.startedAt} now={now} />
        </>}>
        {open ? <div className="space-y-3">
          <AuditTimeline scope={scope} operationId={operation.id} members={members} onAccessError={onAccessError} />
          <details className="group/audit-technical"><summary className={auditTechnicalSummaryClass}><AuditChevron technical />Operation data</summary>
            <dl className="grid gap-x-6 gap-y-2 break-all text-xs text-[var(--dls-text-secondary)] sm:grid-cols-2">
              <div><dt>Operation</dt><dd className="font-mono">{operation.id}</dd></div>
              <div><dt>Action</dt><dd className="font-mono">{operation.action}</dd></div>
              <div><dt>Actor</dt><dd className="font-mono">{operation.initiatingActor.id ?? "Unknown"}</dd></div>
              <div><dt>Scope</dt><dd className="font-mono">{operation.scope}</dd></div>
              <div><dt>Origin</dt><dd>{auditOriginLabels[operation.origin]}</dd></div>
              <div><dt>Origin trust</dt><dd>{operation.originTrust === "reported" ? "Reported origin" : "Authenticated"}</dd></div>
              <div><dt>Recorded events</dt><dd>{operation.eventCount.toLocaleString()}</dd></div>
              {operation.resources.map((resource) => <div key={`${resource.type}-${resource.id}-${resource.relationship}`}><dt>{auditLabel(resource.relationship)}</dt><dd>{auditResourceLabel(resource)}<span className="block font-mono">{resource.type}: {resource.id}</span></dd></div>)}
            </dl>
          </details>
        </div> : null}
      </ListRow>;
    })}
  </RowList>;
}

export function AuditLogsContent({ scope, members, captureIncluded }: {
  scope: AuditScope; members: readonly DenOrgMember[];
  /** `entitlements.auditLogs`: new activity is recorded. Only used for the feature intro. */
  captureIncluded: boolean;
}) {
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
  const applyFilters = useCallback((next: AuditFilters) => { setExpanded(null); setFilters(next); }, []);
  // With `featureIntros` on: full screen while nothing has been kept, banner when history
  // exists but the plan no longer records new activity.
  const intro = useFeatureIntro("audit-logs", auditLogsIntroFacts({ included: captureIncluded, filters, operations: query.data ? operations : undefined }));
  if (accessError) return <AuditPage><AuditLocked error={accessError}>
    <DenButton variant="secondary" disabled={refreshing} onClick={() => {
      setExpanded(null); setUsageOpen(false);
      void Promise.all([query.refetch(), eventTypes.refetch()]).then((results) => { if (results.every((result) => !result.error)) setDetailAccessError(null); });
    }}>Retry access check</DenButton>
  </AuditLocked></AuditPage>;
  if (intro.size === "fullscreen") return intro.element;
  return <AuditPage state={query.data ? auditStateLine(operations.length, Boolean(query.hasNextPage), Object.values(filters).some(Boolean)) : undefined} action={<RefreshButton refreshing={refreshing} onRefresh={() => void client.invalidateQueries({ queryKey: auditQueryKey(scope) })} />}>
    {intro.size === "banner" ? intro.element : null}
    <AuditToolbar filters={filters} members={members} operations={operations} eventTypes={eventTypes.data?.eventTypes ?? []} eventTypesPending={eventTypes.isPending} onApply={applyFilters} />
    {eventTypes.isError ? <div className="flex flex-wrap items-center gap-3">
      <DenNotice tone="error" message={eventTypes.data ? "Could not refresh event types. Showing the last verified catalog." : "Could not load event types. Try again."} />
      <DenButton variant="secondary" size="sm" disabled={eventTypes.isFetching} onClick={() => void eventTypes.refetch()}>Retry event types</DenButton>
    </div> : null}
    <div aria-busy={query.isFetching}>
      {query.isError ? <AuditReadFailure retained={Boolean(query.data)} verifiedAt={query.dataUpdatedAt} retry={() => { void (query.isFetchNextPageError ? query.fetchNextPage() : query.refetch()); }} busy={query.isFetching} /> : null}
      {query.isPending ? <RowListSkeleton rows={5} /> : operations.length ? <AuditCompactOperations operations={operations} scope={scope} members={members} expanded={expanded} onExpand={setExpanded} onAccessError={setDetailAccessError} /> : !query.isError ? <div role="status" className="flex flex-col items-start gap-3 py-8" data-testid="audit-empty">
        <p>{Object.values(filters).some(Boolean) ? "No operations match these filters." : "No retained audit operations yet. Review capture and storage for the current capture state."}</p>
        {Object.values(filters).some(Boolean) ? <DenButton variant="secondary" size="sm" onClick={() => applyFilters({})}>Show all operations</DenButton> : null}
      </div> : null}
    </div>
    {query.hasNextPage ? <div className="flex items-center justify-between gap-3"><span className="text-[var(--dls-text-secondary)]">{operations.length} operations loaded</span><DenButton variant="secondary" size="sm" disabled={query.isFetching} onClick={() => void query.fetchNextPage()}>Load more operations</DenButton></div> : null}
    <details className={`group border-y ${hairline}`} onToggle={(event) => { if (event.currentTarget.open) setUsageOpen(true); }}>
      <summary className={auditSummaryClass}><AuditChevron />Capture and storage</summary>
      {usageOpen ? <AuditUsage scope={scope} onAccessError={setDetailAccessError} /> : null}
    </details>
  </AuditPage>;
}
