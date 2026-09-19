import { useId, useState } from "react";
import { CheckCircle2, Gauge, LockKeyhole, X } from "lucide-react";
import type { GatewayUsageBucket, GatewayUsageStatus } from "@openwork/types/den/gateway-usage-limits";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Popover, PopoverContent, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { formatGatewayMoney, gatewayTimeframeLabels } from "./gateway-usage-state";
import { useGatewayUsage } from "./use-gateway-usage";
import { gatewayApprovalKey, useGatewayApprovalDismissals } from "./gateway-usage-approval-store";

export function GatewayResetTime({ value, localOnly = false }: { value: string; localOnly?: boolean }) {
  return <time dateTime={value} title={localOnly ? undefined : new Date(value).toUTCString()}>{new Date(value).toLocaleString()}{localOnly ? null : ` (${new Date(value).toUTCString()})`}</time>;
}

function GatewayUsageCoverage({ coverage }: { coverage: GatewayUsageStatus["coverage"] }) {
  const historicalUnknown = coverage.historicalCoverage === "unknown" || coverage.historicalUnknownReason != null;
  const incomplete = !coverage.complete || historicalUnknown || coverage.unpricedRequests > 0
    || (coverage.incompleteRequests ?? 0) > 0 || (coverage.quarantinedRequests ?? 0) > 0;
  return <>
    {incomplete ? <Alert><AlertTitle>Incomplete accounting</AlertTitle><AlertDescription>
      {historicalUnknown ? <p>{coverage.historicalUnknownReason === "tracking_not_started"
        ? "Usage tracking has not started. Earlier usage is unknown."
        : coverage.historicalUnknownReason === "period_predates_tracking"
          ? "This period includes time before usage tracking started. Earlier usage is unknown."
          : coverage.historicalUnknownReason === "legacy_counter"
            ? "Usage history includes older counters with unknown coverage."
            : "Historical usage coverage is unknown."}</p> : null}
      {coverage.trackingStartedAt ? <p>Usage tracking started: <GatewayResetTime value={coverage.trackingStartedAt} /></p> : null}
      {coverage.unpricedRequests > 0 ? <p>{coverage.unpricedRequests} recorded requests have unresolved cost. Unknown cost is not zero.</p> : null}
      {(coverage.incompleteRequests ?? 0) > 0 ? <p>{coverage.incompleteRequests} recorded requests have incomplete accounting.</p> : null}
      {(coverage.quarantinedRequests ?? 0) > 0 ? <p>{coverage.quarantinedRequests} unresolved historical requests are quarantined and have not been charged again.</p> : null}
      <p>Known costs are a subtotal, not complete spend.</p>
    </AlertDescription></Alert> : null}
    {coverage.settlementReady === true ? <p className="text-xs text-muted-foreground">No tracked requests are awaiting settlement.</p>
      : typeof coverage.pendingRequests === "number" && coverage.pendingRequests > 0 ? <p role="status" className="text-xs text-muted-foreground">{coverage.pendingRequests} tracked requests are awaiting settlement.</p>
        : coverage.pendingRequests === null ? <p className="text-xs text-muted-foreground">Pending settlement count is unavailable.</p>
          : coverage.settlementReady === false ? <p role="status" className="text-xs text-muted-foreground">Settlement is not yet confirmed.</p> : null}
    {coverage.lastSettlementAt ? <p className="text-xs text-muted-foreground">Last settlement: <GatewayResetTime value={coverage.lastSettlementAt} /></p> : null}
  </>;
}

export function GatewayUsageSummary({ status, onRequest, requestsDisabled = false }: {
  status: GatewayUsageStatus;
  onRequest: (bucket: GatewayUsageBucket) => void;
  requestsDisabled?: boolean;
}) {
  return <div className="flex flex-col gap-3">
    {status.state === "unlimited" ? <div><p className="font-medium">Unlimited</p><p className="text-muted-foreground">No usage limit policy assigned. Provider and service limits still apply.</p></div> : null}
    <GatewayUsageCoverage coverage={status.coverage} />
    {status.buckets.map((bucket) => <section key={bucket.id} aria-label={`${gatewayTimeframeLabels[bucket.timeframe]} usage`} className="flex flex-col gap-2 rounded-xl border p-3">
      <div className="flex items-center justify-between gap-2"><h3 className="font-medium">{gatewayTimeframeLabels[bucket.timeframe]}</h3><Badge variant="outline">{bucket.hardLimit ? "Hard limit" : "Soft limit"}</Badge></div>
      <p>{formatGatewayMoney(bucket.usedMicroUsd)} used / {formatGatewayMoney(bucket.allowanceMicroUsd)} total</p>
      <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <div className="flex gap-1"><dt>Base</dt><dd>{formatGatewayMoney(bucket.baseAllowanceMicroUsd)}</dd></div>
        <div className="flex gap-1"><dt>Extension</dt><dd>{formatGatewayMoney(bucket.extensionMicroUsd)}</dd></div>
      </dl>
      {bucket.usedMicroUsd >= bucket.allowanceMicroUsd ? <dl className="flex flex-wrap gap-x-4 gap-y-1">
        <div className="flex gap-1"><dt>Status</dt><dd>{bucket.hardLimit ? "Exhausted" : "Over allowance"}</dd></div>
        <div className="flex gap-1"><dt>Over allowance</dt><dd>{formatGatewayMoney(Math.max(0, bucket.usedMicroUsd - bucket.allowanceMicroUsd))}</dd></div>
      </dl> : null}
      <p className="text-xs text-muted-foreground">Next reset: <GatewayResetTime value={bucket.resetAt} /></p>
      {bucket.resetRequestStatus === "pending" ? <Badge role="status" variant="outline" className="border-amber-a6 bg-amber-3 text-amber-11">Increase request pending</Badge> : bucket.resetRequestStatus ? <p className="text-xs">Increase request: {bucket.resetRequestStatus}</p> : null}
      {bucket.canRequestReset && bucket.resetRequestStatus !== "pending" ? <Button size="sm" variant="outline" disabled={requestsDisabled} onClick={() => onRequest(bucket)}>Request Increase — {gatewayTimeframeLabels[bucket.timeframe]}</Button> : null}
    </section>)}
    <p className="text-xs text-muted-foreground">Running sessions not reflected in usage above</p>
  </div>;
}

export function GatewayResetForm({ bucket, pending, error, onSubmit, submitLabel = "Request Increase" }: {
  bucket: GatewayUsageBucket; pending: boolean; error: boolean;
  onSubmit: (reason: string) => void;
  submitLabel?: string;
}) {
  const [reason, setReason] = useState("");
  const id = useId();
  return <form className="flex flex-col gap-4" onSubmit={(event) => {
    event.preventDefault();
    if (!pending && reason.trim() && reason.trim().length <= 2000) onSubmit(reason.trim());
  }}>
    <p>{gatewayTimeframeLabels[bucket.timeframe]}: {formatGatewayMoney(bucket.usedMicroUsd)} used / {formatGatewayMoney(bucket.allowanceMicroUsd)} total. Each approval adds 25% of the base allowance; usage and reset time are unchanged.</p>
    <FieldGroup><Field><FieldLabel htmlFor={id}>Reason (required)</FieldLabel><Textarea id={id} required maxLength={2000} value={reason} onChange={(event) => setReason(event.target.value)} disabled={pending} /></Field></FieldGroup>
    {error ? <p role="alert">The request could not be confirmed. Check the refreshed usage status before trying again.</p> : null}
    <Button type="submit" disabled={pending || !reason.trim() || reason.trim().length > 2000}>{pending ? "Submitting…" : submitLabel}</Button>
  </form>;
}

function GatewayUsagePanelBody() {
  const usage = useGatewayUsage(true, true);
  const [selectedBucketId, setSelectedBucketId] = useState<string | null>(null);
  const bucket = usage.data?.buckets.find((item) => item.id === selectedBucketId && item.canRequestReset && item.resetRequestStatus !== "pending");
  return <>
    {!usage.authorized ? <p role="status">Sign in and select an organization to view usage limits.</p> : <>
      {usage.query.isPending ? <div role="status" aria-label="Loading usage limits"><Skeleton className="h-20 w-full" /><span>Loading usage limits…</span></div> : null}
      {usage.query.isError ? <Alert variant="destructive"><AlertTitle>Usage unavailable</AlertTitle><AlertDescription>{usage.data ? "Showing the last known estimate. Increase eligibility may have changed." : "Could not load usage. This does not mean unlimited access."}</AlertDescription></Alert> : null}
      {usage.data ? <GatewayUsageSummary status={usage.data} requestsDisabled={usage.query.isError || usage.reset.isPending} onRequest={(item) => { usage.reset.reset(); setSelectedBucketId(item.id); }} /> : null}
      <Button size="sm" variant="outline" disabled={usage.query.isFetching} onClick={() => { void usage.query.refetch(); }}>{usage.query.isFetching ? "Refreshing…" : "Refresh usage"}</Button>
    </>}
    <Dialog open={Boolean(bucket)} onOpenChange={(open) => { if (!open) setSelectedBucketId(null); }}>
      <DialogContent aria-describedby={undefined}><DialogHeader><DialogTitle>Request Increase</DialogTitle></DialogHeader>
        {bucket ? <GatewayResetForm key={`${usage.scopeKey}:${bucket.id}`} bucket={bucket} pending={usage.reset.isPending} error={usage.reset.isError} onSubmit={(reason) => usage.reset.mutate({ bucketId: bucket.id, reason }, { onSuccess: () => setSelectedBucketId(null) })} /> : null}
      </DialogContent>
    </Dialog>
  </>;
}

function approvedUsageIncreases(status?: GatewayUsageStatus) {
  return status?.buckets.filter((bucket) => bucket.resetRequestStatus === "approved"
    && bucket.extensionMicroUsd > 0 && Date.parse(bucket.resetAt) > Date.now()) ?? [];
}

export function GatewayUsageTrigger({ compact = true }: { compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const usage = useGatewayUsage(true);
  const hasApprovedIncrease = !usage.query.isError && approvedUsageIncreases(usage.data).length > 0;
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger render={<Button variant="ghost" size={compact ? "icon-sm" : "sm"} aria-label={compact ? "Usage limits" : "View Usage Limits"} title={hasApprovedIncrease ? "Usage increase approved" : compact ? "Usage limits" : "View Usage Limits"}><Gauge aria-hidden="true" className={hasApprovedIncrease ? "size-4 text-green-11" : "size-4"} />{compact ? null : "View Usage Limits"}</Button>} />
    <PopoverContent side="top" align="end" aria-describedby={undefined} className="max-h-[min(75vh,640px)] w-96 max-w-[calc(100vw-2rem)] overflow-y-auto">
      <PopoverHeader><PopoverTitle>Usage limits</PopoverTitle></PopoverHeader>
      {open ? <GatewayUsagePanelBody /> : null}
    </PopoverContent>
  </Popover>;
}

export function GatewayUsageApprovalNotice() {
  const usage = useGatewayUsage(true);
  const dismissedKeys = useGatewayApprovalDismissals((state) => state.dismissedKeys);
  const dismiss = useGatewayApprovalDismissals((state) => state.dismiss);
  const scopeKey = usage.approvalScopeKey;
  const approved = scopeKey ? approvedUsageIncreases(usage.data).filter((bucket) =>
    !dismissedKeys.includes(gatewayApprovalKey(scopeKey, bucket))) : [];
  if (!usage.active || usage.query.isError || !scopeKey || !approved.length) return null;
  const onDismiss = () => dismiss(approved.map((bucket) => gatewayApprovalKey(scopeKey, bucket)));

  return <Alert role="status" className="mx-auto mb-2 max-w-3xl border-green-a6 bg-green-3 text-green-11" data-testid="gateway-usage-approved-notice">
    <CheckCircle2 aria-hidden="true" className="size-4" />
    <AlertTitle>Usage increase approved</AlertTitle>
    <AlertDescription className="text-green-11">
      <p>Your request for a usage increase has been approved.</p>
      {approved.map((bucket) => <p key={bucket.id}>{bucket.policyName} - {gatewayTimeframeLabels[bucket.timeframe]}: +{formatGatewayMoney(bucket.extensionMicroUsd)} ({formatGatewayMoney(bucket.allowanceMicroUsd)} total)</p>)}
      {usage.data?.state === "blocked" ? <p>One or more usage limits are still exhausted.</p> : null}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <GatewayUsageTrigger compact={false} />
        <Button type="button" size="sm" variant="ghost" className="ms-auto" onClick={onDismiss}>Dismiss</Button>
      </div>
    </AlertDescription>
    <AlertAction>
      <Button type="button" size="icon-sm" variant="ghost" aria-label="Dismiss usage increase approval" onClick={onDismiss}><X aria-hidden="true" /></Button>
    </AlertAction>
  </Alert>;
}

function GatewayIncreaseDialogBody({ bucketIds, onClose }: { bucketIds: string[]; onClose: () => void }) {
  const usage = useGatewayUsage(true, true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const eligible = usage.data?.buckets.filter((bucket) => bucketIds.includes(bucket.id)
    && bucket.allowRequestReset && bucket.canRequestReset && bucket.resetRequestStatus !== "pending"
    && bucket.usedMicroUsd >= bucket.allowanceMicroUsd) ?? [];
  const selected = eligible.find((bucket) => bucket.id === selectedId) ?? (eligible.length === 1 ? eligible[0] : undefined);

  if (!usage.authorized) return <p role="status">Sign in to request a usage increase.</p>;
  if (usage.query.isPending) return <div role="status"><Skeleton className="h-20 w-full" /><span>Checking usage limits…</span></div>;
  if (usage.query.isError) return <div className="flex flex-col gap-3"><p role="alert">Could not check whether an increase is available.</p><Button variant="outline" disabled={usage.query.isFetching} onClick={() => void usage.query.refetch()}>Refresh usage</Button></div>;
  if (!eligible.length) return <p role="status">No consumed limits are currently eligible for an increase. View Usage Limits to check pending requests and current allowances.</p>;

  return <div className="flex flex-col gap-4">
    {eligible.length > 1 ? <FieldGroup><Field><FieldLabel>Select a consumed limit</FieldLabel><div className="flex flex-col gap-2" role="group" aria-label="Consumed limit">
      {eligible.map((bucket) => <Button key={bucket.id} variant="outline" aria-pressed={selected?.id === bucket.id} disabled={usage.reset.isPending} onClick={() => { usage.reset.reset(); setSelectedId(bucket.id); }}>{bucket.policyName} - {gatewayTimeframeLabels[bucket.timeframe]}</Button>)}
    </div></Field></FieldGroup> : null}
    {selected ? <GatewayResetForm key={`${usage.scopeKey}:${selected.id}`} bucket={selected} pending={usage.reset.isPending} error={usage.reset.isError} submitLabel="Request Increase" onSubmit={(reason) => usage.reset.mutate({ bucketId: selected.id, reason }, { onSuccess: onClose })} /> : null}
  </div>;
}

export function GatewayUsageNotice({ state, status, stale }: {
  state: "blocked" | "over_limit"; status: GatewayUsageStatus; stale: boolean;
}) {
  const [requestOpen, setRequestOpen] = useState(false);
  const buckets = status.buckets.filter((bucket) => bucket.usedMicroUsd >= bucket.allowanceMicroUsd && (state !== "blocked" || bucket.hardLimit));
  const canRequestIncrease = buckets.some((bucket) => bucket.allowRequestReset && bucket.canRequestReset && bucket.resetRequestStatus !== "pending");
  return <>
    <Alert className="mx-auto mb-2 max-w-3xl" data-testid="gateway-usage-notice">
      {state === "blocked" ? <LockKeyhole aria-hidden="true" className="size-4" /> : null}
      <AlertTitle>{state === "blocked" ? "Out of usage" : "Over estimated usage allowance"}</AlertTitle>
      <AlertDescription>
        <p>{state === "blocked" ? "You've consumed the AI usage limits assigned to you." : "You’re over your estimated usage allowance. Requests are still allowed."}</p>
        {canRequestIncrease ? <p>You can request an increase to your limits here: <Button variant="link" size="sm" className="h-auto px-0 py-0 align-baseline" disabled={stale} onClick={() => setRequestOpen(true)}>Request Increase</Button></p> : null}
        {buckets.map((bucket) => <div key={bucket.id} className="flex flex-col gap-1">
          <p>Consumed Limit: {bucket.policyName} - {gatewayTimeframeLabels[bucket.timeframe]}</p>
          <p>Next Reset: <GatewayResetTime value={bucket.resetAt} localOnly /></p>
        </div>)}
        {stale ? <p role="status">Could not refresh usage. Showing the last known limit; open View Usage Limits to retry.</p> : null}
        <GatewayUsageTrigger compact={false} />
      </AlertDescription>
    </Alert>
    <Dialog open={requestOpen} onOpenChange={setRequestOpen}>
      <DialogContent aria-describedby={undefined}><DialogHeader><DialogTitle>Request Increase</DialogTitle></DialogHeader>
        {requestOpen ? <GatewayIncreaseDialogBody bucketIds={buckets.map((bucket) => bucket.id)} onClose={() => setRequestOpen(false)} /> : null}
      </DialogContent>
    </Dialog>
  </>;
}
