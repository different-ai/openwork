"use client";

import { useState, type ReactNode } from "react";
import type { GatewayUsageResetPage, GatewayUsageResetRequest } from "@openwork/types/den/gateway-usage-limits";
import { DenBadge } from "../../_components/ui/badge";
import { DenButton } from "../../_components/ui/button";
import { SECTION_TITLE_CLASS } from "../../_components/ui/dashboard-styles";
import { DenNotice } from "../../_components/ui/notice";
import type { DenOrgMember } from "../../_lib/den-org";
import { formatLimitMoney, useGatewayLimitsMutation, useGatewayPolicies, useGatewayResetHistoryAvailable, useGatewayResetRequests } from "./gateway-usage-limits-data";
import { GatewayLimitsQueryFeedback, GatewayLimitTimestamp } from "./gateway-usage-limits-section";
import { timeframeLabels } from "./gateway-usage-limits-data";
import { RowLane, RowLaneLabel, RowList, RowListHeader } from "../_features/computers/computer-rows";
import { GATEWAY_LANE, GatewayRow, InitialsTile } from "./gateway-rows";
import { initials } from "./gateway-spend-breakdown";

function extensionPreview(request: GatewayUsageResetRequest) {
  const extension = Number((BigInt(request.baseAllowanceMicroUsd) + 3n) / 4n);
  return { extension, total: request.allowanceMicroUsd + extension };
}

function RequestTimestamp({ value }: { value: string }) {
  const date = new Date(value);
  return <time dateTime={value} title={date.toLocaleString()} className="whitespace-nowrap text-[color:var(--dls-text-secondary)]">{date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time>;
}

function RequestBucketContext({ request }: { request: GatewayUsageResetRequest }) {
  const preview = extensionPreview(request);
  return <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[12px] leading-4 text-[color:var(--dls-text-secondary)]">
    <span>{request.policyName} - {timeframeLabels[request.timeframe]}</span>
    {request.providerId ? <span data-testid="gateway-reset-provider">Only {request.providerName ?? "a removed provider"}</span> : null}
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

/** The lanes a request list adds after the person: a column label and each row's cell. */
type RequestLane = { key: string; label: string; lane: string; render: (request: GatewayUsageResetRequest) => ReactNode };

const MUTED = "text-[color:var(--dls-text-secondary)]";

const BASE_LANES: RequestLane[] = [
  { key: "reason", label: "Reason", lane: GATEWAY_LANE.reason, render: (request) => <p className="whitespace-pre-wrap break-words">{request.reason}</p> },
  { key: "requested", label: "Requested", lane: GATEWAY_LANE.requested, render: (request) => <RequestTimestamp value={request.createdAt} /> },
];

function ResetRequestPages({ query, view, lanes, onRefresh = query.restart, refreshing = query.isFetching }: {
  query: ReturnType<typeof useGatewayResetRequests>;
  view: GatewayUsageResetPage["view"];
  lanes: RequestLane[];
  onRefresh?: () => Promise<unknown>;
  refreshing?: boolean;
}) {
  const label = view === "pending" ? "increase requests" : "request history";
  const rows = [...new Map(query.data?.pages.flatMap((page) => page.requests.map((request) => [request.id, request] satisfies [string, GatewayUsageResetRequest]))).values()];
  if (!query.data || (query.isError && !query.isFetchNextPageError)) {
    return <GatewayLimitsQueryFeedback query={{ ...query, refetch: onRefresh }} label={label} />;
  }
  return <div className="flex flex-col gap-3" aria-label={view === "pending" ? "Pending increase request pages" : "Increase request history pages"}>
    {rows.length ? <RowList label={view === "pending" ? "Pending increase requests" : "Increase request history"} header={<RowListHeader lead="User">
      {lanes.map((lane) => <RowLaneLabel key={lane.key} lane={lane.lane}>{lane.label}</RowLaneLabel>)}
    </RowListHeader>}>
      {rows.map((request) => <GatewayRow
        key={request.id}
        lead={<InitialsTile>{initials(request.memberName || request.memberEmail)}</InitialsTile>}
        name={request.memberName}
        secondLine={request.memberEmail}
        lanes={lanes.map((lane) => <RowLane key={lane.key} lane={lane.lane}>{lane.render(request)}</RowLane>)}
        below={<div role="cell" className="basis-full pb-1 pl-11"><RequestBucketContext request={request} /></div>}
      />)}
    </RowList> : <p role="status" className={`text-[13px] ${MUTED}`}>{view === "pending" ? "No pending requests" : "No previous requests"}</p>}
    {query.isFetchNextPageError ? <DenNotice tone="error" message={`${query.error?.message ?? "Could not load the next page."} Only previously loaded entries are shown.`} /> : null}
    {query.hasNextPage ? <DenButton variant="secondary" size="sm" className="self-start" disabled={query.isFetching} loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{query.isFetchNextPageError ? "Retry more" : "Load more"} {view === "pending" ? "pending requests" : "history"}</DenButton> : null}
    <div className={`flex flex-wrap items-center gap-1 text-[12px] ${MUTED}`}>
      <span>Last checked: <time dateTime={new Date(query.dataUpdatedAt).toISOString()}>{new Date(query.dataUpdatedAt).toLocaleString()}</time> -</span>
      <DenButton variant="ghost" size="sm" className="h-auto px-0 py-0 text-[12px] underline-offset-4 hover:underline" disabled={refreshing} onClick={() => void onRefresh()}>Refresh</DenButton>
    </div>
  </div>;
}

function ResetRequestHistory({ orgId, members }: { orgId: string; members: DenOrgMember[] }) {
  const history = useGatewayResetRequests(orgId, "history");
  return <section id="gateway-reset-history" className="flex flex-col gap-3" aria-label="Request history">
    <ResetRequestPages query={history} view="history" lanes={[...BASE_LANES,
      { key: "status", label: "Decision", lane: GATEWAY_LANE.decision, render: (request) => <div className="flex flex-col items-start gap-1"><DenBadge tone={request.status === "approved" ? "success" : "neutral"}>{request.status}</DenBadge><span className={`text-[12px] ${MUTED}`}>{request.reviewedBy ? `Reviewer: ${members.find((member) => member.id === request.reviewedBy)?.user.name ?? request.reviewedBy}` : "No reviewer"}</span>{request.reviewedAt ? <span className={`text-[12px] ${MUTED}`}><GatewayLimitTimestamp value={request.reviewedAt} /></span> : null}</div> },
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
  const disabled = mutation.isPending || requests.isFetching || requests.isError;
  return <section aria-labelledby="gateway-reset-requests-heading" className="mb-10 flex flex-col gap-3">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="gateway-reset-requests-heading" className={SECTION_TITLE_CLASS}>Limit increase requests</h2><DenButton variant="secondary" size="sm" disabled={refreshing} onClick={() => void refreshRequests()}>Refresh requests</DenButton></div>
    {mutation.error ? <DenNotice tone="error" message={mutation.error.message} /> : null}
    {mutation.isSuccess && mutation.data && "status" in mutation.data ? <DenNotice tone={mutation.data.status === "expired" ? "warning" : "info"} message={mutation.data.status === "expired" ? "This request expired or its policy changed. No extension was granted by this decision; review the current bucket." : `Request ${mutation.data.status}. Check the queue and history for the latest state.`} /> : null}
    <ResetRequestPages query={requests} view="pending" onRefresh={refreshRequests} refreshing={refreshing} lanes={[...BASE_LANES,
      { key: "actions", label: "Actions", lane: GATEWAY_LANE.requestActions, render: (request) => <div className="flex flex-wrap justify-end gap-2">
        <DenButton size="sm" disabled={disabled || request.status !== "pending" || request.baseAllowanceMicroUsd === 0 || Date.parse(request.resetAt) <= Date.now()} aria-label={`Approve 25% for ${request.memberName}, ${timeframeLabels[request.timeframe]}`} aria-describedby={request.status === "pending" ? `gateway-reset-impact-${request.id}` : undefined} onClick={() => mutation.mutate({ type: "approve", requestId: request.id })}>Approve 25%</DenButton>
        <DenButton size="sm" variant="secondary" disabled={disabled || request.status !== "pending"} aria-label={`Deny request for ${request.memberName}, ${timeframeLabels[request.timeframe]}`} onClick={() => mutation.mutate({ type: "deny", requestId: request.id })}>Deny</DenButton>
      </div> },
    ]} />
    {previousRequests.isError ? <DenNotice tone="error" message="Could not check previous requests. Refresh to try again." /> : null}
    {previousRequests.data || history ? <details className="text-[13px]" open={history} onToggle={(event) => setHistory(event.currentTarget.open)}>
      <summary className={`cursor-pointer ${MUTED}`}>Previous requests</summary>
      {history ? <div className="pt-3"><ResetRequestHistory orgId={orgId} members={members} /></div> : null}
    </details> : null}
  </section>;
}
