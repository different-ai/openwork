"use client";

import { useEffect, type ReactNode } from "react";
import { ChevronRight, LockKeyhole } from "lucide-react";
import type { AuditActor, AuditEventEnvelope, AuditOperationSummary, AuditUsageResponse } from "@openwork/types/den/audit";
import { DenButton } from "../../_components/ui/button";
import { DenNotice } from "../../_components/ui/notice";
import { DenTable } from "../../_components/ui/table";
import { DenSwitch } from "../../_components/ui/switch";
import type { DenOrgMember } from "../../_lib/den-org";
import { auditCaptureLockReason, isAuditAccessError, useAuditCapture, useAuditEvents, type AuditReadError, type AuditScope } from "./audit-logs-data";

export const auditSummaryClass = "flex cursor-pointer list-none items-center gap-2 py-3 font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--dls-accent)] [&::-webkit-details-marker]:hidden";

export function AuditChevron() {
  return <ChevronRight aria-hidden="true" strokeWidth={1.5} className="size-4 shrink-0 transition-transform duration-150 motion-reduce:transition-none group-open:rotate-90" />;
}

const auditAcronyms: Record<string, string> = {
  api: "API", mcp: "MCP", sso: "SSO", scim: "SCIM", oauth: "OAuth", dpa: "DPA", oidc: "OIDC", saml: "SAML", url: "URL", id: "ID",
};

export function auditLabel(value: string): string {
  const words = value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[._\-/]+/g, " ").trim().split(/\s+/).filter(Boolean)
    .map((word) => auditAcronyms[word.toLowerCase()] ?? (/^[A-Z0-9]{2,}$/.test(word) ? word : word.toLowerCase()));
  if (!words.length) return "Not recorded";
  const [first, ...rest] = words;
  return [first[0].toUpperCase() + first.slice(1), ...rest].join(" ");
}

const auditCollectionPrefix = "collection:";

export function auditResourceLabel(resource: AuditOperationSummary["resources"][number]) {
  if (resource.label) return resource.label;
  if (resource.id.startsWith(auditCollectionPrefix)) return `${auditLabel(resource.type)} collection`;
  return `${auditLabel(resource.type)} (name unavailable)`;
}

export const auditOutcomeLabels: Record<AuditOperationSummary["outcome"] | AuditEventEnvelope["outcome"], string> = {
  running: "Running", succeeded: "Succeeded", failed: "Failed", partial: "Partially completed", denied: "Denied", unknown: "Unknown",
};

export const auditOriginLabels: Record<AuditOperationSummary["origin"], string> = {
  api: "API", cloud_ui: "Cloud UI", mcp: "Agent (MCP)", scheduler: "Scheduler", webhook: "Webhook", platform_admin: "Platform admin",
};

export function AuditOutcome({ outcome }: { outcome: AuditOperationSummary["outcome"] | AuditEventEnvelope["outcome"] }) {
  return <span className={outcome === "failed" ? "text-[var(--ow-danger)]" : outcome === "partial" ? "text-[var(--ow-warning)]" : "text-[var(--dls-text-secondary)]"}>
    {outcome === "denied" ? <LockKeyhole aria-hidden="true" strokeWidth={1.5} className="mr-1 inline size-4" /> : null}{auditOutcomeLabels[outcome]}
  </span>;
}

export function auditActorLabel(actor: AuditActor, members: readonly DenOrgMember[], origin?: AuditOperationSummary["origin"]): string {
  if (actor.type === "system") return "System";
  if (actor.type === "service") return actor.id ? `Service: ${auditLabel(actor.id.split(":")[0] ?? actor.id)}` : "Service account";
  if (actor.type === "unknown" || !actor.id) return "Unknown actor";
  const member = members.find((entry) => entry.userId === actor.id || (actor.memberId !== undefined && entry.id === actor.memberId));
  if (member?.user.name) return member.user.name;
  return !actor.memberId && origin === "platform_admin" ? "Platform administrator" : "Unavailable member";
}

export function AuditTime({ value }: { value: string | null }) {
  return value ? <time dateTime={value}>{new Date(value).toLocaleString()}</time> : <>Not recorded</>;
}

export function AuditSkeleton({ rows = 5 }: { rows?: number }) {
  return <div role="status" aria-label="Loading audit history" className="divide-y divide-[var(--dls-border)]" data-testid="audit-skeleton">
    {Array.from({ length: rows }, (_, index) => <div key={index} className="flex min-h-12 items-center gap-6 px-3 py-3" aria-hidden="true">
      <div className="h-4 flex-1 rounded bg-[var(--dls-hover)]" /><div className="h-4 w-24 rounded bg-[var(--dls-hover)]" /><div className="h-4 w-32 rounded bg-[var(--dls-hover)]" />
    </div>)}
  </div>;
}

export function AuditLocked({ error, unavailable = false, children }: { error?: AuditReadError; unavailable?: boolean; children?: ReactNode }) {
  const message = unavailable || error?.code === "audit_feature_disabled"
    ? "Audit logs are not enabled for this organization."
    : error?.code === "audit_visibility_disabled"
      ? "Audit visibility is disabled for this deployment. Ask an instance administrator to enable it."
      : error?.status === 401 ? "Your session could not be verified. Sign in again to view audit history."
        : "Audit history is restricted to organization admins, super-admins and owners. Ask an organization owner to review your access.";
  return <div className="flex flex-col gap-3 py-6" data-testid="audit-locked">
    <DenNotice tone="neutral" icon={LockKeyhole} message={message} />
    {children}
  </div>;
}

export function AuditReadFailure({ retained, verifiedAt, retry, busy }: { retained: boolean; verifiedAt: number; retry: () => void; busy: boolean }) {
  return <div className="flex flex-col items-start gap-2 py-3">
    <DenNotice tone="error" message={retained ? <>Could not refresh audit history. Showing the last verified results from <AuditTime value={verifiedAt ? new Date(verifiedAt).toISOString() : null} />.</> : "Could not load audit history. Try again."} />
    <DenButton variant="secondary" size="sm" disabled={busy} onClick={retry}>Retry</DenButton>
  </div>;
}

function readableValue(value: unknown, depth = 0): string {
  if (value === undefined) return "Not recorded";
  if (value === null) return "None";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (depth >= 3) return "Additional structured values";
  if (Array.isArray(value)) return value.length ? value.map((entry) => readableValue(entry, depth + 1)).join(", ") : "None";
  if (typeof value === "object") return Object.entries(value).map(([key, entry]) => `${auditLabel(key)}: ${safeChangeValue(key, entry, depth + 1)}`).join("; ") || "None";
  return "Not recorded";
}

function safeChangeValue(field: string, value: unknown, depth = 0): string {
  if (value !== null && value !== undefined && typeof value !== "boolean" && /(secret|password|token|api.?key|authorization|cookie|private.?key|credential.?material)/i.test(field)) return "Hidden";
  return readableValue(value, depth);
}

function changeField(values: Record<string, unknown> | null, field: string): unknown {
  if (values === null) return null;
  if (Object.hasOwn(values, field)) return values[field];
  let value: unknown = values;
  for (const part of field.split(".")) {
    if (!value || typeof value !== "object") return undefined;
    const entry = Object.entries(value).find(([key]) => key === part);
    if (!entry) return undefined;
    value = entry[1];
  }
  return value;
}

export function AuditChanges({ changes }: { changes: AuditEventEnvelope["changes"] }) {
  if (!changes || !changes.changedFields.length) return <p className="py-2 text-[var(--dls-text-secondary)]">No field changes recorded.</p>;
  function valueFor(field: string, side: "before" | "after") {
    if ((field === "credentialMaterial" || field === "configuration")
      && changeField(changes?.before ?? null, field) === undefined && changeField(changes?.after ?? null, field) === undefined) {
      return side === "before" ? "Not retained" : "Changed; values not retained";
    }
    return safeChangeValue(field, changeField(changes?.[side] ?? null, field));
  }
  return <DenTable density="compact" columns={[
    { key: "field", header: "Field", render: (field: string) => auditLabel(field) },
    { key: "before", header: "Before", render: (field: string) => <span className="whitespace-pre-wrap break-words">{valueFor(field, "before")}</span> },
    { key: "after", header: "After", render: (field: string) => <span className="whitespace-pre-wrap break-words">{valueFor(field, "after")}</span> },
  ]} rows={[...new Set(changes.changedFields)]} getRowKey={(field) => field} />;
}

type DetailProps = { scope: AuditScope; onAccessError: (error: AuditReadError) => void };

export function AuditTimeline({ scope, operationId, members, onAccessError }: DetailProps & { operationId: string; members: readonly DenOrgMember[] }) {
  const query = useAuditEvents(scope, operationId);
  const events = (query.data?.pages.flatMap((page) => page.events) ?? []).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const accessError = isAuditAccessError(query.error) ? query.error : null;
  useEffect(() => { if (accessError) onAccessError(accessError); }, [accessError, onAccessError]);
  if (accessError) return <AuditLocked error={accessError} />;
  return <div className="flex flex-col gap-3 py-3" aria-label="Operation timeline">
    {query.isError ? <AuditReadFailure retained={Boolean(query.data)} verifiedAt={query.dataUpdatedAt} retry={() => { void (query.isFetchNextPageError ? query.fetchNextPage() : query.refetch()); }} busy={query.isFetching} /> : null}
    {query.isPending ? <AuditSkeleton rows={2} /> : !events.length && !query.isError ? <p>No retained events for this operation.</p> : null}
    <ol className="flex flex-col gap-4">
      {events.map((event) => <li key={event.id} className="flex flex-col gap-2 border-l border-[var(--dls-border)] pl-4" data-testid="audit-event">
        <div className="flex flex-wrap items-center justify-between gap-3"><span className="font-medium">{auditLabel(event.action)}</span><AuditOutcome outcome={event.outcome} /></div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--dls-text-secondary)]"><span>{auditActorLabel(event.actor, members, event.operation.origin)}</span><AuditTime value={event.occurredAt} /></div>
        {event.resources.length ? <p>{event.resources.map(auditResourceLabel).join(", ")}</p> : null}
        {event.reasonCode ? <p>{auditLabel(event.reasonCode)}</p> : null}
        <AuditChanges changes={event.changes} />
        <details className="group"><summary className={auditSummaryClass}><AuditChevron />Technical details</summary>
          <dl className="flex flex-col gap-2 break-all text-xs text-[var(--dls-text-secondary)]">
            <div><dt>Event</dt><dd className="font-mono">{event.id}</dd></div>
            <div><dt>Action</dt><dd className="font-mono">{event.action}</dd></div>
            <div><dt>Actor</dt><dd className="font-mono">{event.actor.id ?? "Unknown"}</dd></div>
            <div><dt>Request</dt><dd className="font-mono">{event.requestId ?? "Not recorded"}</dd></div>
            {event.http ? <div><dt>HTTP request</dt><dd className="font-mono">{event.http.method} {event.http.route}</dd></div> : null}
            {event.http?.status !== undefined ? <div><dt>HTTP status</dt><dd className="font-mono">{event.http.status}</dd></div> : null}
            <div><dt>Recorded</dt><dd><AuditTime value={event.recordedAt} /></dd></div>
            {event.resources.map((resource) => <div key={`${resource.type}-${resource.id}-${resource.relationship}`}><dt>{auditLabel(resource.relationship)}</dt><dd className="font-mono">{resource.type}: {resource.id}</dd></div>)}
          </dl>
        </details>
      </li>)}
    </ol>
    {query.hasNextPage ? <DenButton variant="secondary" size="sm" disabled={query.isFetching} onClick={() => void query.fetchNextPage()}>Load more events</DenButton> : null}
  </div>;
}

export function AuditUsageFacts({ usage, captureControl }: { usage: AuditUsageResponse; captureControl?: ReactNode }) {
  const policy = usage.policy;
  const facts: { label: string; value: ReactNode }[] = [
    { label: "Available", value: usage.entitlement.enabled
      ? usage.entitlement.source === "enterprise_plan" ? "Included in Enterprise" : usage.entitlement.source === "self_hosted" ? "Enabled by instance operator" : "Entitlement source unavailable"
      : "Requires Enterprise" },
    { label: "Capture audit logs", value: captureControl ?? (usage.captureOn ? "On" : "Off") },
    { label: "Deployment capture", value: usage.captureAvailable ? "Available" : "Unavailable" },
    { label: "Effective recording", value: usage.captureEnabled ? "Recording" : "Not recording" },
    { label: "Retained operations", value: usage.retainedOperations.toLocaleString() },
    { label: "Recorded events", value: usage.eventCount.toLocaleString() },
    { label: "Oldest available history", value: <AuditTime value={usage.oldestAvailableAt} /> },
    { label: "Logical storage", value: `${usage.logicalBytes.toLocaleString()} bytes (not disk usage)` },
    // Retained operations, recorded events and logical storage are recomputed by a
    // daily refresh (den-audit-usage), not on every write.
    { label: "Totals last refreshed", value: usage.measuredAt ? <><AuditTime value={usage.measuredAt} />, refreshed daily</> : "Not yet, refreshed daily" },
    { label: "Policy source", value: policy ? policy.source === "operator" ? "Instance operator" : "Cloud" : "Not configured" },
    { label: "Categories", value: policy ? policy.categories.map(auditLabel).join(", ") || "None" : "Not configured" },
    { label: "Operation allowance", value: policy ? policy.allowance.toLocaleString() : "Not configured" },
    { label: "Configured excess policy", value: policy ? ({ delete_oldest: "Delete oldest", paid_overage: "Paid overage", keep_all: "Keep all" })[policy.excessMode] : "Not configured" },
    { label: "Capture started", value: <AuditTime value={policy?.captureStartedAt ?? null} /> },
    { label: "Policy effective", value: <AuditTime value={policy?.effectiveAt ?? null} /> },
    { label: "Policy revision", value: policy?.revision ?? "Not configured" },
    { label: "Related-request window", value: policy ? `${policy.attachmentWindowSeconds} seconds` : "Not configured" },
    { label: "Billing", value: "Disabled" },
    { label: "Cleanup", value: "Dry run only — no deletion" },
    { label: "External drains", value: "Not configured" },
  ];
  return <div className="flex flex-col gap-3">
    <p className="text-[var(--dls-text-secondary)]">One operation can include many requests and events. Available history reflects retained operations, not a guaranteed number of days.</p>
    <dl className="divide-y divide-[var(--dls-border)]">{facts.map(({ label, value }) => <div key={label} className="flex flex-wrap justify-between gap-3 py-3"><dt className="text-[var(--dls-text-secondary)]">{label}</dt><dd>{value}</dd></div>)}</dl>
    <p className="text-[var(--dls-text-secondary)]">Read-only capacity policy. {policy?.source === "operator" ? "An instance operator manages this configuration." : "Ask an instance administrator about policy configuration."} Billing is disabled and cleanup only previews deletions; the configured excess policy is not a purchase or deletion action.</p>
  </div>;
}

export function AuditUsage({ scope, onAccessError }: DetailProps) {
  const capture = useAuditCapture(scope, onAccessError);
  const { query } = capture;
  const accessError = isAuditAccessError(query.error) ? query.error : null;
  const reason = query.data ? auditCaptureLockReason(query.data) : null;
  useEffect(() => { if (accessError) onAccessError(accessError); }, [accessError, onAccessError]);
  if (accessError) return <AuditLocked error={accessError} />;
  const control = <div className="flex items-center gap-3" aria-busy={capture.busy}>
    <span>{query.data ? query.data.captureOn ? "On" : "Off" : "Not verified"}</span>
    <DenSwitch aria-label="Capture audit logs" aria-describedby="audit-capture-status" checked={query.data?.captureOn ?? false} disabled={capture.disabled} onChange={capture.change} />
  </div>;
  return <div className="flex flex-col gap-3 py-3">
    <div id="audit-capture-status" className="flex flex-col gap-3">
      {query.isError ? <DenNotice tone="error" message={query.data
        ? <>Could not refresh capture status. Showing the last verified state from <AuditTime value={new Date(query.dataUpdatedAt).toISOString()} />.</>
        : "Could not load capture status. Refresh status before changing capture."} /> : null}
      {capture.feedback ? <DenNotice tone={capture.feedback.tone} message={<>{capture.feedback.message}{capture.needsRefresh && query.data && !query.isError
        ? <> Showing the last verified state from <AuditTime value={new Date(query.dataUpdatedAt).toISOString()} />.</> : null}</>} /> : null}
      {reason ? <DenNotice tone="neutral" icon={LockKeyhole} message={reason} /> : null}
      {query.data && !query.data.captureEnabled && !capture.needsRefresh && !query.isError ? <p className="text-[var(--dls-text-secondary)]">New activity is not recorded. Retained history remains available.</p> : null}
    </div>
    {capture.needsRefresh || query.isError ? <div><DenButton variant="secondary" size="sm" disabled={capture.busy} onClick={capture.refresh}>Refresh status</DenButton></div> : null}
    {query.data ? <AuditUsageFacts usage={query.data} captureControl={control} /> : <>
      <div className="flex items-center justify-between gap-3 py-3"><span>Capture audit logs</span>{control}</div>
      {query.isPending ? <AuditSkeleton rows={4} /> : null}
    </>}
  </div>;
}
