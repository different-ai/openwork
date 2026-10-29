"use client";

import Link from "next/link";
import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { keepPreviousData, QueryClient, QueryClientProvider, useMutation, useQuery } from "@tanstack/react-query";
import { ArrowDownRight, ArrowUpRight, ChevronRight, CircleAlert, RefreshCw } from "lucide-react";
import {
  adminControlCenterSchema,
  CONTROL_CENTER_CAPABILITY_TRACKING_STARTED,
  CONTROL_CENTER_TREND_START,
  type AdminControlCenter,
  type ControlCenterRange,
  type ControlCenterSection,
  type ControlCenterSectionKey,
} from "@openwork/types/den/admin-control-center";
import { DenButton } from "../../../app/(den)/_components/ui/button";
import { DenSegmented } from "../../../app/(den)/_components/ui/segmented";
import { DenSkeleton } from "../../../app/(den)/_components/ui/skeleton";
import { DenTable, type DenTableColumn } from "../../../app/(den)/_components/ui/table";
import { SERIES_PALETTE } from "../../../app/(den)/dashboard/_features/analytics/series-colors";
import { requestAdmin, sendAdmin } from "../admin-request";
import {
  change, CONNECTOR_ERROR_THRESHOLD, CONNECTOR_MIN_CALLS, controlCenterSignals, count, decimal, percent, relativeTime, shortDate, weekLabel,
} from "./control-center-model";

const charts = () => import("./control-center-charts");
const Sparkline = lazy(() => charts().then((module) => ({ default: module.Sparkline })));
const LifecycleChart = lazy(() => charts().then((module) => ({ default: module.LifecycleChart })));
const GainsChart = lazy(() => charts().then((module) => ({ default: module.GainsChart })));
const SignupsChart = lazy(() => charts().then((module) => ({ default: module.SignupsChart })));
const OrganizationsChart = lazy(() => charts().then((module) => ({ default: module.OrganizationsChart })));
const FunnelChart = lazy(() => charts().then((module) => ({ default: module.FunnelChart })));
const FailureChart = lazy(() => charts().then((module) => ({ default: module.FailureChart })));
const CapabilityUsageChart = lazy(() => charts().then((module) => ({ default: module.CapabilityUsageChart })));
const RevenueChart = lazy(() => charts().then((module) => ({ default: module.RevenueChart })));

const RANGES = [{ value: "7d", label: "7 days" }, { value: "30d", label: "30 days" }, { value: "90d", label: "90 days" }] as const;
const RANGE_KEY = "openwork:admin:control-center-range";
const REFRESH_WATCH_MS = 3 * 60_000;
const trackingNote = `Usage tracking started on ${shortDate("2026-10-09")} and finished rolling out around ${shortDate(CONTROL_CENTER_TREND_START)}, so trends start there.`;
const capabilityNote = `Skill and MCP usage tracking started on ${shortDate(CONTROL_CENTER_CAPABILITY_TRACKING_STARTED)}.`;

class ControlCenterError extends Error {
  constructor(message: string, readonly access: "signed-out" | "forbidden" | "error") { super(message); }
}

function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function storedRange(): ControlCenterRange {
  try {
    const value = window.localStorage.getItem(RANGE_KEY);
    return value === "30d" || value === "90d" ? value : "7d";
  } catch {
    return "7d";
  }
}

export function AdminControlCenter({ onAccessDenied }: { onAccessDenied: (access: "signed-out" | "forbidden") => void }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 60_000, retry: 1, refetchOnWindowFocus: true } } }));
  return <QueryClientProvider client={client}><ControlCenter onAccessDenied={onAccessDenied} /></QueryClientProvider>;
}

function ControlCenter({ onAccessDenied }: { onAccessDenied: (access: "signed-out" | "forbidden") => void }) {
  const [range, setRange] = useState<ControlCenterRange>("7d");
  useEffect(() => setRange(storedRange()), []);
  const [refreshRequestedAt, setRefreshRequestedAt] = useState<number | null>(null);
  const [refreshMessage, setRefreshMessage] = useState<string | null>(null);
  const now = useNow(30_000);
  const watching = refreshRequestedAt !== null && now - refreshRequestedAt < REFRESH_WATCH_MS;
  const query = useQuery({
    queryKey: ["admin-control-center", range],
    queryFn: async ({ signal }) => {
      const result = await requestAdmin(`/v1/admin/control-center?range=${range}`, (payload) => {
        const parsed = adminControlCenterSchema.safeParse(payload);
        return parsed.success ? parsed.data : null;
      }, signal);
      if (result.access === "ready") return result.data;
      throw new ControlCenterError(result.message, result.access);
    },
    placeholderData: keepPreviousData,
    refetchInterval: watching ? 5_000 : 60_000,
  });
  const denied = query.error instanceof ControlCenterError && query.error.access !== "error" ? query.error.access : null;
  useEffect(() => { if (denied) onAccessDenied(denied); }, [denied, onAccessDenied]);

  const view = query.data;
  // Stop watching once every section that can succeed has been recomputed since the request.
  useEffect(() => {
    if (!view || refreshRequestedAt === null) return;
    const done = Object.values(view.sections).every((section) => section.error !== null || (section.computedAt !== null && Date.parse(section.computedAt) >= refreshRequestedAt - 1_000));
    if (done) { setRefreshRequestedAt(null); setRefreshMessage(null); }
  }, [view, refreshRequestedAt]);

  // A refusal or error is a passing note; a running refresh keeps its message until it finishes.
  useEffect(() => {
    if (!refreshMessage || refreshRequestedAt !== null) return;
    const timer = window.setTimeout(() => setRefreshMessage(null), 8_000);
    return () => window.clearTimeout(timer);
  }, [refreshMessage, refreshRequestedAt]);

  const refresh = useMutation({
    mutationFn: () => sendAdmin("/v1/admin/control-center/refresh", "POST"),
    onSuccess: (result) => {
      if (result.ok) {
        setRefreshRequestedAt(Date.now());
        setRefreshMessage("Refreshing every section…");
      } else if (result.status === 429) {
        setRefreshMessage(`Refreshed less than a minute ago. Try again in ${result.retryAfterSeconds ?? 60} s.`);
      } else {
        setRefreshMessage(result.message);
      }
    },
    onError: (error) => setRefreshMessage(error instanceof Error ? error.message : "Could not start a refresh."),
  });

  const chooseRange = (value: ControlCenterRange) => {
    setRange(value);
    try { window.localStorage.setItem(RANGE_KEY, value); } catch { /* Storage is optional. */ }
  };
  const newest = view ? Object.values(view.sections).map((section) => section.computedAt).filter((value): value is string => value !== null).sort().at(-1) ?? null : null;
  const staleCount = view ? Object.values(view.sections).filter((section) => section.stale).length : 0;

  return <div data-testid="admin-control-center" className="pt-5">
    <div className="sticky top-0 z-20 -mx-1 flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white px-1 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-semibold text-slate-950">Control center</h2>
        <DenSegmented aria-label="Date range" options={RANGES} value={range} onChange={chooseRange} optionTestId={(value) => `admin-control-center-range-${value}`} />
      </div>
      <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500">
        <p role="status" aria-live="polite" data-testid="admin-control-center-updated">
          {refreshMessage ?? (query.isPending ? "Loading snapshots…" : `${relativeTime(newest, now)}${staleCount ? ` · ${staleCount} stale` : ""}`)}
        </p>
        <DenButton data-testid="admin-control-center-refresh" variant="secondary" size="sm" icon={RefreshCw} loading={refresh.isPending || watching} disabled={!view} onClick={() => refresh.mutate()}>Refresh</DenButton>
      </div>
    </div>

    {query.isError && !denied ? <div role="alert" className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 py-4 text-sm text-red-700">
      <p>{query.error.message}{view ? " Showing the last loaded snapshots." : ""}</p>
      <DenButton variant="secondary" size="sm" onClick={() => void query.refetch()}>Retry</DenButton>
    </div> : null}

    <Attention view={view} />
    <Pulse section={view?.sections.pulse} now={now} />

    <div className="grid grid-cols-1 gap-4 pb-6 lg:grid-cols-12">
      <Group title="Growth and lifecycle" />
      <Panel title="Weekly active people" caption="Everyone who ran a task each week, by whether they are new, stayed, came back, or were lost." span="lg:col-span-8" section={view?.sections.lifecycle} now={now} testId="lifecycle" notes={[trackingNote]}>
        {(data) => data.weeks.every((week) => week.new + week.stillActive + week.returned + week.lost === 0) ? <Empty>No one ran a task in the complete weeks of this range.</Empty> : <>
          <Chart height="h-64"><LifecycleChart weeks={data.weeks} /></Chart>
          {data.weeks.length > 1 ? <>
            <p className="mb-1 mt-4 text-xs font-medium text-slate-600">Gained per person lost (above 1 means growth)</p>
            <Chart height="h-24"><GainsChart weeks={data.weeks} /></Chart>
          </> : <p className="mt-4 text-sm text-slate-700"><span className="font-semibold tabular-nums text-slate-950">{decimal(data.weeks[0]?.gainsVsLosses ?? null, 2)}</span> gained per person lost in the week of {weekLabel(data.weeks[0]?.week ?? "")}. Above 1 means growth.</p>}
        </>}
      </Panel>
      <div className="grid min-w-0 gap-4 lg:col-span-4">
      <Panel title="Sign-ups" caption="New accounts per day and how many use a work email." span="" section={view?.sections.pulse} now={now} testId="signups">
        {(data) => {
          const days = data.daily.filter((day) => day.date >= CONTROL_CENTER_TREND_START);
          return days.every((day) => day.signups === 0) ? <Empty>No sign-ups in this range.</Empty> : <Chart height="h-56"><SignupsChart daily={days} /></Chart>;
        }}
      </Panel>
      <Panel title="New organizations" caption="Every sign-up creates a personal workspace; teams have two or more people." span="" section={view?.sections.lifecycle} now={now} testId="organizations">
        {(data) => data.organizations.every((week) => week.personal + week.team === 0) ? <Empty>No organizations created in these weeks.</Empty> : <Chart height="h-56"><OrganizationsChart weeks={data.organizations} /></Chart>}
      </Panel>
      </div>

      <Group title="Activation and retention" />
      <Panel title="Activation" caption="Of people who signed up at least two weeks ago, how many got going and came back." span="lg:col-span-4" section={view?.sections.lifecycle} now={now} testId="activation">
        {(data) => data.activation.signedUp === 0 ? <Empty>No sign-ups old enough to measure in this range yet.</Empty> : <>
          <Chart height="h-48"><FunnelChart steps={[
            { label: "Signed up", people: data.activation.signedUp },
            { label: "Ran a task in 3 days", people: data.activation.ranTaskWithin3Days },
            { label: "Came back in week 1", people: data.activation.backAfterDay1 },
            { label: "Active in week 2", people: data.activation.activeInWeek1 },
          ]} /></Chart>
          <p className="mt-2 text-xs text-slate-500">Signed up {shortDate(data.activation.from)}–{shortDate(data.activation.to)}</p>
        </>}
      </Panel>
      <Panel title="Weekly cohort retention" caption="Share of each signup week's people who ran a task N weeks after signing up." span="lg:col-span-8" section={view?.sections.lifecycle} now={now} testId="cohorts">
        {(data) => data.cohorts.length === 0 ? <Empty>No complete signup weeks yet.</Empty> : <CohortTable cohorts={data.cohorts} />}
      </Panel>

      <Group title="Reactivation and invitations" />
      <Panel title="Coming back" caption="People returning after a quiet stretch, and whether they stay." span="lg:col-span-6" section={view?.sections.lifecycle} now={now} testId="reactivation" notes={["Reactivation for older accounts can include people who only recently updated the app and started sending usage data."]}>
        {(data) => {
          const r = data.reactivation;
          return <Stats rows={[
            { label: "Reactivated", value: count(r.reactivated), detail: `Week of ${weekLabel(r.week)} · quiet 14+ days, account 14+ days old` },
            { label: "Back after a skipped week", value: count(r.returned), detail: `Week of ${weekLabel(r.week)}` },
            { label: "Lost", value: count(r.lost), detail: "Active the week before, not this week" },
            { label: "Returners who stayed", value: percent(r.returnersStayed.rate), detail: `${count(r.returnersStayed.stayed)} of ${count(r.returnersStayed.returned)} who came back in the week of ${weekLabel(r.returnersStayed.week)}` },
            { label: "Inactive pool", value: count(r.inactivePool), detail: "Accounts older than 30 days with no task in 30 days" },
          ]} />;
        }}
      </Panel>
      <Panel title="Invitations" caption="Whether invited teammates join and start working." span="lg:col-span-6" section={view?.sections.invitations} now={now} testId="invitations">
        {(data) => {
          const i = data.invitations;
          const decided = i.accepted + i.expired + i.canceled;
          return <>
            <Stats rows={[
              { label: "Joined through an invite", value: count(data.joinedThroughInvite), detail: `${count(data.peopleWithAcceptedInvite)} people` },
              { label: "Ran a task", value: percent(data.joinedThroughInvite ? data.joinedRanTask / data.joinedThroughInvite : null), detail: `${count(data.joinedRanTaskWithin7Days)} within 7 days of joining` },
              { label: "Invitations sent", value: count(i.sent), detail: `${count(i.accepted)} accepted · ${count(i.expired)} expired · ${count(i.pending)} pending · ${count(i.canceled)} canceled` },
              { label: "Acceptance rate", value: percent(decided ? i.accepted / decided : null), detail: i.medianHoursToAccept === null ? "No accepted invitations" : `Median ${decimal(i.medianHoursToAccept)} h to accept` },
              { label: "Pending now", value: count(data.pendingNow), detail: "Unexpired invitations across every organization" },
              data.outreach
                ? { label: "Active within 7 days of contact", value: `${count(data.outreach.activeWithin7Days)} of ${count(data.outreach.contactedOrganizations)}`, detail: "Organizations contacted in this range" }
                : { label: "Active within 7 days of contact", value: "—", detail: "No outreach recorded yet. Logged follow-ups and team nudges appear here." },
            ]} />
          </>;
        }}
      </Panel>

      <Group title="Skills and MCP sharing" />
      <Panel title="Skill and MCP use" caption="People using skills and MCP connections, and how much of it is shared work." span="lg:col-span-8" section={view?.sections.sharing} now={now} testId="sharing" notes={[capabilityNote, "Built-in default plugins and marketplaces are left out."]}>
        {(data) => <>
          {data.weekly.every((week) => week.skillUsers + week.mcpUsers === 0) ? <Empty>No skill or MCP use recorded in this range.</Empty> : <Chart height="h-56"><CapabilityUsageChart weekly={data.weekly} /></Chart>}
          <div className="mt-4"><Stats columns rows={[
            { label: "Skills shared", value: percent(data.skills.sharingRate), detail: `${count(data.skills.sharedTeamSkills)} of ${count(data.skills.teamSkills)} team skills` },
            { label: "Teammate skill reuse", value: percent(data.skills.teammateReuseRate), detail: `${compactCount(data.skills.teammateUses)} of ${compactCount(data.skills.teamUses)} uses` },
            { label: "Shared MCP calls", value: percent(data.mcp.sharedReuseRate), detail: `${compactCount(data.mcp.sharedConnectionCalls)} of ${compactCount(data.mcp.teamCalls)} calls` },
            { label: "Skill creators", value: count(data.skills.creators), detail: `${count(data.catalog.plugins)} plugins · ${count(data.catalog.marketplaces)} marketplaces created` },
          ]} /></div>
        </>}
      </Panel>
      <Panel title="Top connectors" caption="Connections by people using them, with how often their calls fail." span="lg:col-span-4" section={view?.sections.sharing} now={now} testId="connectors">
        {(data) => data.connectors.length === 0 ? <Empty>No connector calls recorded in this range.</Empty> : <ConnectorTable connectors={data.connectors} />}
      </Panel>

      <Group title="Reliability" />
      <Panel title="Task failures" caption="Share of started tasks that failed, or never finished, each day." span="lg:col-span-12" section={view?.sections.pulse} now={now} testId="reliability" notes={[trackingNote]}>
        {(data) => {
          const days = data.daily.filter((day) => day.date >= CONTROL_CENTER_TREND_START);
          return days.every((day) => day.started === 0) ? <Empty>No tasks in this range.</Empty> : <Chart height="h-56"><FailureChart daily={days} /></Chart>;
        }}
      </Panel>

      <Group title="Revenue" />
      <Panel title="Paid plans" caption="Paid seats today, and plans started or canceled each month." span="lg:col-span-6" section={view?.sections.revenue} now={now} testId="revenue">
        {(data) => <>
          <Stats columns rows={[
            { label: "Active paid seats", value: count(data.activePaidSeats), detail: `${count(data.activePlans)} active plans` },
            { label: "Past due", value: count(data.pastDue), detail: data.pastDue ? "Payment failed; follow up" : "Every plan is current" },
          ]} />
          <div className="mt-4">{data.monthly.length === 0 ? <Empty>No paid plans started or canceled in the last six months.</Empty> : <Chart height="h-52"><RevenueChart monthly={data.monthly} /></Chart>}</div>
        </>}
      </Panel>
      <Panel title="Seat usage" caption="Paid organizations using the smallest share of their seats this week." span="lg:col-span-6" section={view?.sections.revenue} now={now} testId="seat-usage">
        {(data) => <SeatTable rows={data.atRisk} />}
      </Panel>

      <Group title="Accounts to watch" />
      <Panel title="Team organizations" caption="Teams ranked by people who ran a task in the last 7 days." span="lg:col-span-12" section={view?.sections.accounts} now={now} testId="accounts">
        {(data) => <AccountsTable rows={data.rows} />}
      </Panel>
    </div>
  </div>;
}

// The first analytics series color, also the charts' primary series.
const primary = SERIES_PALETTE[0] ?? "currentColor";
const compactCount = (value: number) => new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);

function Attention({ view }: { view: AdminControlCenter | undefined }) {
  if (!view) return null;
  const signals = controlCenterSignals(view);
  return <section aria-label="Needs attention" data-testid="admin-control-center-attention" className="border-b border-slate-200 py-3">
    {signals.length ? <ul className="flex flex-wrap gap-x-6 gap-y-2">
      {signals.map((signal) => <li key={signal.id} className="flex items-start gap-2 text-sm text-slate-700">
        <CircleAlert size={15} strokeWidth={1.75} aria-hidden="true" className={`mt-0.5 shrink-0 ${signal.tone === "warn" ? "text-amber-600" : "text-sky-600"}`} />
        <a href={`#admin-control-center-${signal.section}`} className="underline-offset-2 hover:underline">{signal.text}</a>
      </li>)}
    </ul> : <p className="text-sm text-slate-500">Nothing needs attention.</p>}
  </section>;
}

function ChangeBadge({ value, lowerIsBetter = false, suffix = "%" }: { value: number | null; lowerIsBetter?: boolean; suffix?: string }) {
  if (value === null) return <span className="text-xs font-medium text-slate-500">New</span>;
  if (value === 0) return <span className="text-xs font-medium text-slate-500">No change</span>;
  const Icon = value > 0 ? ArrowUpRight : ArrowDownRight;
  const good = lowerIsBetter ? value < 0 : value > 0;
  return <span className={`inline-flex items-center gap-0.5 text-xs font-medium tabular-nums ${good ? "text-emerald-700" : "text-rose-700"}`} title="Compared with the previous 7 days">
    <Icon size={13} aria-hidden="true" />{Math.abs(value)}{suffix}<span className="sr-only"> compared with the previous 7 days</span>
  </span>;
}

function Kpi({ label, value, badge, detail, spark, testId }: { label: string; value: string; badge: ReactNode; detail: ReactNode; spark: ReactNode; testId: string }) {
  return <div data-testid={testId} className="min-w-0 py-4 sm:px-4 xl:first:pl-0">
    <dt className="text-[13px] font-medium text-slate-600">{label}</dt>
    <dd className="mt-1.5 flex items-baseline gap-2"><span className="text-2xl font-semibold tracking-tight tabular-nums text-slate-950">{value}</span>{badge}</dd>
    <dd className="mt-1 text-xs text-slate-500">{detail}</dd>
    <dd className="mt-2"><Suspense fallback={<DenSkeleton className="h-9" />}>{spark}</Suspense></dd>
  </div>;
}

function Pulse({ section, now }: { section: ControlCenterSection<"pulse"> | undefined; now: number }) {
  const data = section?.data;
  if (!section || !data) {
    return <div id="admin-control-center-pulse" className="grid grid-cols-2 gap-4 border-b border-slate-200 py-4 xl:grid-cols-5" aria-busy={!section}>
      {[0, 1, 2, 3, 4].map((index) => <div key={index}><DenSkeleton className="h-3 w-24" /><DenSkeleton className="mt-3 h-7 w-20" /><DenSkeleton className="mt-3 h-9" /></div>)}
      {section && !section.data ? <p className="col-span-full text-sm text-slate-500">{section.error ? `The first refresh failed: ${section.error}` : "Waiting for the first refresh. It runs within a few minutes of a deploy."}</p> : null}
    </div>;
  }
  const days = data.daily.filter((day) => day.date >= CONTROL_CENTER_TREND_START);
  const series = (value: (day: (typeof days)[number]) => number | null) => days.map((day) => ({ date: day.date, value: value(day) }));
  const failurePoints = change(Math.round((data.failures.failureRate ?? 0) * 1000), Math.round((data.failures.previousFailureRate ?? 0) * 1000));
  return <section id="admin-control-center-pulse" aria-label="Pulse" className="border-b border-slate-200">
    <dl className="grid grid-cols-1 divide-slate-200 sm:grid-cols-2 xl:grid-cols-5 xl:divide-x" data-testid="admin-control-center-kpis">
      <Kpi testId="kpi-task-users" label="People who ran a task" value={count(data.taskUsers.weekly)} badge={<ChangeBadge value={change(data.taskUsers.weekly, data.taskUsers.previousWeekly)} />}
        detail={`${count(data.taskUsers.daily)} today · ${count(data.taskUsers.monthly)} in 30 days · ${percent(data.taskUsers.dailyOverMonthly)} daily of monthly`}
        spark={<Sparkline label={`People who ran a task each day, ${days.length} days`} points={series((day) => day.taskUsers)} format={count} />} />
      <Kpi testId="kpi-tasks" label="Tasks per weekday" value={count(data.tasks.perWeekday)} badge={<ChangeBadge value={change(data.tasks.weekly, data.tasks.previousWeekly)} />}
        detail={`${decimal(data.tasks.perActiveUser)} per active person · ${count(data.tasks.weekly)} in 7 days`}
        spark={<Sparkline label={`Tasks started each day, ${days.length} days`} points={series((day) => day.started)} format={count} />} />
      <Kpi testId="kpi-failures" label="Task failure rate" value={percent(data.failures.failureRate, 1)} badge={data.failures.previousFailureRate === null ? null : <ChangeBadge value={failurePoints} lowerIsBetter />}
        detail={`${percent(data.failures.abandonedRate, 1)} abandoned · ${count(data.failures.failed)} failed in 7 days`}
        spark={<Sparkline label={`Daily task failure rate, ${days.length} days`} points={series((day) => day.started ? day.failed / day.started : null)} format={(value) => percent(value, 1)} />} />
      <Kpi testId="kpi-teams" label="Active team organizations" value={count(data.teamOrganizations.active)} badge={<ChangeBadge value={change(data.teamOrganizations.active, data.teamOrganizations.previous)} />}
        detail="2+ people who ran a task in 7 days" spark={null} />
      <Kpi testId="kpi-signups" label="New users" value={count(data.signups.weekly)} badge={<ChangeBadge value={change(data.signups.weekly, data.signups.previousWeekly)} />}
        detail={`${percent(data.signups.workEmailShare)} with a work email · 7 days`}
        spark={<Sparkline label={`Sign-ups each day, ${days.length} days`} points={series((day) => day.signups)} format={count} />} />
    </dl>
    <Freshness section={section} now={now} className="pb-3" />
  </section>;
}

function Freshness({ section, now, className = "" }: { section: Pick<SectionState<unknown>, "computedAt" | "stale">; now: number; className?: string }) {
  return <p className={`text-xs text-slate-500 ${className}`}>
    {relativeTime(section.computedAt, now)}{section.stale && section.computedAt ? <span className="text-amber-800"> · stale</span> : null}
  </p>;
}

function Group({ title }: { title: string }) {
  return <h2 className="pt-4 text-sm font-semibold text-slate-950 lg:col-span-12">{title}</h2>;
}

type SectionState<T> = Omit<ControlCenterSection<ControlCenterSectionKey>, "data"> & { data: T | null };

function Panel<T>({ title, caption, span, section, now, testId, notes = [], children }: {
  title: string; caption: string; span: string; section: SectionState<T> | undefined; now: number; testId: string; notes?: string[];
  children: (data: T) => ReactNode;
}) {
  const data = section?.data ?? null;
  return <section id={`admin-control-center-${testId}`} data-testid={`admin-control-center-${testId}`} aria-label={title} className={`min-w-0 scroll-mt-20 ${span}`}>
    <details open className="group h-full rounded-lg border border-slate-200 bg-white">
      <summary className="flex cursor-pointer list-none items-start justify-between gap-3 px-4 py-3 focus-visible:outline-2 focus-visible:outline-slate-500 [&::-webkit-details-marker]:hidden">
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-slate-950">{title}</span>
          <span className="mt-0.5 block text-xs text-slate-500">{caption}</span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {section ? <Freshness section={section} now={now} /> : null}
          <ChevronRight size={16} strokeWidth={1.5} aria-hidden="true" className="text-slate-500 transition-transform duration-150 ease-out group-open:rotate-90 motion-reduce:transition-none" />
        </span>
      </summary>
      <div className="border-t border-slate-100 px-4 py-4">
        {!section ? <PanelSkeleton /> : data === null
          ? <Empty>{section.error ? `This section has not refreshed successfully yet: ${section.error}` : "Waiting for the first refresh. It runs within a few minutes of a deploy."}</Empty>
          : children(data)}
        {section?.error && data !== null ? <div className="mt-3 text-xs text-amber-800">
          <p>The last refresh failed, so this shows the snapshot from {section.computedAt ? new Date(section.computedAt).toLocaleString() : "earlier"}.</p>
          <details className="mt-1 text-slate-500"><summary className="w-fit cursor-pointer">Technical details</summary><code className="mt-1 block break-words font-mono text-[11px]">{section.error}</code></details>
        </div> : null}
        {data !== null && notes.length ? <ul className="mt-3 grid gap-1 text-xs text-amber-800">{notes.map((note) => <li key={note}>{note}</li>)}</ul> : null}
      </div>
    </details>
  </section>;
}

function PanelSkeleton() {
  return <div aria-busy="true" aria-label="Loading"><DenSkeleton className="h-3 w-1/3" /><DenSkeleton className="mt-4 h-44" /></div>;
}

function Chart({ height, children }: { height: string; children: ReactNode }) {
  return <Suspense fallback={<DenSkeleton className={height} />}>{children}</Suspense>;
}

function Empty({ children }: { children: ReactNode }) {
  return <p role="status" className="rounded-md bg-slate-50 px-4 py-3 text-sm text-slate-500">{children}</p>;
}

function Stats({ rows, columns = false }: { rows: { label: string; value: string; detail: string }[]; columns?: boolean }) {
  return <dl className={columns ? "grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4" : "divide-y divide-slate-100"}>
    {rows.map((row) => columns
      ? <div key={row.label} className="min-w-0"><dt className="text-xs text-slate-500">{row.label}</dt><dd className="mt-0.5 text-lg font-semibold tabular-nums text-slate-950">{row.value}</dd><dd className="text-xs text-slate-500">{row.detail}</dd></div>
      : <div key={row.label} className="flex items-baseline justify-between gap-4 py-2.5">
        <div className="min-w-0"><dt className="text-sm text-slate-700">{row.label}</dt><dd className="text-xs text-slate-500">{row.detail}</dd></div>
        <dd className="shrink-0 text-base font-semibold tabular-nums text-slate-950">{row.value}</dd>
      </div>)}
  </dl>;
}

function CohortTable({ cohorts }: { cohorts: NonNullable<ControlCenterSection<"lifecycle">["data"]>["cohorts"] }) {
  const offsets = Math.max(1, ...cohorts.map((cohort) => cohort.retention.length));
  return <div className="overflow-x-auto" role="region" aria-label="Weekly cohort retention table" tabIndex={0}>
    <table className="w-full min-w-[420px] border-separate border-spacing-0.5 text-xs tabular-nums">
      <thead><tr className="text-slate-500"><th scope="col" className="pb-1 pr-2 text-left font-medium">Signup week</th><th scope="col" className="pb-1 pr-2 text-right font-medium">People</th>
        {Array.from({ length: offsets }, (_, offset) => <th key={offset} scope="col" className="pb-1 text-center font-medium">Week {offset}</th>)}</tr></thead>
      <tbody>{cohorts.map((cohort) => <tr key={cohort.week}>
        <th scope="row" className="whitespace-nowrap pr-2 text-left font-normal text-slate-700">{weekLabel(cohort.week)}</th>
        <td className="pr-2 text-right text-slate-700">{count(cohort.signups)}</td>
        {cohort.retention.length === 0 ? <td colSpan={Math.max(1, offsets)} className="px-2 py-1.5 text-slate-500">Too recent</td> : Array.from({ length: offsets }, (_, offset) => {
          const cell = cohort.retention[offset];
          if (!cell) return <td key={offset} />;
          const rate = cell.rate ?? 0;
          const label = `${weekLabel(cohort.week)} cohort, week ${offset}: ${percent(cell.rate, 1)} (${count(cell.users)} of ${count(cohort.signups)})`;
          return <td key={offset} title={label} aria-label={label} className={`rounded px-2 py-1.5 text-center ${rate >= 0.45 ? "text-white" : "text-slate-800"}`}
            style={{ backgroundColor: `color-mix(in srgb, ${primary} ${Math.round(8 + rate * 92)}%, transparent)` }}>{percent(cell.rate)}</td>;
        })}
      </tr>)}</tbody>
    </table>
  </div>;
}

type Connector = NonNullable<ControlCenterSection<"sharing">["data"]>["connectors"][number];
function ConnectorTable({ connectors }: { connectors: Connector[] }) {
  const most = Math.max(1, ...connectors.map((connector) => connector.people));
  return <table className="w-full text-xs tabular-nums" aria-label="Top connectors by people, with error rates">
    <thead><tr className="text-left text-slate-500"><th scope="col" className="pb-2 font-medium">Connection</th><th scope="col" className="pb-2 font-medium">People</th><th scope="col" className="pb-2 text-right font-medium">Errors</th></tr></thead>
    <tbody className="divide-y divide-slate-100">{connectors.map((connector) => {
      const high = connector.calls >= CONNECTOR_MIN_CALLS && (connector.errorRate ?? 0) > CONNECTOR_ERROR_THRESHOLD;
      return <tr key={connector.name} title={`${connector.name}: ${count(connector.people)} people, ${count(connector.calls)} calls, ${count(connector.errors)} errors`}>
        <td className="max-w-32 truncate py-2 pr-2 text-slate-800">{connector.name}</td>
        <td className="w-1/3 py-2 pr-3"><div className="flex items-center gap-2"><span aria-hidden="true" className="h-2 rounded-sm" style={{ width: `${Math.max(4, (connector.people / most) * 100)}%`, backgroundColor: primary }} /><span className="text-slate-700">{count(connector.people)}</span></div></td>
        <td className={`py-2 text-right ${high ? "font-medium text-rose-700" : "text-slate-600"}`}>{percent(connector.errorRate, 1)}</td>
      </tr>;
    })}</tbody>
  </table>;
}

type SeatRow = NonNullable<ControlCenterSection<"revenue">["data"]>["atRisk"][number];
function SeatTable({ rows }: { rows: SeatRow[] }) {
  const columns: DenTableColumn<SeatRow>[] = [
    { key: "organization", header: "Organization", render: (row) => <Link href={`/admin/organizations/${encodeURIComponent(row.organizationId)}/insights`} prefetch={false} className="font-medium text-slate-950 hover:underline">{row.name}</Link> },
    { key: "seats", header: "Paid seats", align: "right", render: (row) => count(row.seats) },
    { key: "active", header: "Active (7 days)", align: "right", render: (row) => count(row.activeMembers) },
    { key: "usage", header: "Seat usage", align: "right", render: (row) => <span className={(row.seatUsage ?? 0) < 0.3 ? "font-medium text-rose-700" : "text-slate-700"}>{percent(row.seatUsage)}</span> },
  ];
  return <DenTable columns={columns} rows={rows} getRowKey={(row) => row.organizationId} density="compact" emptyLabel="No paid seat plans yet." />;
}

type AccountRow = NonNullable<ControlCenterSection<"accounts">["data"]>["rows"][number];
const PLAN_LABEL = { free: "Free", team: "Team", enterprise: "Enterprise" } as const;
function AccountsTable({ rows }: { rows: AccountRow[] }) {
  const columns: DenTableColumn<AccountRow>[] = [
    { key: "organization", header: "Organization", render: (row) => <Link href={`/admin/organizations/${encodeURIComponent(row.organizationId)}/insights`} prefetch={false} className="font-medium text-slate-950 hover:underline">{row.name}</Link> },
    { key: "members", header: "Members", align: "right", render: (row) => count(row.members) },
    { key: "active", header: "Active (7 days)", align: "right", render: (row) => count(row.active7d) },
    { key: "tasks", header: "Tasks (7 days)", align: "right", render: (row) => count(row.tasks7d) },
    { key: "plan", header: "Plan", render: (row) => <span className="text-slate-700">{PLAN_LABEL[row.plan]}{row.paying ? " · paid" : ""}</span> },
    { key: "seats", header: "Seat usage", align: "right", render: (row) => row.seats === null ? <span className="text-slate-500">—</span> : `${percent(row.seatUsage)} of ${count(row.seats)}` },
  ];
  return <DenTable columns={columns} rows={rows} getRowKey={(row) => row.organizationId} density="compact" emptyLabel="No team organizations yet." />;
}
