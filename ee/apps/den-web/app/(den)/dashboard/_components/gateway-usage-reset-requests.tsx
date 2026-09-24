"use client";

import { useState } from "react";
import type { GatewayUsageResetPage, GatewayUsageResetRequest } from "@openwork/types/den/gateway-usage-limits";
import { DenBadge } from "../../_components/ui/badge";
import { DenButton } from "../../_components/ui/button";
import { DenCard } from "../../_components/ui/card";
import { DenNotice } from "../../_components/ui/notice";
import { DenTable, type DenTableColumn } from "../../_components/ui/table";
import type { DenOrgMember } from "../../_lib/den-org";
import { formatLimitMoney, useGatewayLimitsMutation, useGatewayPolicies, useGatewayResetHistoryAvailable, useGatewayResetRequests } from "./gateway-usage-limits-data";
import { GatewayLimitsQueryFeedback, GatewayLimitTimestamp } from "./gateway-usage-limits-section";
import { timeframeLabels } from "./gateway-usage-limits-data";

function extensionPreview(request: GatewayUsageResetRequest) {
  const extension = Number((BigInt(request.baseAllowanceMicroUsd) + 3n) / 4n);
  return { extension, total: request.baseAllowanceMicroUsd + extension };
}

function RequestTimestamp({ value }: { value: string }) {
  const date = new Date(value);
  return <time dateTime={value} title={date.toLocaleString()} className="whitespace-nowrap text-xs text-[var(--ow-muted)]">{date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time>;
}

function RequestBucketContext({ request }: { request: GatewayUsageResetRequest }) {
  const preview = extensionPreview(request);
  return <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs text-[var(--ow-muted)]">
    <span>{request.policyName} - {timeframeLabels[request.timeframe]}</span>
    <span>{formatLimitMoney(request.usedMicroUsd)} used / {formatLimitMoney(request.allowanceMicroUsd)} allowance</span>
    <span>Base: {formatLimitMoney(request.baseAllowanceMicroUsd)}</span>
    <span>Reset: <GatewayLimitTimestamp value={request.resetAt} /></span>
    {request.status === "expired" ? <span>Expired / ineligible</span> : null}
    {request.status === "pending" ? <span id={`gateway-reset-impact-${request.id}`}>+{formatLimitMoney(preview.extension)} allowance ({formatLimitMoney(preview.total)} total); may increase provider charges; no undo.</span> : null}
    {request.status === "pending" && Date.parse(request.resetAt) <= Date.now() ? <span className="text-[var(--ow-warning)]">This period ended. Refresh requests to check its current status.</span> : null}
    {request.status === "pending" && request.baseAllowanceMicroUsd === 0 ? <span className="text-[var(--ow-warning)]">A zero base allowance cannot receive a useful percentage extension.</span> : null}
    {request.status === "pending" && request.usedMicroUsd >= preview.total ? <span className="text-[var(--ow-warning)]">Approval will still leave this bucket exhausted.</span> : null}
  </div>;
}

function ResetRequestPages({ query, view, columns, onRefresh = query.restart, refreshing = query.isFetching }: {
  query: ReturnType<typeof useGatewayResetRequests>;
  view: GatewayUsageResetPage["view"];
  columns: DenTableColumn<GatewayUsageResetRequest>[];
  onRefresh?: () => Promise<unknown>;
  refreshing?: boolean;
}) {
  const label = view === "pending" ? "increase requests" : "request history";
  const rows = [...new Map(query.data?.pages.flatMap((page) => page.requests.map((request) => [request.id, request] satisfies [string, GatewayUsageResetRequest]))).values()];
  if (!query.data || (query.isError && !query.isFetchNextPageError)) {
    return <GatewayLimitsQueryFeedback query={{ ...query, refetch: onRefresh }} label={label} />;
  }
  return <div className="flex flex-col gap-3" aria-label={view === "pending" ? "Pending increase request pages" : "Increase request history pages"}>
    {rows.length ? <DenCard className="overflow-hidden p-0"><DenTable rows={rows} getRowKey={(row) => row.id} columns={columns} headerTone="plain" rowClassName="align-top" renderRowDetail={(request) => <RequestBucketContext request={request} />} /></DenCard> : <p role="status" className="text-sm text-[var(--ow-muted)]">{view === "pending" ? "No pending requests" : "No previous requests"}</p>}
    {query.isFetchNextPageError ? <DenNotice tone="error" message={`${query.error?.message ?? "Could not load the next page."} Only previously loaded entries are shown.`} /> : null}
    {query.hasNextPage ? <DenButton variant="secondary" disabled={query.isFetching} loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{query.isFetchNextPageError ? "Retry more" : "Load more"} {view === "pending" ? "pending requests" : "history"}</DenButton> : null}
    <div className="flex flex-wrap items-center gap-1 text-xs text-[var(--ow-muted)]">
      <span>Last checked: <time dateTime={new Date(query.dataUpdatedAt).toISOString()}>{new Date(query.dataUpdatedAt).toLocaleString()}</time> -</span>
      <DenButton variant="ghost" size="sm" className="h-auto px-0 py-0 text-xs underline-offset-4 hover:underline" disabled={refreshing} onClick={() => void onRefresh()}>Refresh</DenButton>
    </div>
  </div>;
}

function ResetRequestHistory({ orgId, columns, members }: { orgId: string; columns: DenTableColumn<GatewayUsageResetRequest>[]; members: DenOrgMember[] }) {
  const history = useGatewayResetRequests(orgId, "history");
  return <section id="gateway-reset-history" className="flex flex-col gap-3" aria-label="Request history">
    <ResetRequestPages query={history} view="history" columns={[...columns,
      { key: "status", header: "Decision", render: (request) => <div className="flex flex-col gap-2"><DenBadge tone={request.status === "approved" ? "success" : "neutral"}>{request.status}</DenBadge><span className="text-xs">{request.reviewedBy ? `Reviewer: ${members.find((member) => member.id === request.reviewedBy)?.user.name ?? request.reviewedBy}` : "No reviewer"}</span>{request.reviewedAt ? <GatewayLimitTimestamp value={request.reviewedAt} /> : null}</div> },
    ]} />
  </section>;
}

export function GatewayUsageResetRequests({ orgId, members }: { orgId: string; members: DenOrgMember[] }) {
  const policies = useGatewayPolicies(orgId);
  if (!policies.data?.policies.some((policy) => !policy.archivedAt)) return null;
  return <GatewayResetQueue key={orgId} orgId={orgId} members={members} />;
}

function GatewayResetQueue({ orgId, members }: { orgId: string; members: DenOrgMember[] }) {
  const requests = useGatewayResetRequests(orgId, "pending");
  const previousRequests = useGatewayResetHistoryAvailable(orgId);
  const mutation = useGatewayLimitsMutation(orgId);
  const [history, setHistory] = useState(false);
  const refreshing = requests.isFetching || previousRequests.isFetching;
  const refreshRequests = () => Promise.all([requests.restart(), previousRequests.refetch()]);
  const requestColumns: DenTableColumn<GatewayUsageResetRequest>[] = [
    { key: "user", header: "User", render: (request) => <div className="flex flex-col gap-1"><span className="font-medium">{request.memberName}</span><span className="break-words text-xs text-[var(--ow-muted)]">{request.memberEmail}</span></div> },
    { key: "reason", header: "Reason", render: (request) => <p className="min-w-32 max-w-sm whitespace-pre-wrap break-words">{request.reason}</p> },
    { key: "requested", header: "Requested", render: (request) => <RequestTimestamp value={request.createdAt} /> },
  ];
  const disabled = mutation.isPending || requests.isFetching || requests.isError;
  return <section aria-labelledby="gateway-reset-requests-heading" className="mb-10 flex flex-col gap-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="gateway-reset-requests-heading" className="text-lg font-semibold">Limit increase requests</h2><DenButton variant="secondary" disabled={refreshing} onClick={() => void refreshRequests()}>Refresh requests</DenButton></div>
    {mutation.error ? <DenNotice tone="error" message={mutation.error.message} /> : null}
    {mutation.isSuccess && mutation.data && "status" in mutation.data ? <DenNotice tone={mutation.data.status === "expired" ? "warning" : "info"} message={mutation.data.status === "expired" ? "This request expired or its policy changed. No extension was granted by this decision; review the current bucket." : `Request ${mutation.data.status}. Check the queue and history for the latest state.`} /> : null}
    <ResetRequestPages query={requests} view="pending" onRefresh={refreshRequests} refreshing={refreshing} columns={[...requestColumns,
      { key: "actions", header: "Actions", align: "right", render: (request) => <div className="flex flex-wrap justify-end gap-2">
        <DenButton size="sm" disabled={disabled || request.status !== "pending" || request.baseAllowanceMicroUsd === 0 || Date.parse(request.resetAt) <= Date.now()} aria-label={`Approve 25% for ${request.memberName}, ${timeframeLabels[request.timeframe]}`} aria-describedby={request.status === "pending" ? `gateway-reset-impact-${request.id}` : undefined} onClick={() => mutation.mutate({ type: "approve", requestId: request.id })}>Approve 25%</DenButton>
        <DenButton size="sm" variant="secondary" disabled={disabled || request.status !== "pending"} aria-label={`Deny request for ${request.memberName}, ${timeframeLabels[request.timeframe]}`} onClick={() => mutation.mutate({ type: "deny", requestId: request.id })}>Deny</DenButton>
      </div> },
    ]} />
    {previousRequests.isError ? <DenNotice tone="error" message="Could not check previous requests. Refresh to try again." /> : null}
    {previousRequests.data || history ? <details className="text-sm" open={history} onToggle={(event) => setHistory(event.currentTarget.open)}>
      <summary className="cursor-pointer text-[var(--ow-muted)]">Previous requests</summary>
      {history ? <div className="pt-3"><ResetRequestHistory orgId={orgId} columns={requestColumns} members={members} /></div> : null}
    </details> : null}
  </section>;
}
