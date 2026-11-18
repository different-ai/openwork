"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, ChevronUp, Copy, Mail, RefreshCw } from "lucide-react";
import { OUTREACH_PLAYS, adminOutreachSchema, type AdminOutreach, type OutreachItem, type OutreachPlay } from "@openwork/types/den/admin-organization";
import { DenBadge } from "../../app/(den)/_components/ui/badge";
import { DenButton, buttonVariants } from "../../app/(den)/_components/ui/button";
import { DenInput } from "../../app/(den)/_components/ui/input";
import { DenTextarea } from "../../app/(den)/_components/ui/textarea";
import { AdminAccessScreen } from "./admin-access-screen";
import { outreachDraft } from "./admin-opportunity-draft";
import { PLAY, shortDate } from "./admin-opportunity-labels";
import { AdminOpportunityNav } from "./admin-opportunity-nav";
import { requestAdmin, sendAdmin, withStoredBearer, type AdminResult } from "./admin-request";
import { useAdminSessionCookie } from "./admin-shell";

type Person = NonNullable<OutreachItem["contact"]>;
type Outcome = "contacted" | "replied" | "dismissed" | "reopened";
const FOLLOW_UP_DAYS = 7;
const count = (value: number) => new Intl.NumberFormat().format(value);
const personName = (person: Person) => person.name?.trim() || person.email;
const planLabel = (billing: OutreachItem["billing"]) => `${billing.plan === "enterprise" ? "Enterprise" : billing.plan === "team" ? "Team" : "Free"}${billing.modelsAddOn ? " + Models" : ""}${billing.paying ? " · Paying" : ""}`;

/** One line per row, tab separated, so the list pastes into a sheet. */
export function outreachRowsAsText(items: OutreachItem[]) {
  const cell = (value: string) => value.replace(/[\t\n\r]+/g, " ");
  return [
    ["Account", "Company", "Reason", "Contact", "Email", "Role", "Plan", "People active"].join("\t"),
    ...items.map(item => [
      item.organizationName, item.company ?? "", `${PLAY[item.play].label}: ${item.reason}`,
      item.contact ? personName(item.contact) : "", item.contact?.email ?? "", item.contact?.role ?? "", planLabel(item.billing), String(item.people.active),
    ].map(cell).join("\t")),
  ].join("\n");
}

function CopyButton({ text, label, done = "Copied" }: { text: string; label: string; done?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (!copied) return; const timer = window.setTimeout(() => setCopied(false), 2_000); return () => window.clearTimeout(timer); }, [copied]);
  return <DenButton size="sm" variant="secondary" onClick={() => { void navigator.clipboard?.writeText(text).then(() => setCopied(true)); }}>
    {copied ? <Check size={16} strokeWidth={1.5} aria-hidden="true" /> : <Copy size={16} strokeWidth={1.5} aria-hidden="true" />}{copied ? done : label}
  </DenButton>;
}

function Draft({ item, contact }: { item: OutreachItem; contact: Person | null }) {
  const initial = useMemo(() => outreachDraft(item, contact?.name ?? null), [item, contact?.name]);
  const [body, setBody] = useState(initial.body);
  useEffect(() => { setBody(initial.body); }, [initial.body]);
  const mailto = contact ? `mailto:${encodeURIComponent(contact.email)}?${new URLSearchParams({ subject: initial.subject, body }).toString().replace(/\+/g, "%20")}` : null;
  return <div className="grid gap-2">
    <p className="text-xs text-[var(--dls-text-secondary)]">Draft · not sent · Subject: <span className="text-[var(--dls-text-primary)]">{initial.subject}</span></p>
    <DenTextarea aria-label={`Draft for ${item.organizationName}`} rows={8} value={body} onChange={event => setBody(event.target.value)} />
    <div className="flex flex-wrap gap-2">
      <CopyButton text={body} label="Copy draft" />
      {mailto ? <a href={mailto} className={buttonVariants({ variant: "secondary", size: "sm" })}><Mail size={16} strokeWidth={1.5} aria-hidden="true" className="mr-1" />Open in email app</a> : null}
    </div>
  </div>;
}

function Row({ item, busy, onOutcome }: { item: OutreachItem; busy: boolean; onOutcome: (outcome: Outcome, contact: Person | null, note: string) => void }) {
  const play = PLAY[item.play];
  const [open, setOpen] = useState(false);
  const [contactId, setContactId] = useState(item.contact?.userId ?? "");
  const [note, setNote] = useState("");
  const everyone = [...(item.contact ? [item.contact] : []), ...item.others];
  const contact = everyone.find(person => person.userId === contactId) ?? item.contact;
  const orgHref = `/admin/organizations/${encodeURIComponent(item.organizationId)}`;
  return <li data-testid={`outreach-row-${item.organizationId}`} className="grid gap-2 border-b border-[var(--dls-border)] px-4 py-4 last:border-0">
    <div className="flex flex-wrap items-center gap-2">
      <span className={`flex items-center gap-1 text-xs font-medium ${play.tone}`}><play.icon size={16} strokeWidth={1.5} aria-hidden="true" />{play.label}</span>
      <Link href={orgHref} prefetch={false} className="min-w-0 truncate font-medium hover:underline">{item.organizationName}</Link>
      {item.company ? <span className="text-xs text-[var(--dls-text-secondary)]">{item.company}</span> : null}
      <span className="ml-auto flex flex-wrap items-center gap-2 text-xs text-[var(--dls-text-secondary)]">
        <span>{item.people.active === 0 && item.lastActiveAt ? `Last task ${shortDate(item.lastActiveAt)}` : `${count(item.people.active)} of ${count(item.people.members)} active`}</span>
        <DenBadge size="sm" tone={item.billing.paying ? "success" : "neutral"}>{planLabel(item.billing)}</DenBadge>
      </span>
    </div>
    <p className="text-sm">{item.reason}</p>
    {item.also.length ? <p className="text-xs text-[var(--dls-text-secondary)]">Also: {item.also.join(" · ")}</p> : null}
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
      {contact ? <>
        <span className="min-w-0"><span className="font-medium">{personName(contact)}</span> <span className="text-xs text-[var(--dls-text-secondary)]">{contact.role}{contact.activeDays ? ` · active ${contact.activeDays} ${contact.activeDays === 1 ? "day" : "days"}` : ""}</span></span>
        <span className="min-w-0 truncate text-[var(--dls-text-secondary)]">{contact.email}</span>
      </> : <span className="text-[var(--dls-text-secondary)]">No member with an email to write to. <Link href={orgHref} prefetch={false} className="underline">Open the organization</Link></span>}
    </div>
    <div className="flex flex-wrap items-center gap-2">
      {contact ? <CopyButton text={contact.email} label="Copy email" /> : null}
      <DenButton size="sm" variant="secondary" aria-expanded={open} onClick={() => setOpen(value => !value)}>
        {open ? <ChevronUp size={16} strokeWidth={1.5} aria-hidden="true" /> : <ChevronDown size={16} strokeWidth={1.5} aria-hidden="true" />}Draft
      </DenButton>
      <DenButton size="sm" disabled={busy} onClick={() => onOutcome("contacted", contact, note)}>{item.play === "follow_up" ? "Followed up" : "Mark contacted"}</DenButton>
      {item.followUp?.lastContactedAt ? <DenButton size="sm" variant="secondary" disabled={busy} onClick={() => onOutcome("replied", contact, note)}>Got a reply</DenButton> : null}
      <DenButton size="sm" variant="ghost" disabled={busy} onClick={() => onOutcome("dismissed", null, note)}>Not a fit</DenButton>
    </div>
    {open ? <div className="grid gap-4 rounded-lg border border-[var(--dls-border)] bg-[var(--dls-surface)] p-4 lg:grid-cols-5">
      <div className="lg:col-span-3"><Draft item={item} contact={contact} /></div>
      <div className="grid content-start gap-3 text-xs lg:col-span-2">
        <p className="text-[var(--dls-text-secondary)]">{play.ask}</p>
        {everyone.length > 1 ? <fieldset className="grid gap-1">
          <legend className="mb-1 font-semibold text-[var(--dls-text-secondary)]">Write to</legend>
          {everyone.map(person => <label key={person.userId} className="flex min-w-0 cursor-pointer items-start gap-2 rounded-md px-2 py-1 hover:bg-[var(--dls-hover)]">
            <input type="radio" name={`contact-${item.organizationId}`} className="mt-1" checked={person.userId === contact?.userId} onChange={() => setContactId(person.userId)} />
            <span className="min-w-0"><span className="font-medium">{personName(person)}</span> <span className="text-[var(--dls-text-secondary)]">{person.role}{person.activeDays ? ` · active ${person.activeDays}d` : ""}</span><span className="block truncate text-[var(--dls-text-secondary)]">{person.email}</span></span>
          </label>)}
        </fieldset> : null}
        <label className="grid gap-1 text-[var(--dls-text-secondary)]">Note for the team (optional)
          <DenInput aria-label="Note for the team" maxLength={500} value={note} onChange={event => setNote(event.target.value)} placeholder="Saved with the button you press" />
        </label>
        {item.followUp?.lastActionAt ? <p className="text-[var(--dls-text-secondary)]">Last step {shortDate(item.followUp.lastActionAt)}{item.followUp.ownerName ? ` · ${item.followUp.ownerName}` : ""}</p> : null}
      </div>
    </div> : null}
  </li>;
}

const WIN_BACK: OutreachPlay[] = ["shrinking", "quiet_paying", "lapsed_failed", "lapsed_limit", "lapsed"];

/** What is waiting to be won back, and what happened to the accounts already contacted. */
function Results({ data }: { data: AdminOutreach }) {
  const winBack = WIN_BACK.reduce((sum, play) => sum + data.totals[play], 0);
  const { results } = data;
  const figure = "text-lg font-semibold tabular-nums";
  const label = "text-xs text-[var(--dls-text-secondary)]";
  return <dl aria-label="Reactivation" className="grid grid-cols-2 gap-4 border-b border-[var(--dls-border)] py-4 md:grid-cols-4">
    <div><dt className={label}>To win back</dt><dd className={figure}>{count(winBack)}</dd><dd className={label}>stopped or slowing down</dd></div>
    <div><dt className={label}>Contacted, last {results.days} days</dt><dd className={figure}>{count(results.contacted)}</dd><dd className={label}>{results.contacted ? `${count(data.waiting.length)} waiting on a reply` : "Mark accounts contacted to track them"}</dd></div>
    <div><dt className={label}>Replied</dt><dd className={figure}>{count(results.replied)}</dd><dd className={label}>{results.contacted ? `of ${count(results.contacted)} contacted` : "none recorded yet"}</dd></div>
    <div><dt className={label}>Active again</dt><dd className={figure}>{count(results.cameBack)}</dd><dd className={label}>{results.quietWhenContacted ? `of ${count(results.quietWhenContacted)} that were quiet when contacted` : "no quiet account contacted yet"}</dd></div>
  </dl>;
}

export function OutreachList({ data, busy, onOutcome }: { data: AdminOutreach; busy: string | null; onOutcome: (organizationId: string, organizationName: string, outcome: Outcome, contact: Person | null, note: string) => void }) {
  const [filter, setFilter] = useState<OutreachPlay | "all">("all");
  const rows = filter === "all" ? data.items : data.items.filter(item => item.play === filter);
  const total = OUTREACH_PLAYS.reduce((sum, play) => sum + data.totals[play], 0);
  return <>
    <Results data={data} />
    <div className="flex flex-wrap items-center justify-between gap-3 py-4">
      <div role="group" aria-label="Filter by reason" className="flex flex-wrap gap-2">
        {(["all", ...OUTREACH_PLAYS] as const).map(play => {
          const matches = play === "all" ? total : data.totals[play];
          if (play !== "all" && !matches) return null;
          return <button key={play} type="button" aria-pressed={filter === play} onClick={() => setFilter(play)}
            className={`rounded-full border px-3 py-1 text-xs ${filter === play ? "border-[var(--dls-text-primary)] bg-[var(--dls-text-primary)] text-[var(--dls-surface)]" : "border-[var(--dls-border)] hover:bg-[var(--dls-hover)]"}`}>
            {play === "all" ? "All" : PLAY[play].label} {count(matches)}
          </button>;
        })}
      </div>
      {rows.length ? <CopyButton text={outreachRowsAsText(rows)} label={`Copy ${count(rows.length)} rows for a sheet`} /> : null}
    </div>
    {filter !== "all" ? <p className="pb-3 text-xs text-[var(--dls-text-secondary)]">{PLAY[filter].ask}{data.totals[filter] > rows.length ? ` Showing the top ${count(rows.length)} of ${count(data.totals[filter])}.` : ""}</p> : null}
    <section aria-label="Accounts to write to" className="min-w-0 rounded-lg border border-[var(--dls-border)] bg-[var(--dls-surface)]">
      {rows.length ? <ul>{rows.map(item => <Row key={`${item.organizationId}:${item.play}`} item={item} busy={busy === item.organizationId} onOutcome={(outcome, contact, note) => onOutcome(item.organizationId, item.organizationName, outcome, contact, note)} />)}</ul>
        : <div className="p-6 text-sm"><p className="font-medium">Nobody to write to right now.</p><p className="mt-1 text-[var(--dls-text-secondary)]">Accounts appear when a payment fails, a plan ends, a team forms without a plan, or someone runs out of free model use. <Link href="/admin/opportunities/adoption" prefetch={false} className="underline">Browse all active teams</Link></p></div>}
    </section>
    {data.waiting.length ? <section aria-label="Waiting on a reply" className="mt-6">
      <h2 className="mb-2 text-sm font-semibold">Waiting on a reply <span className="font-normal text-[var(--dls-text-secondary)]">· {count(data.waiting.length)}</span></h2>
      <ul className="rounded-lg border border-[var(--dls-border)] bg-[var(--dls-surface)]">{data.waiting.map(entry => <li key={entry.organizationId} className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--dls-border)] px-4 py-3 text-sm last:border-0">
        <span className="min-w-0"><Link href={`/admin/organizations/${encodeURIComponent(entry.organizationId)}`} prefetch={false} className="font-medium hover:underline">{entry.organizationName}</Link>
          <span className="block text-xs text-[var(--dls-text-secondary)]">Contacted {shortDate(entry.contactedAt)}{entry.ownerName ? ` by ${entry.ownerName}` : ""}{entry.followUpAt ? ` · back on the list ${shortDate(entry.followUpAt)}` : ""}</span>
          {entry.activeAgainAt ? <span className="mt-1 block text-xs text-[var(--ow-success)]">Running tasks again since {shortDate(entry.activeAgainAt)}</span> : null}</span>
        <span className="flex gap-2">
          <DenButton size="sm" variant="secondary" disabled={busy === entry.organizationId} onClick={() => onOutcome(entry.organizationId, entry.organizationName, "replied", null, "")}>Got a reply</DenButton>
          <DenButton size="sm" variant="ghost" disabled={busy === entry.organizationId} onClick={() => onOutcome(entry.organizationId, entry.organizationName, "dismissed", null, "")}>Close</DenButton>
        </span>
      </li>)}</ul>
    </section> : null}
    <details className="mt-6 border-t border-[var(--dls-border)] py-4 text-xs text-[var(--dls-text-secondary)]">
      <summary className="cursor-pointer font-medium">How this list is built</summary>
      <ul className="mt-3 grid max-w-3xl list-disc gap-2 pl-5">
        <li>Each account is listed once, under its strongest reason: a follow-up that is due, a failed payment, a plan ending or canceled in the last 30 days, a team without a plan, full seats, colleagues in separate workspaces, a shrinking team, the free model limit, a quiet paid plan, then accounts that went quiet.</li>
        <li>Went quiet means tasks on three or more days earlier in the last 60 days and none in the last {data.windowDays}. Left after failures means at least 30% of those tasks failed; left at the limit means the free model limit was reached in their last week. The most recently lapsed come first.</li>
        <li>Active again counts contacted accounts that were quiet for two weeks before the contact and ran a task afterwards. It shows what happened, not that the message caused it.</li>
        <li>Active means the person ran a task in the app in the last {data.windowDays} days. Telemetry can be turned off, so no tasks seen is not proof that nobody uses it.</li>
        <li>Same company means verified addresses on one domain that is not a personal email provider. A domain is not proof of employment; check before you mention colleagues.</li>
        <li>Mark contacted takes the account off the list for a week. It comes back once as a follow-up if no reply is recorded. Not a fit hides it{data.hidden ? `; ${count(data.hidden)} hidden now` : ""}.</li>
        <li>Nothing here sends a message. Notes and steps are internal and never shown to the organization.</li>
      </ul>
    </details>
  </>;
}

export function AdminOutreachPage() {
  const hasSessionCookie = useAdminSessionCookie();
  const [state, setState] = useState<AdminResult<AdminOutreach> | { access: "checking" }>({ access: "checking" });
  const [attempt, setAttempt] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string; undo?: { organizationId: string; organizationName: string } } | null>(null);
  useEffect(() => {
    if (!hasSessionCookie && !withStoredBearer({}).Authorization) { setState({ access: "signed-out", message: "" }); return; }
    const controller = new AbortController();
    setRefreshing(true);
    void requestAdmin("/v1/admin/opportunities/outreach", payload => {
      const parsed = adminOutreachSchema.safeParse(payload);
      return parsed.success ? parsed.data : null;
    }, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      if (result.access === "error") setNotice({ tone: "error", text: `Could not refresh. ${result.message}` });
      setState(previous => result.access === "error" && previous.access === "ready" ? previous : result);
    }).catch((reason: unknown) => {
      if (controller.signal.aborted) return;
      const message = reason instanceof Error ? reason.message : "Could not load the outreach list.";
      setState(previous => previous.access === "ready" ? previous : { access: "error", message });
    }).finally(() => { if (!controller.signal.aborted) setRefreshing(false); });
    return () => controller.abort();
  }, [hasSessionCookie, attempt]);

  async function record(organizationId: string, organizationName: string, outcome: Outcome, contact: Person | null, note: string) {
    setBusy(organizationId); setNotice(null);
    const followUpOn = outcome === "contacted" ? new Date(Date.now() + FOLLOW_UP_DAYS * 86_400_000).toISOString().slice(0, 10) : null;
    const result = await sendAdmin(`/v1/admin/opportunities/accounts/${encodeURIComponent(organizationId)}/actions`, "POST", {
      requestId: crypto.randomUUID(), kind: outcome, contactUserId: outcome === "contacted" || outcome === "replied" ? contact?.userId ?? null : null,
      note: note.trim() || null, nextAction: null, followUpOn, assignToMe: outcome === "contacted",
    }).catch((reason: unknown) => ({ ok: false as const, message: reason instanceof Error ? reason.message : "Could not save.", status: 0 }));
    setBusy(null);
    if (!result.ok) { setNotice({ tone: "error", text: `Not saved for ${organizationName}. ${result.message}` }); return; }
    const text = outcome === "contacted" ? `${organizationName} marked contacted. It comes back in ${FOLLOW_UP_DAYS} days if no reply is recorded.`
      : outcome === "replied" ? `Reply recorded for ${organizationName}.` : outcome === "dismissed" ? `${organizationName} hidden from the list.` : `${organizationName} is back on the list.`;
    setNotice({ tone: "ok", text, undo: outcome === "dismissed" ? { organizationId, organizationName } : undefined });
    setAttempt(value => value + 1);
  }

  if (state.access !== "ready" && state.access !== "checking") return <AdminAccessScreen state={state.access} message={state.message} onRetry={() => setAttempt(value => value + 1)} />;
  const data = state.access === "ready" ? state.data : null;
  return <section data-testid="admin-outreach" className="min-w-0 text-[var(--dls-text-primary)]">
    <header className="flex flex-wrap items-center justify-between gap-3 py-5">
      <div>
        <h1 className="text-lg font-semibold">Opportunities</h1>
        <p className="mt-1 text-xs text-[var(--dls-text-secondary)]">{data ? `${count(data.items.length)} accounts to write to · ${count(data.waiting.length)} waiting on a reply · updated ${new Date(data.generatedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}` : "Finding who to write to"}</p>
      </div>
      <DenButton size="sm" variant="secondary" disabled={refreshing} onClick={() => setAttempt(value => value + 1)}><RefreshCw size={16} strokeWidth={1.5} aria-hidden="true" />Refresh</DenButton>
    </header>
    <AdminOpportunityNav active="overview" />
    {notice ? <p role={notice.tone === "error" ? "alert" : "status"} className={`flex flex-wrap items-center gap-3 pt-4 text-sm ${notice.tone === "error" ? "text-[var(--ow-danger)]" : "text-[var(--ow-success)]"}`}>
      {notice.text}
      {notice.undo ? <DenButton size="sm" variant="ghost" onClick={() => { const undo = notice.undo; if (undo) void record(undo.organizationId, undo.organizationName, "reopened", null, ""); }}>Undo</DenButton> : null}
    </p> : null}
    <div aria-busy={refreshing}>{data ? <OutreachList data={data} busy={busy} onOutcome={(id, name, outcome, contact, note) => { void record(id, name, outcome, contact, note); }} />
      : <div aria-label="Finding who to write to" className="grid gap-3 py-5">{[0, 1, 2, 3, 4].map(value => <div key={value} className="h-24 rounded-lg bg-[var(--dls-hover)]" />)}</div>}</div>
  </section>;
}
