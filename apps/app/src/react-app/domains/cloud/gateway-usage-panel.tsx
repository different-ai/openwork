import { useId, useState, type ReactNode } from "react";
import { CheckCircle2, ChevronRight, Clock, Gauge, LockKeyhole } from "lucide-react";
import { useNavigate } from "react-router";
import type { GatewayUsageBucket, GatewayUsageStatus } from "@openwork/types/den/gateway-usage-limits";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  allGatewayUsageBuckets,
  formatGatewayMoney,
  formatGatewayReset,
  gatewayIncreaseMicroUsd,
  gatewayPercentLeft,
  gatewayPeriodLabels,
  gatewayUsageLimitGroups,
  gatewayPeriodPossessives,
} from "./gateway-usage-state";
import { useGatewayUsage } from "./use-gateway-usage";
import { gatewayApprovalKey, useGatewayApprovalDismissals } from "./gateway-usage-approval-store";
import { UsageLimitCard, UsageLimitLocked, useUsageLimitViewer } from "./usage-limit-card";
import { denDashboardUrl } from "@/app/lib/den-dashboard-links";
import { openAlternativeModelPicker } from "@/app/lib/inference-access";
import { usePlatform } from "@/react-app/kernel/platform";

export const GATEWAY_USAGE_SETTINGS_PATH = "/settings/usage";

export function GatewayResetTime({ value, midSentence = false }: { value: string; midSentence?: boolean }) {
  const text = formatGatewayReset(value, Date.now());
  return <time dateTime={value} title={new Date(value).toLocaleString()}>{midSentence ? `r${text.slice(1)}` : text}</time>;
}

function exhausted(bucket: GatewayUsageBucket) {
  return bucket.usedMicroUsd >= bucket.allowanceMicroUsd;
}

function canAsk(bucket: GatewayUsageBucket) {
  return bucket.allowRequestReset && bucket.canRequestReset && bucket.resetRequestStatus !== "pending" && exhausted(bucket);
}

/** The exhausted bucket that keeps a member blocked longest decides what the card says. */
function longestBlock(buckets: GatewayUsageBucket[]) {
  return [...buckets].sort((a, b) => Date.parse(b.resetAt) - Date.parse(a.resetAt))[0];
}

/** The notice card above the composer: what is true, one line of detail, its actions, and an optional inline form. */
export function ComposerNoticeCard({ icon, title, detail, actions, children, testId }: {
  icon: ReactNode; title: ReactNode; detail?: ReactNode; actions?: ReactNode; children?: ReactNode; testId?: string;
}) {
  return (
    <section data-testid={testId} className="mx-auto mb-2 flex w-full max-w-3xl flex-col gap-3 rounded-[14px] border border-border bg-background py-3 pe-3 ps-4">
      <div className="flex items-center gap-3">
        <span aria-hidden="true" className="flex shrink-0 text-foreground [&_svg]:size-4">{icon}</span>
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 className="text-[13px] font-medium leading-5 text-foreground">{title}</h2>
          {detail ? <p className="text-xs leading-4 text-muted-foreground">{detail}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function GatewayIncreaseForm({ pending, error, onSubmit, onCancel }: {
  pending: boolean; error: boolean;
  onSubmit: (reason: string) => void;
  onCancel?: () => void;
}) {
  const [reason, setReason] = useState("");
  const id = useId();
  const trimmed = reason.trim();
  return (
    <form className="flex flex-col gap-2" onSubmit={(event) => {
      event.preventDefault();
      if (!pending && trimmed && trimmed.length <= 2000) onSubmit(trimmed);
    }}>
      <label htmlFor={id} className="text-xs font-medium text-foreground">What do you need it for?</label>
      <Textarea id={id} required maxLength={2000} value={reason} autoFocus onChange={(event) => setReason(event.target.value)} disabled={pending} className="min-h-16" />
      {error ? <p role="alert" className="text-xs text-muted-foreground">Your request couldn’t be confirmed. Check your usage before asking again.</p> : null}
      <div className="flex items-center justify-end gap-1">
        {onCancel ? <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={onCancel}>Cancel</Button> : null}
        <Button type="submit" size="sm" disabled={pending || !trimmed || trimmed.length > 2000}>{pending ? "Sending…" : "Send request"}</Button>
      </div>
    </form>
  );
}

export function GatewayUsageNotice({ state, status, stale, providerName = null, canSwitchProvider = false, sessionId, messageSaved = false }: {
  state: "blocked" | "over_limit"; status: GatewayUsageStatus; stale: boolean;
  /** Set when the selected model's provider has its own limit. */
  providerName?: string | null;
  /** Another provider the member has still has room. */
  canSwitchProvider?: boolean;
  /** The conversation whose model picker "Use another model" opens. */
  sessionId?: string;
  /** A refused message is kept in the conversation. */
  messageSaved?: boolean;
}) {
  const navigate = useNavigate();
  const platform = usePlatform();
  const usage = useGatewayUsage(true);
  const [asking, setAsking] = useState(false);
  const viewer = useUsageLimitViewer();
  const buckets = status.buckets.filter((bucket) => exhausted(bucket) && (state !== "blocked" || bucket.hardLimit));
  const bucket = longestBlock(buckets);
  if (!bucket) return null;
  const seeUsage = <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => navigate(GATEWAY_USAGE_SETTINGS_PATH)}>See usage</Button>;
  const staleNote = stale ? "Couldn’t refresh, showing the last known limit" : null;
  const forProvider = providerName ? ` for ${providerName}` : "";
  const switchNote = canSwitchProvider ? <span data-testid="gateway-usage-switch-provider"> Switch to a model from another provider to keep working.</span> : null;

  if (state === "over_limit") {
    return (
      <ComposerNoticeCard testId="gateway-usage-notice" icon={<Gauge />}
        title={`${formatGatewayMoney(bucket.usedMicroUsd - bucket.allowanceMicroUsd)} over ${gatewayPeriodPossessives[bucket.timeframe]} ${formatGatewayMoney(bucket.allowanceMicroUsd)}${forProvider}`}
        detail={staleNote ?? <>You can keep working. <GatewayResetTime value={bucket.resetAt} /></>}
        actions={seeUsage} />
    );
  }

  const pendingBucket = buckets.find((item) => item.resetRequestStatus === "pending");
  if (pendingBucket) {
    return (
      <ComposerNoticeCard testId="gateway-usage-notice" icon={<Clock />}
        title={`Asked for ${formatGatewayMoney(gatewayIncreaseMicroUsd(pendingBucket))} more ${gatewayPeriodLabels[pendingBucket.timeframe].toLowerCase()}${forProvider}`}
        detail={staleNote ?? <>Waiting for an admin{switchNote ? "." : null}{switchNote}</>}
        actions={seeUsage} />
    );
  }

  const askable = longestBlock(buckets.filter(canAsk));
  const amount = askable ? formatGatewayMoney(gatewayIncreaseMicroUsd(askable)) : null;
  if (asking && askable && amount) {
    return (
      <ComposerNoticeCard testId="gateway-usage-notice" icon={<LockKeyhole />}
        title={`Ask for ${amount} more ${gatewayPeriodLabels[askable.timeframe].toLowerCase()}${forProvider}`}
        detail="An admin reviews it">
        <div className="ps-7">
          <GatewayIncreaseForm pending={usage.reset.isPending} error={usage.reset.isError}
            onCancel={() => { usage.reset.reset(); setAsking(false); }}
            onSubmit={(reason) => usage.reset.mutate({ bucketId: askable.id, reason }, { onSuccess: () => setAsking(false) })} />
        </div>
      </ComposerNoticeCard>
    );
  }

  // The shared usage-limit card: admins raise the budget, members ask for more, everyone can switch models.
  return (
    <UsageLimitCard testId="gateway-usage-notice" kind="gateway_budget" saved={messageSaved}
      title={`You’ve used ${gatewayPeriodPossessives[bucket.timeframe]} ${formatGatewayMoney(bucket.allowanceMicroUsd)}${forProvider}`}
      reset={staleNote ?? <><GatewayResetTime value={bucket.resetAt} />{switchNote}</>}
      actions={<>
        {viewer.canBuy ? <Button size="sm" onClick={() => platform.openLink(denDashboardUrl(viewer.denBaseUrl, "gatewayLimits"))}>Raise budget</Button>
          : askable && amount ? <Button size="sm" disabled={stale} onClick={() => { usage.reset.reset(); setAsking(true); }}>Ask for {amount} more</Button>
            : <UsageLimitLocked label="Ask an admin for more" reason="An admin can raise your budget" />}
        {sessionId ? <Button size="sm" variant="ghost" onClick={() => openAlternativeModelPicker(sessionId)}>Use another model</Button> : null}
        {seeUsage}
      </>} />
  );
}

function approvedUsageIncreases(status?: GatewayUsageStatus) {
  return (status ? allGatewayUsageBuckets(status) : []).filter((bucket) => bucket.resetRequestStatus === "approved"
    && bucket.extensionMicroUsd > 0 && Date.parse(bucket.resetAt) > Date.now());
}

export function GatewayUsageApprovalNotice() {
  const usage = useGatewayUsage(true);
  const dismissedKeys = useGatewayApprovalDismissals((state) => state.dismissedKeys);
  const dismiss = useGatewayApprovalDismissals((state) => state.dismiss);
  const scopeKey = usage.approvalScopeKey;
  const approved = scopeKey ? approvedUsageIncreases(usage.data).filter((bucket) =>
    !dismissedKeys.includes(gatewayApprovalKey(JSON.stringify([scopeKey, bucket.extensionMicroUsd]), bucket))) : [];
  if (!usage.active || usage.query.isError || !scopeKey || !approved.length) return null;
  const [first] = approved;
  return (
    <div role="status">
      <ComposerNoticeCard testId="gateway-usage-approved-notice" icon={<CheckCircle2 className="text-green-11" />}
        title={`You got ${formatGatewayMoney(first.extensionMicroUsd)} more ${gatewayPeriodLabels[first.timeframe].toLowerCase()}`}
        detail={<>{formatGatewayMoney(first.allowanceMicroUsd)} for {gatewayPeriodLabels[first.timeframe].toLowerCase()}, <GatewayResetTime value={first.resetAt} midSentence /></>}
        actions={<Button size="sm" variant="ghost" className="text-muted-foreground" aria-label="Dismiss usage increase approval" onClick={() => dismiss(approved.map((bucket) => gatewayApprovalKey(JSON.stringify([scopeKey, bucket.extensionMicroUsd]), bucket)))}>Dismiss</Button>} />
    </div>
  );
}

/** The account menu's quiet summary: how much of each limit is left. */
export function GatewayUsageMenuItem() {
  const navigate = useNavigate();
  const usage = useGatewayUsage(true);
  if (!usage.authorized) return null;
  const groups = usage.data ? gatewayUsageLimitGroups(usage.data) : [];
  // Only label the items when there is more than the default to tell apart.
  const labelled = groups.some((group) => group.providerName !== null);
  return (
    <DropdownMenuItem data-testid="gateway-usage-menu-item" className="flex-col items-stretch gap-0.5" onClick={() => navigate(GATEWAY_USAGE_SETTINGS_PATH)}>
      <span className="flex items-center gap-2">
        <Gauge className="size-3.5" />
        <span className="flex-1">Usage</span>
        <ChevronRight className="size-3.5 text-muted-foreground" />
      </span>
      {usage.data && !groups.length ? <span className="ps-5.5 text-xs text-muted-foreground">No limit</span> : null}
      {groups.map((group) => (
        <span key={group.key} className={`flex flex-col gap-0.5 ${labelled ? "pt-1" : ""}`} data-testid={group.providerName === null ? "gateway-usage-menu-default" : "gateway-usage-menu-provider"}>
          {labelled ? <span className="truncate ps-5.5 text-xs font-medium text-foreground">{group.providerName ?? "Default"}</span> : null}
          {group.buckets.map((bucket) => (
            <span key={bucket.id} className="flex justify-between ps-5.5 text-xs">
              <span className="text-muted-foreground">{gatewayPeriodLabels[bucket.timeframe]}</span>
              <span className="tabular-nums text-foreground">{gatewayPercentLeft(bucket)}% left</span>
            </span>
          ))}
        </span>
      ))}
    </DropdownMenuItem>
  );
}

function SettingsSection({ title, detail, children, testId }: { title: string; detail?: string; children: ReactNode; testId?: string }) {
  return (
    <section aria-label={title} data-testid={testId} className="flex flex-col gap-2.5">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-[13px] font-semibold text-foreground">{title}</h2>
        {detail ? <p className="text-xs text-muted-foreground">{detail}</p> : null}
      </div>
      <div className="flex flex-col divide-y divide-border rounded-xl border border-border bg-background">{children}</div>
    </section>
  );
}

function LimitRow({ bucket }: { bucket: GatewayUsageBucket }) {
  const left = gatewayPercentLeft(bucket);
  return (
    <div aria-label={`${gatewayPeriodLabels[bucket.timeframe]} usage`} className="flex flex-col gap-2 px-3.5 py-3">
      <div className="flex items-baseline justify-between text-[13px]">
        <span className="text-foreground">{gatewayPeriodLabels[bucket.timeframe]}</span>
        <span className="tabular-nums text-foreground">{left}% left</span>
      </div>
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{exhausted(bucket) ? <>Used up. <GatewayResetTime value={bucket.resetAt} /></> : <GatewayResetTime value={bucket.resetAt} />}</span>
        <span className="tabular-nums">{formatGatewayMoney(Math.max(0, bucket.allowanceMicroUsd - bucket.usedMicroUsd))} of {formatGatewayMoney(bucket.allowanceMicroUsd)} left</span>
      </div>
      <Progress value={left} aria-label={`${left}% of ${gatewayPeriodLabels[bucket.timeframe].toLowerCase()} left`}
        className="gap-0 [&_[data-slot=progress-indicator]]:bg-foreground [&_[data-slot=progress-track]]:h-1" />
    </div>
  );
}

function RequestRow({ bucket, providerName, asking, onAsk, onCancel, onSubmit, pending, error, disabled }: {
  bucket: GatewayUsageBucket; providerName?: string; asking: boolean; pending: boolean; error: boolean; disabled: boolean;
  onAsk: () => void; onCancel: () => void; onSubmit: (reason: string) => void;
}) {
  const amount = formatGatewayMoney(gatewayIncreaseMicroUsd(bucket));
  const state = bucket.resetRequestStatus === "pending" ? <span className="flex items-center gap-1.5 text-foreground"><Clock className="size-3.5" />Asked for {amount} more, waiting for an admin</span>
    : canAsk(bucket) ? null
      : bucket.resetRequestStatus === "approved" && bucket.extensionMicroUsd > 0 ? <span className="text-foreground">Added {formatGatewayMoney(bucket.extensionMicroUsd)}</span>
        : bucket.resetRequestStatus === "denied" ? <span className="text-muted-foreground">Request declined</span>
          : <span className="text-muted-foreground">You can ask once it runs out</span>;
  return (
    <div aria-label={`${gatewayPeriodLabels[bucket.timeframe]}${providerName ? ` ${providerName}` : ""} increase`} className="flex flex-col gap-3 px-3.5 py-2.5">
      <div className="flex min-h-7 items-center gap-3 text-[13px]">
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="text-foreground">{gatewayPeriodLabels[bucket.timeframe]}</span>
          {providerName ? <span className="truncate text-xs text-muted-foreground">{providerName}</span> : null}
        </span>
        <span className="text-xs">{state ?? (asking ? null : <Button size="sm" disabled={disabled} onClick={onAsk}>Ask for {amount} more</Button>)}</span>
      </div>
      {asking && !state ? <GatewayIncreaseForm pending={pending} error={error} onCancel={onCancel} onSubmit={onSubmit} /> : null}
    </div>
  );
}

function TechnicalDetails({ status }: { status: GatewayUsageStatus }) {
  const { coverage } = status;
  const rows: [string, ReactNode][] = [];
  if (coverage.trackingStartedAt) rows.push(["Counting since", new Date(coverage.trackingStartedAt).toLocaleString()]);
  if (coverage.historicalCoverage === "unknown" || coverage.historicalUnknownReason != null) rows.push(["Spend before that", "Not counted"]);
  if (coverage.unpricedRequests > 0) rows.push(["Requests without a price yet", String(coverage.unpricedRequests)]);
  if ((coverage.incompleteRequests ?? 0) > 0) rows.push(["Requests still being counted", String(coverage.incompleteRequests)]);
  if (typeof coverage.pendingRequests === "number" && coverage.pendingRequests > 0) rows.push(["Waiting to be counted", String(coverage.pendingRequests)]);
  rows.push(["Chats still running", "Added when they finish"]);
  if (coverage.lastSettlementAt) rows.push(["Last updated", new Date(coverage.lastSettlementAt).toLocaleString()]);
  return (
    <details className="group text-xs" data-testid="gateway-usage-technical-details">
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 text-muted-foreground [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3.5 transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none" />Technical details
      </summary>
      <dl className="flex max-w-sm flex-col gap-2 ps-5 pt-3">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-4">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="text-foreground">{value}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

export function GatewayUsageSettingsView({ onOpenAccount }: { onOpenAccount: () => void }) {
  const usage = useGatewayUsage(true, true);
  const [askingId, setAskingId] = useState<string | null>(null);
  const status = usage.data;
  const groups = status ? gatewayUsageLimitGroups(status) : [];
  const labelled = groups.some((group) => group.providerName !== null);
  const requestable = groups.flatMap((group) => group.buckets.map((bucket) => ({ bucket, providerName: labelled ? group.providerName ?? "Default" : undefined })))
    .filter(({ bucket }) => bucket.allowRequestReset);
  const content = !usage.authorized ? (
    <div className="flex flex-col items-start gap-3">
      <p className="text-[13px] text-muted-foreground">Sign in to OpenWork Cloud to see your usage limits.</p>
      <Button size="sm" variant="outline" onClick={onOpenAccount}>Open Account</Button>
    </div>
  ) : usage.query.isPending ? (
    <div role="status" aria-label="Loading usage limits" className="flex flex-col gap-3">
      <Skeleton className="h-4 w-32" />
      <Skeleton className="h-28 w-full rounded-xl" />
    </div>
  ) : !status ? (
    <div className="flex flex-col items-start gap-3" role="alert">
      <p className="text-[13px] text-muted-foreground">Couldn’t load your usage. This doesn’t mean you have no limit.</p>
      <Button size="sm" variant="outline" disabled={usage.query.isFetching} onClick={() => void usage.query.refetch()}>Try again</Button>
    </div>
  ) : (
    <>
      {usage.query.isError ? (
        <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
          Couldn’t refresh, showing the last known limits.
          <Button size="xs" variant="ghost" disabled={usage.query.isFetching} onClick={() => void usage.query.refetch()}>Try again</Button>
        </p>
      ) : null}
      {!groups.length ? (
        <SettingsSection title="Your limits">
          <div className="flex items-center justify-between px-3.5 py-3 text-[13px]"><span className="text-foreground">No limit</span></div>
        </SettingsSection>
      ) : groups.map((group) => (
        <SettingsSection key={group.key}
          testId={group.providerName === null ? "gateway-usage-default-limit" : "gateway-usage-provider-limit"}
          title={!labelled ? "Your limits" : group.providerName ?? "Default"}
          detail={!labelled ? "Set by your organization" : group.providerName === null ? "For providers without their own limit" : `Only ${group.providerName} models count here`}>
          {group.buckets.map((bucket) => <LimitRow key={bucket.id} bucket={bucket} />)}
        </SettingsSection>
      ))}
      {requestable.length ? (
        <SettingsSection title="More usage" detail="Each approval adds 25% of your base allowance">
          {requestable.map(({ bucket, providerName }) => (
            <RequestRow key={bucket.id} bucket={bucket} providerName={providerName} asking={askingId === bucket.id}
              pending={usage.reset.isPending} error={usage.reset.isError} disabled={usage.query.isError || usage.reset.isPending}
              onAsk={() => { usage.reset.reset(); setAskingId(bucket.id); }}
              onCancel={() => { usage.reset.reset(); setAskingId(null); }}
              onSubmit={(reason) => usage.reset.mutate({ bucketId: bucket.id, reason }, { onSuccess: () => setAskingId(null) })} />
          ))}
        </SettingsSection>
      ) : null}
      <TechnicalDetails status={status} />
    </>
  );
  return <div data-testid="gateway-usage-settings" className="flex w-full max-w-3xl flex-col gap-8">{content}</div>;
}
