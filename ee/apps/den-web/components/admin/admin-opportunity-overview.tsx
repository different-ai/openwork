"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight, ArrowRight, Minus, RefreshCw } from "lucide-react";
import { OPPORTUNITY_KINDS, adminOpportunityOverviewSchema, type AdminOpportunityOverview as Overview, type OpportunityItem } from "@openwork/types/den/admin-organization";
import { DenButton, buttonVariants } from "../../app/(den)/_components/ui/button";
import { AdminAccessScreen } from "./admin-access-screen";
import { OpportunityAccountPanel } from "./admin-opportunity-account";
import { ADOPTION_LABEL, KIND, PriorityBadge, STAGE_LABEL, shortDate } from "./admin-opportunity-labels";
import { AdminOpportunityNav } from "./admin-opportunity-nav";
import { requestAdmin, withStoredBearer, type AdminResult } from "./admin-request";
import { useAdminSessionCookie } from "./admin-shell";

const count = (value: number) => new Intl.NumberFormat().format(value);
const date = shortDate;
const orgHref = (id: string) => `/admin/organizations/${encodeURIComponent(id)}/insights`;
const linkStyle = "flex min-w-0 items-center justify-between gap-3 border-b border-[var(--dls-border)] py-3 last:border-0 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2";
// Suggested starting points, not a configured quota. Shown with that label wherever they appear.
const SUGGESTED_TARGETS = { reviewed: 10, outreach: 5 };
const STALE_AFTER_MS = 15 * 60_000;

function Trend({ current, previous }: { current: number; previous: number }) {
  const delta = current - previous;
  const Icon = delta > 0 ? ArrowUpRight : delta < 0 ? ArrowDownRight : Minus;
  return <span className={`inline-flex items-center gap-1 text-xs ${delta < 0 ? "text-[var(--ow-warning)]" : delta > 0 ? "text-[var(--ow-success)]" : "text-[var(--dls-text-secondary)]"}`}>
    <Icon size={16} strokeWidth={1.5} aria-hidden="true" />
    {delta === 0 ? "Unchanged" : `${delta > 0 ? "+" : "−"}${count(Math.abs(delta))}`} vs {count(previous)} last week
  </span>;
}

function Panel({ title, href, action, children, className = "" }: { title: string; href?: string; action?: string; children: ReactNode; className?: string }) {
  return <section aria-label={title} className={`mb-4 min-w-0 break-inside-avoid rounded-lg border border-[var(--dls-border)] bg-[var(--dls-surface)] p-4 ${className}`}>
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-sm font-semibold">{title}</h2>
      {href && action ? <Link href={href} prefetch={false} className={buttonVariants({ variant: "ghost", size: "xs" })}>{action}<ArrowRight size={16} strokeWidth={1.5} aria-hidden="true" className="ml-1" /></Link> : null}
    </div>
    {children}
  </section>;
}

function ActivityList({ rows, falling }: { rows: Overview["risingActivity"]; falling?: boolean }) {
  return rows.length ? <ul>{rows.map(row => <li key={row.id}>
    <Link href={orgHref(row.id)} prefetch={false} className={linkStyle}>
      <span className="min-w-0 truncate font-medium">{row.name}</span>
      <span className="shrink-0 text-right tabular-nums"><span className="block">{count(row.current)} active users</span><Trend current={row.current} previous={row.previous} /></span>
    </Link>
  </li>)}</ul> : <p className="py-5 text-sm text-[var(--dls-text-secondary)]">{falling ? "No teams have fewer observed active users than the same period last week." : "No teams have more observed active users yet this week."}</p>;
}

function Meter({ label, value, target, note }: { label: string; value: number; target?: number; note?: string }) {
  return <div className="min-w-0">
    <dt className="text-xs text-[var(--dls-text-secondary)]">{label}</dt>
    <dd className="mt-1 text-lg font-semibold tabular-nums">{count(value)}{target ? <span className="text-sm font-normal text-[var(--dls-text-secondary)]"> of {target}</span> : null}</dd>
    {target ? <dd aria-hidden="true" className="mt-1 h-1 rounded-full bg-[var(--dls-hover)]"><span className="block h-1 rounded-full bg-[var(--dls-accent)]" style={{ width: `${Math.min(100, value / target * 100)}%` }} /></dd> : null}
    {note ? <dd className="mt-1 text-xs text-[var(--dls-text-secondary)]">{note}</dd> : null}
  </div>;
}

function Progress({ progress }: { progress: Overview["progress"] }) {
  return <section aria-label="This week's progress" className="grid gap-4 border-b border-[var(--dls-border)] py-4 md:grid-cols-2">
    <div>
      <h2 className="mb-2 text-xs font-semibold">Your activity <span className="font-normal text-[var(--dls-text-secondary)]">· suggested targets, not a quota</span></h2>
      <dl className="grid grid-cols-3 gap-4">
        <Meter label="Accounts reviewed" value={progress.reviewed} target={SUGGESTED_TARGETS.reviewed} />
        <Meter label="Outreach" value={progress.outreach} target={SUGGESTED_TARGETS.outreach} />
        <Meter label="Follow-ups on time" value={progress.followUpsOnTime} note={`of ${count(progress.followUpsCompleted)} completed`} />
      </dl>
    </div>
    <div>
      <h2 className="mb-2 text-xs font-semibold">Outcomes <span className="font-normal text-[var(--dls-text-secondary)]">· not attributed to outreach</span></h2>
      <dl className="grid grid-cols-3 gap-4">
        <Meter label="Conversations" value={progress.conversations} note="Replies and meetings logged" />
        <Meter label="Confirmed opportunities" value={progress.confirmedExpansion + progress.confirmedCommercial} note={`${count(progress.confirmedExpansion)} expansion · ${count(progress.confirmedCommercial)} commercial`} />
        <Meter label="Accounts activating" value={progress.activationProgress} note="More observed active users" />
      </dl>
    </div>
  </section>;
}

function QueueRow({ item, selected, onSelect }: { item: OpportunityItem; selected: boolean; onSelect: () => void }) {
  const kind = KIND[item.kind];
  const latest = item.signals.map(signal => signal.at).filter((at): at is string => Boolean(at)).sort().at(-1);
  return <li>
    <button type="button" onClick={onSelect} aria-pressed={selected}
      className={`grid w-full gap-1 border-b border-[var(--dls-border)] px-3 py-3 text-left last:border-0 hover:bg-[var(--dls-hover)] focus-visible:outline-2 focus-visible:outline-offset-[-2px] ${selected ? "bg-[var(--dls-hover)] shadow-[inset_3px_0_0_var(--dls-accent)]" : ""}`}>
      <span className="flex min-w-0 flex-wrap items-center gap-2">
        <kind.icon size={16} strokeWidth={1.5} aria-hidden="true" className={kind.tone} />
        <span className="min-w-0 flex-1 truncate font-medium">{item.organizationName}</span>
        <PriorityBadge priority={item.priority} />
      </span>
      <span className="text-xs text-[var(--dls-text-secondary)]"><span className="font-medium text-[var(--dls-text-primary)]">{kind.label}</span> · {item.why}</span>
      <span className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span>Next: <span className="font-medium">{item.action.label}</span></span>
        <span className="text-[var(--dls-text-secondary)]">
          {item.followUp ? `${STAGE_LABEL[item.followUp.stage]}${item.followUp.ownerName ? ` · ${item.followUp.ownerName}` : ""}` : ADOPTION_LABEL[item.adoption.stage]}
          {latest ? ` · ${date(latest)}` : ""}
        </span>
      </span>
    </button>
  </li>;
}

function Queue({ data, selected, onSelect }: { data: Overview; selected: string | null; onSelect: (id: string) => void }) {
  const [filter, setFilter] = useState<OpportunityItem["kind"] | "all">("all");
  const rows = filter === "all" ? data.queue : data.queue.filter(item => item.kind === filter);
  const high = data.queue.filter(item => item.priority === "high").length;
  const { dueToday, overdue } = data.progress;
  return <section aria-label="Work queue" className="min-w-0 rounded-lg border border-[var(--dls-border)] bg-[var(--dls-surface)]">
    <header className="grid gap-3 border-b border-[var(--dls-border)] p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold">Work queue</h2>
        <p className="text-xs text-[var(--dls-text-secondary)]">{count(data.queue.length)} accounts · {count(high)} high priority
          {overdue ? <span className="text-[var(--ow-warning)]"> · {count(overdue)} overdue</span> : null}{dueToday ? ` · ${count(dueToday)} due today` : ""}</p>
      </div>
      <div role="group" aria-label="Filter by opportunity" className="flex flex-wrap gap-2">
        {(["all", ...OPPORTUNITY_KINDS] as const).map(kind => {
          const total = kind === "all" ? data.queue.length : data.queue.filter(item => item.kind === kind).length;
          if (kind !== "all" && !total) return null;
          return <button key={kind} type="button" aria-pressed={filter === kind} onClick={() => setFilter(kind)}
            className={`rounded-full border px-3 py-1 text-xs ${filter === kind ? "border-[var(--dls-text-primary)] bg-[var(--dls-text-primary)] text-[var(--dls-surface)]" : "border-[var(--dls-border)] hover:bg-[var(--dls-hover)]"}`}>
            {kind === "all" ? "All" : KIND[kind].label} {count(total)}
          </button>;
        })}
      </div>
    </header>
    {rows.length ? <ul>{rows.map(item => <QueueRow key={item.organizationId} item={item} selected={item.organizationId === selected} onSelect={() => onSelect(item.organizationId)} />)}</ul>
      : <div className="p-6 text-sm"><p className="font-medium">Nothing needs attention right now.</p><p className="mt-1 text-[var(--dls-text-secondary)]">New signups, team growth and scheduled follow-ups appear here. <Link href="/admin/opportunities/adoption?days=30" prefetch={false} className="underline">Review adoption opportunities</Link></p></div>}
    {data.waiting.length ? <div className="border-t border-[var(--dls-border)] p-4">
      <h3 className="mb-2 text-xs font-semibold">Scheduled follow-ups</h3>
      <ul>{data.waiting.map(entry => <li key={entry.organizationId}>
        <button type="button" onClick={() => onSelect(entry.organizationId)} aria-pressed={entry.organizationId === selected} className="flex w-full items-baseline justify-between gap-3 py-2 text-left text-xs hover:underline">
          <span className="min-w-0 truncate"><span className="font-medium">{entry.organizationName}</span>{entry.followUp.nextAction ? ` · ${entry.followUp.nextAction}` : ""}</span>
          <span className="shrink-0 tabular-nums text-[var(--dls-text-secondary)]">{entry.followUp.nextFollowUpAt ? date(entry.followUp.nextFollowUpAt) : ""}{entry.followUp.ownerName ? ` · ${entry.followUp.ownerName}` : ""}</span>
        </button>
      </li>)}</ul>
    </div> : null}
    <details className="border-t border-[var(--dls-border)] p-4 text-xs text-[var(--dls-text-secondary)]">
      <summary className="cursor-pointer font-medium text-[var(--dls-text-primary)]">How priority works</summary>
      <ul className="mt-3 grid list-disc gap-2 pl-5">
        <li>High: a follow-up due today or overdue; a trial ending within 7 days or a plan set to end; a team at its seat limit; two or more teammates joining this week, or one joining while observed use rises.</li>
        <li>Medium: an account you marked ready for outreach; one teammate joining; observed active users rising to two or more; a trial ending within 14 days; nearing the seat limit; a new workspace with no observed use; observed use falling by half or more.</li>
        <li>Low: a new signup to welcome; a smaller drop in observed use; any account contacted in the last 14 days, so it is not contacted again too soon.</li>
        <li>Each account shows its strongest job: follow-up, commercial, expansion, check-in, getting started, then welcome. All of its signals stay listed.</li>
        <li>Telemetry can be missing or turned off. No observed use is not inactivity, and an email domain is not proof of employment.</li>
        {data.hidden.closed + data.hidden.dismissed ? <li>{count(data.hidden.dismissed)} dismissed and {count(data.hidden.closed)} closed accounts are hidden. Reopen one from its account panel.</li> : null}
      </ul>
    </details>
  </section>;
}

export function OpportunityOverviewContent({ data, selected, onSelect, onRecorded }: { data: Overview; selected: string | null; onSelect: (id: string) => void; onRecorded: () => void }) {
  const max = Math.max(1, ...data.daily.flatMap(day => [day.signups, day.joinedMembers]));
  return <>
    {/* The queue is the focal element; on phones it comes before progress. */}
    <div className="flex flex-col"><div className="order-last lg:order-first"><Progress progress={data.progress} /></div>
    <div className="grid items-start gap-4 py-5 lg:grid-cols-12">
      <div className="min-w-0 lg:col-span-7"><Queue data={data} selected={selected} onSelect={onSelect} /></div>
      <aside id="opportunity-account" aria-label="Selected account" className="min-w-0 rounded-lg border border-[var(--dls-border)] bg-[var(--dls-surface)] p-4 lg:sticky lg:top-4 lg:col-span-5 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto">
        {selected ? <OpportunityAccountPanel organizationId={selected} onRecorded={onRecorded} /> : <p className="text-sm text-[var(--dls-text-secondary)]">Choose an account to see its people, evidence and next step.</p>}
      </aside>
    </div></div>
    <dl className="grid grid-cols-2 gap-4 border-y border-[var(--dls-border)] py-4 xl:grid-cols-4" aria-label="This week's metrics">
      {[
        { label: "New signups", metric: data.signups, href: "#recent-signups" },
        { label: "Members joined", metric: data.joinedMembers, href: "#growing-teams" },
        { label: "Observed active users", metric: data.activeUsers, href: "#activity-changes" },
        { label: "Observed active teams", metric: data.activeOrganizations, href: "#activity-changes" },
      ].map(({ label, metric, href }) => <div key={label} className="min-w-0 py-2">
        <dt><a href={href} className="text-sm text-[var(--dls-text-secondary)] hover:underline">{label}</a></dt>
        <dd className="my-2 text-xl font-semibold tabular-nums">{count(metric.current)}</dd>
        <dd><Trend {...metric} /></dd>
      </div>)}
    </dl>
    <div className="gap-4 py-5 md:columns-2 xl:columns-3">
      <Panel title="Signup and team activity" href="/admin/users" action="View users">
        <div className="mb-4 flex flex-wrap gap-4 text-xs text-[var(--dls-text-secondary)]">
          <span className="flex items-center gap-2"><span className="h-2 w-2 rounded-sm bg-[var(--dls-accent)]" />Signups</span>
          <span className="flex items-center gap-2"><span className="h-2 w-2 rounded-sm bg-[var(--dls-text-secondary)]" />Members joined</span>
        </div>
        <div role="img" aria-label="Daily signup and joined-member counts, available in the daily breakdown" className="flex h-36 items-end gap-2 border-b border-[var(--dls-border)]">
          {data.daily.map(day => <div key={day.date} className="flex h-full min-w-0 flex-1 items-end justify-center gap-1" title={`${date(day.date)}: ${day.signups} signups, ${day.joinedMembers} members joined`}>
            <div className="w-3 rounded-t-sm bg-[var(--dls-accent)]" style={{ height: `${day.signups / max * 100}%` }} />
            <div className="w-3 rounded-t-sm bg-[var(--dls-text-secondary)]" style={{ height: `${day.joinedMembers / max * 100}%` }} />
          </div>)}
        </div>
        <div className="mt-2 flex gap-2 text-center text-xs text-[var(--dls-text-secondary)]">{data.daily.map(day => <span className="min-w-0 flex-1" key={day.date}>{new Date(`${day.date}T00:00:00Z`).toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" })}</span>)}</div>
        {data.daily.every(day => day.signups === 0 && day.joinedMembers === 0) ? <p className="mt-4 text-sm text-[var(--dls-text-secondary)]">No signups or member joins recorded yet this week.</p> : null}
        <details className="mt-4 text-xs"><summary className="cursor-pointer font-medium">Daily breakdown</summary>
          <table className="mt-3 w-full text-left tabular-nums"><caption className="sr-only">Week-to-date counts by UTC day</caption><thead><tr><th scope="col">Date (UTC)</th><th scope="col">Signups</th><th scope="col">Members joined</th></tr></thead>
            <tbody>{data.daily.map(day => <tr key={day.date}><th scope="row" className="py-2 font-normal">{date(day.date)}</th><td>{count(day.signups)}</td><td>{count(day.joinedMembers)}</td></tr>)}</tbody></table>
        </details>
      </Panel>
      <div id="activity-changes">
        <Panel title="Activity picking up" href="/admin/opportunities/adoption?days=7&minMembers=1&sort=active" action="Explore adoption"><ActivityList rows={data.risingActivity} /></Panel>
        <Panel title="Activity to check" href="/admin/organizations" action="View teams">
          <p className="mb-2 text-xs text-[var(--ow-warning)]">Fewer observed active users · Same elapsed period last week</p>
          <ActivityList rows={data.fallingActivity} falling />
        </Panel>
      </div>
      <div id="recent-signups"><Panel title="Recent signups" href="/admin/users" action="View all users">
        {data.recentSignups.length ? <ul>{data.recentSignups.map(user => <li key={user.id}><Link href={`/admin/users?search=${encodeURIComponent(user.id)}`} prefetch={false} className={linkStyle}>
          <span className="min-w-0 truncate font-medium">{user.name}</span><time className="shrink-0 text-right text-xs text-[var(--dls-text-secondary)]" dateTime={user.createdAt} title={new Date(user.createdAt).toLocaleString()}>{date(user.createdAt)}<span className="mt-1 block">{new Date(user.createdAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", timeZone: "UTC" })} UTC</span></time>
        </Link></li>)}</ul> : <p className="py-5 text-sm text-[var(--dls-text-secondary)]">No new signups yet this week. <Link href="/admin/users" prefetch={false} className="underline">View existing users</Link></p>}
      </Panel></div>
      <div id="growing-teams"><Panel title="Teams adding people" href="/admin/organizations" action="View all teams">
        {data.growingTeams.length ? <ul>{data.growingTeams.map(team => <li key={team.id}><Link href={`/admin/organizations/${encodeURIComponent(team.id)}`} prefetch={false} className={linkStyle}>
          <span className="min-w-0 truncate font-medium">{team.name}</span><span className="shrink-0 text-xs tabular-nums">+{count(team.joinedMembers)} joined</span>
        </Link></li>)}</ul> : <p className="py-5 text-sm text-[var(--dls-text-secondary)]">No additional team members recorded this week.</p>}
      </Panel></div>
      <Panel title="Operational checks" href="/admin/services" action="Check services">
        <Link href="/admin/services" prefetch={false} className={linkStyle}>Service health<ArrowRight size={16} strokeWidth={1.5} aria-hidden="true" /></Link>
        <Link href="/admin/free-auto" prefetch={false} className={linkStyle}>Free Auto usage<ArrowRight size={16} strokeWidth={1.5} aria-hidden="true" /></Link>
        <Link href="/admin/opportunities/adoption?days=7" prefetch={false} className={linkStyle}>Review adoption opportunities<ArrowRight size={16} strokeWidth={1.5} aria-hidden="true" /></Link>
      </Panel>
    </div>
    <details className="border-t border-[var(--dls-border)] py-4 text-xs text-[var(--dls-text-secondary)]">
      <summary className="cursor-pointer font-medium">Counting and coverage</summary>
      <ul className="mt-3 grid list-disc gap-2 pl-5">
        <li>Monday to now in UTC, compared with the same elapsed period last week. Today is partial. Follow-up dates are UTC days.</li>
        <li>Signups count registered accounts, excluding setup identities. Members joined counts current human memberships, including initial organization membership; one person can join several teams. Invitations that have not been accepted are not members.</li>
        <li>Active users require organization-scoped app telemetry after joining. Removed members and setup identities are excluded. A person active in several teams counts once in the platform total.</li>
        <li>Less observed activity does not establish inactivity: telemetry can be missing or disabled. Skills and connections that are set up are configuration, not usage. These signals do not measure service uptime.</li>
        <li>Commercial signals come from recorded subscriptions and seat limits only. Confirmed opportunities and conversations are what admins record; activation counts are observed and not attributed to outreach.</li>
        <li>Follow-up records are internal to platform admins. They are not shown to the organization or written to its audit log, and nothing on this page sends a message.</li>
        <li>Signal lists show at most eight records each and the queue at most forty accounts. Metrics cover the full result.</li>
      </ul>
    </details>
  </>;
}

function Freshness({ data, refreshing }: { data: Overview; refreshing: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 60_000); return () => window.clearInterval(timer); }, []);
  const stale = now - Date.parse(data.generatedAt) > STALE_AFTER_MS;
  return <div className="flex flex-wrap items-center justify-between gap-2 py-4 text-xs text-[var(--dls-text-secondary)]">
    <p>{date(data.from)} – {date(data.to)} · Week to date · Times in {data.timeZone}</p>
    <p className={stale ? "text-[var(--ow-warning)]" : undefined}>
      {refreshing ? "Refreshing · " : ""}{stale ? "Snapshot from " : "Updated "}<time dateTime={data.generatedAt}>{new Date(data.generatedAt).toLocaleString()}</time>{stale ? ". Refresh for current signals." : ""}
    </p>
  </div>;
}

function readSelected() {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("account");
}

export function AdminOpportunityOverview() {
  const hasSessionCookie = useAdminSessionCookie();
  const [state, setState] = useState<AdminResult<Overview> | { access: "checking" }>({ access: "checking" });
  const [attempt, setAttempt] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => { setSelected(readSelected()); }, []);
  useEffect(() => {
    if (!hasSessionCookie && !withStoredBearer({}).Authorization) { setState({ access: "signed-out", message: "" }); return; }
    const controller = new AbortController();
    setRefreshing(true);
    setError(null);
    void requestAdmin("/v1/admin/opportunities/overview", payload => {
      const parsed = adminOpportunityOverviewSchema.safeParse(payload);
      return parsed.success ? parsed.data : null;
    }, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      if (result.access === "error") setError(result.message);
      setState(previous => result.access === "error" && previous.access === "ready" ? previous : result);
    }).catch((reason: unknown) => {
      if (controller.signal.aborted) return;
      const message = reason instanceof Error ? reason.message : "Could not load this week's activity.";
      setError(message);
      setState(previous => previous.access === "ready" ? previous : { access: "error", message });
    }).finally(() => { if (!controller.signal.aborted) setRefreshing(false); });
    return () => controller.abort();
  }, [hasSessionCookie, attempt]);
  function select(id: string) {
    setSelected(id);
    const next = new URLSearchParams(window.location.search);
    next.set("account", id);
    window.history.replaceState(null, "", `/admin/opportunities?${next}`);
    if (window.matchMedia("(max-width: 1023px)").matches) document.getElementById("opportunity-account")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  if (state.access !== "ready" && state.access !== "checking") return <AdminAccessScreen state={state.access} message={state.message} onRetry={() => setAttempt(value => value + 1)} />;
  const current = state.access === "ready" ? selected ?? state.data.queue[0]?.organizationId ?? null : null;
  return <section data-testid="admin-opportunity-overview" className="min-w-0 text-[var(--dls-text-primary)]">
    <header className="flex flex-wrap items-center justify-between gap-3 py-5"><h1 className="text-lg font-semibold">Opportunities</h1>
      <DenButton size="sm" variant="secondary" disabled={refreshing} onClick={() => setAttempt(value => value + 1)}><RefreshCw size={16} strokeWidth={1.5} aria-hidden="true" />Refresh</DenButton>
    </header>
    <AdminOpportunityNav active="overview" />
    {error && state.access === "ready" ? <p role="alert" className="py-3 text-sm text-[var(--ow-warning)]">Could not refresh. Showing the snapshot from {new Date(state.data.generatedAt).toLocaleString()}. {error}</p> : null}
    <div aria-busy={refreshing}>{state.access === "ready" ? <>
      <Freshness data={state.data} refreshing={refreshing} />
      <OpportunityOverviewContent data={state.data} selected={current} onSelect={select} onRecorded={() => setAttempt(value => value + 1)} />
    </> : <div aria-label="Checking weekly activity" className="grid gap-4 py-5 lg:grid-cols-12">
      <div className="h-20 rounded-lg bg-[var(--dls-hover)] lg:col-span-12" />
      <div className="grid gap-2 lg:col-span-7">{[0, 1, 2, 3, 4].map(value => <div key={value} className="h-16 rounded-lg bg-[var(--dls-hover)]" />)}</div>
      <div className="h-96 rounded-lg bg-[var(--dls-hover)] lg:col-span-5" />
    </div>}</div>
  </section>;
}
