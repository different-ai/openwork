"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Check, Copy, Mail, RefreshCw, UserRound } from "lucide-react";
import {
  ACCOUNT_FOLLOW_UP_ACTIONS, adminOpportunityAccountSchema,
  type AdminOpportunityAccount as Account, type OpportunityItem,
} from "@openwork/types/den/admin-organization";
import { DenButton, buttonVariants } from "../../app/(den)/_components/ui/button";
import { DenInput } from "../../app/(den)/_components/ui/input";
import { DenSelect } from "../../app/(den)/_components/ui/select";
import { DenSkeleton } from "../../app/(den)/_components/ui/skeleton";
import { DenSwitch } from "../../app/(den)/_components/ui/switch";
import { DenTextarea } from "../../app/(den)/_components/ui/textarea";
import { outreachDraft } from "./admin-opportunity-draft";
import { ADOPTION_LABEL, KIND, PriorityBadge, STAGE_LABEL, shortDate } from "./admin-opportunity-labels";
import { requestAdmin, sendAdmin, type AdminResult } from "./admin-request";

const ACTION_LABEL: Record<(typeof ACCOUNT_FOLLOW_UP_ACTIONS)[number], string> = {
  reviewed: "Reviewed, ready for outreach", contacted: "Contacted", replied: "Got a reply", meeting: "Held a meeting",
  note: "Added a note", closed: "Closed", dismissed: "Dismissed", reopened: "Reopened",
};
const sectionTitle = "mb-2 text-xs font-semibold text-[var(--dls-text-secondary)]";
const utcToday = () => new Date().toISOString().slice(0, 10);

function suggestedContact(account: Account) {
  const signupUser = account.opportunity?.kind === "welcome" ? account.opportunity.signals.find(signal => signal.userId)?.userId : null;
  const joined = account.people.filter(person => person.userId && person.joinedAt);
  return joined.find(person => person.userId === signupUser) ?? joined[0] ?? null;
}

export function OpportunityAccountPanel({ organizationId, onRecorded }: { organizationId: string; onRecorded: () => void }) {
  const [state, setState] = useState<AdminResult<Account> | { access: "checking" }>({ access: "checking" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState(previous => previous.access === "ready" && previous.data.organization.id === organizationId ? previous : { access: "checking" });
    void requestAdmin(`/v1/admin/opportunities/accounts/${encodeURIComponent(organizationId)}`, payload => {
      const parsed = adminOpportunityAccountSchema.safeParse(payload);
      return parsed.success ? parsed.data : null;
    }, controller.signal).then(result => { if (!controller.signal.aborted) setState(result); })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setState({ access: "error", message: reason instanceof Error ? reason.message : "Could not load this account." }); });
    return () => controller.abort();
  }, [organizationId, attempt]);

  if (state.access === "checking") return <div aria-label="Loading account" aria-busy="true" className="grid gap-3"><DenSkeleton className="h-6 w-2/3" /><DenSkeleton className="h-24" /><DenSkeleton className="h-40" /><DenSkeleton className="h-40" /></div>;
  if (state.access !== "ready") return <div role="alert" className="grid gap-3 text-sm">
    <p>Could not load this account. {state.message}</p>
    <DenButton size="sm" variant="secondary" onClick={() => setAttempt(value => value + 1)}><RefreshCw size={16} strokeWidth={1.5} aria-hidden="true" />Try again</DenButton>
  </div>;
  return <AccountDetail key={state.data.organization.id} account={state.data} onRecorded={() => { setAttempt(value => value + 1); onRecorded(); }} />;
}

function AccountDetail({ account, onRecorded }: { account: Account; onRecorded: () => void }) {
  const { organization, opportunity, adoption, followUp } = account;
  const orgHref = `/admin/organizations/${encodeURIComponent(organization.id)}`;
  const [contactId, setContactId] = useState(suggestedContact(account)?.userId ?? "");
  const contact = account.people.find(person => person.userId === contactId) ?? null;
  const Kind = opportunity ? KIND[opportunity.kind] : null;
  return <div className="grid gap-5 text-sm">
    <header className="grid gap-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 className="min-w-0 text-base font-semibold"><Link href={orgHref} prefetch={false} className="hover:underline">{organization.name}</Link></h2>
        {opportunity ? <PriorityBadge priority={opportunity.priority} /> : null}
      </div>
      <p className="text-xs text-[var(--dls-text-secondary)]">
        {organization.memberCount} of {organization.seatLimit} seats · {organization.planTier} plan · {ADOPTION_LABEL[adoption.stage]} · Created {shortDate(organization.createdAt)}
      </p>
      <div className="flex flex-wrap gap-2">
        <Link href={orgHref} prefetch={false} className={buttonVariants({ variant: "secondary", size: "xs" })}>People</Link>
        <Link href={`${orgHref}/insights`} prefetch={false} className={buttonVariants({ variant: "secondary", size: "xs" })}>Insights</Link>
        <Link href={`${orgHref}/usage`} prefetch={false} className={buttonVariants({ variant: "secondary", size: "xs" })}>Usage</Link>
      </div>
    </header>

    <section aria-label="Why now">
      <h3 className={sectionTitle}>Why now</h3>
      {opportunity && Kind ? <>
        <p className="flex items-center gap-2 font-medium"><Kind.icon size={16} strokeWidth={1.5} aria-hidden="true" className={Kind.tone} />{Kind.label}: {opportunity.action.label}</p>
        <p className="mt-1 text-[var(--dls-text-secondary)]">{opportunity.action.purpose}</p>
        <ul className="mt-3 grid gap-2">{opportunity.signals.map((signal, index) => <li key={`${signal.type}-${index}`} className="flex items-baseline justify-between gap-3 border-b border-[var(--dls-border)] pb-2 last:border-0">
          <span className="min-w-0">{signal.label}</span>
          {signal.at && !signal.label.includes(shortDate(signal.at)) ? <time dateTime={signal.at} className="shrink-0 text-xs tabular-nums text-[var(--dls-text-secondary)]">{shortDate(signal.at)}</time> : null}
        </li>)}</ul>
      </> : <p className="text-[var(--dls-text-secondary)]">No current signal puts this account in the queue. Its history and people are below.</p>}
      <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
        <div><dt className="text-[var(--dls-text-secondary)]">Active this week</dt><dd className="font-medium tabular-nums">{adoption.activeUsers.current} <span className="font-normal text-[var(--dls-text-secondary)]">vs {adoption.activeUsers.previous}</span></dd></div>
        <div><dt className="text-[var(--dls-text-secondary)]">Joined this week</dt><dd className="font-medium tabular-nums">{adoption.joinedThisWeek}</dd></div>
        <div><dt className="text-[var(--dls-text-secondary)]">Set up</dt><dd className="font-medium tabular-nums">{adoption.skills} skills · {adoption.mcpConnections} connections</dd></div>
      </dl>
    </section>

    <section aria-label="People">
      <h3 className={sectionTitle}>People</h3>
      <ul className="grid gap-1">{account.people.slice(0, 8).map(person => {
        const selectable = Boolean(person.userId && person.joinedAt);
        return <li key={person.memberId}>
          <label className={`flex min-w-0 items-start gap-3 rounded-md px-2 py-2 ${selectable ? "cursor-pointer hover:bg-[var(--dls-hover)]" : "opacity-70"} ${person.userId === contactId ? "bg-[var(--dls-hover)]" : ""}`}>
            <input type="radio" name="contact" className="mt-1" disabled={!selectable} checked={person.userId === contactId} onChange={() => setContactId(person.userId ?? "")} aria-label={`Contact ${person.name ?? person.email ?? "member"}`} />
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-2">
                {person.userId ? <Link href={`/admin/users?${new URLSearchParams({ search: person.userId })}`} prefetch={false} className="font-medium hover:underline">{person.name || person.email || "Unnamed member"}</Link> : <span className="font-medium">Pending member</span>}
                <span className="text-xs text-[var(--dls-text-secondary)]">{person.role}</span>
                {person.userId === suggestedContact(account)?.userId ? <span className="text-xs text-[var(--ow-success)]">Suggested contact</span> : null}
              </span>
              {person.email ? <span className="block truncate text-xs text-[var(--dls-text-secondary)]">{person.email}</span> : null}
              <span className="block text-xs text-[var(--dls-text-secondary)]">
                {person.joinedAt ? `Joined ${shortDate(person.joinedAt)}` : "Invited, not joined"} · {person.lastObservedAt ? `Last observed ${shortDate(person.lastObservedAt)}` : "No observed use in 30 days"}
              </span>
            </span>
          </label>
        </li>;
      })}</ul>
      {account.people.length > 8 ? <Link href={orgHref} prefetch={false} className="mt-2 inline-block text-xs underline">All {organization.memberCount} people</Link> : null}
      {account.people.length === 0 ? <p className="text-[var(--dls-text-secondary)]">No current members to contact.</p> : null}
    </section>

    {opportunity ? <Draft opportunity={opportunity} contact={contact} /> : null}

    <section aria-label="Follow-up">
      <h3 className={sectionTitle}>Follow-up</h3>
      <dl className="mb-3 grid grid-cols-2 gap-2 text-xs">
        <div><dt className="text-[var(--dls-text-secondary)]">Stage</dt><dd className="font-medium">{STAGE_LABEL[followUp?.stage ?? "needs_review"]}</dd></div>
        <div><dt className="text-[var(--dls-text-secondary)]">Owner</dt><dd className="font-medium">{followUp?.ownerName ?? "Unassigned"}</dd></div>
        <div><dt className="text-[var(--dls-text-secondary)]">Last action</dt><dd className="font-medium">{followUp?.lastActionKind && followUp.lastActionAt ? `${ACTION_LABEL[followUp.lastActionKind]} ${shortDate(followUp.lastActionAt)}` : "None recorded"}</dd></div>
        <div><dt className="text-[var(--dls-text-secondary)]">Next follow-up</dt><dd className="font-medium">{followUp?.nextFollowUpAt ? `${shortDate(followUp.nextFollowUpAt)}${followUp.nextAction ? ` · ${followUp.nextAction}` : ""}` : "Not scheduled"}</dd></div>
      </dl>
      <RecordStep account={account} contactId={contactId} onRecorded={onRecorded} />
    </section>

    <section aria-label="History">
      <h3 className={sectionTitle}>History</h3>
      {account.history.length ? <ol className="grid gap-2">{account.history.map(entry => <li key={entry.id} className="border-b border-[var(--dls-border)] pb-2 text-xs last:border-0">
        <p><span className="font-medium">{ACTION_LABEL[entry.kind]}</span>{entry.contactName ? ` with ${entry.contactName}` : ""} · <time dateTime={entry.occurredAt}>{shortDate(entry.occurredAt)}</time>{entry.actorName ? ` · ${entry.actorName}` : ""}</p>
        {entry.note ? <p className="mt-1 text-[var(--dls-text-secondary)]">{entry.note}</p> : null}
      </li>)}</ol> : <p className="text-[var(--dls-text-secondary)]">No outreach recorded yet.</p>}
    </section>
  </div>;
}

function Draft({ opportunity, contact }: { opportunity: OpportunityItem; contact: Account["people"][number] | null }) {
  const initial = useMemo(() => outreachDraft(opportunity, contact?.name ?? null), [opportunity, contact?.name]);
  const [body, setBody] = useState(initial.body);
  const [copied, setCopied] = useState(false);
  useEffect(() => { setBody(initial.body); setCopied(false); }, [initial.body]);
  const mailto = contact?.email ? `mailto:${encodeURIComponent(contact.email)}?${new URLSearchParams({ subject: initial.subject, body }).toString().replace(/\+/g, "%20")}` : null;
  return <section aria-label="Outreach draft">
    <h3 className={sectionTitle}>Outreach draft · not sent</h3>
    <DenTextarea aria-label="Outreach draft" rows={9} value={body} onChange={event => setBody(event.target.value)} />
    <div className="mt-2 flex flex-wrap gap-2">
      <DenButton size="sm" variant="secondary" onClick={() => { void navigator.clipboard?.writeText(body).then(() => setCopied(true)); }}>
        {copied ? <Check size={16} strokeWidth={1.5} aria-hidden="true" /> : <Copy size={16} strokeWidth={1.5} aria-hidden="true" />}{copied ? "Copied" : "Copy draft"}
      </DenButton>
      {mailto ? <a href={mailto} className={buttonVariants({ variant: "secondary", size: "sm" })}><Mail size={16} strokeWidth={1.5} aria-hidden="true" className="mr-1" />Open in email app</a> : null}
      {!contact ? <span className="flex items-center gap-1 text-xs text-[var(--dls-text-secondary)]"><UserRound size={16} strokeWidth={1.5} aria-hidden="true" />Choose a contact above</span> : null}
    </div>
  </section>;
}

function RecordStep({ account, contactId, onRecorded }: { account: Account; contactId: string; onRecorded: () => void }) {
  const followUp = account.followUp;
  const [kind, setKind] = useState<(typeof ACCOUNT_FOLLOW_UP_ACTIONS)[number]>(followUp ? "contacted" : "reviewed");
  const [note, setNote] = useState("");
  const [nextAction, setNextAction] = useState(followUp?.nextAction ?? account.opportunity?.action.label ?? "");
  const [nextDate, setNextDate] = useState(followUp?.nextFollowUpAt?.slice(0, 10) ?? "");
  const [assignToMe, setAssignToMe] = useState(!followUp?.ownerUserId);
  const [confirmed, setConfirmed] = useState(followUp?.confirmedOpportunity ?? "");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const ends = kind === "closed" || kind === "dismissed";
  const recent = followUp?.lastContactedAt && Date.now() - Date.parse(followUp.lastContactedAt) < 14 * 86_400_000;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true); setMessage(null);
    const result = await sendAdmin(`/v1/admin/opportunities/accounts/${encodeURIComponent(account.organization.id)}/actions`, "POST", {
      requestId, kind, contactUserId: contactId && (kind === "contacted" || kind === "replied" || kind === "meeting") ? contactId : null,
      note: note.trim() || null, nextAction: ends ? null : nextAction.trim() || null, followUpOn: ends ? null : nextDate || null,
      assignToMe, confirmedOpportunity: confirmed === "expansion" || confirmed === "commercial" ? confirmed : null,
    }).catch((reason: unknown) => ({ ok: false as const, message: reason instanceof Error ? reason.message : "Could not save.", status: 0 }));
    setSaving(false);
    if (!result.ok) { setMessage({ tone: "error", text: `Not saved. ${result.message}` }); return; }
    setRequestId(crypto.randomUUID()); setNote("");
    setMessage({ tone: "ok", text: `Saved · ${ACTION_LABEL[kind]}` });
    onRecorded();
  }

  return <form onSubmit={submit} className="grid gap-3" aria-label="Record next step">
    {recent && (kind === "contacted") ? <p className="text-xs text-[var(--ow-warning)]">Last contacted {shortDate(followUp.lastContactedAt ?? "")}. Make sure a new message adds something.</p> : null}
    <label className="grid gap-1 text-xs text-[var(--dls-text-secondary)]">What happened
      <DenSelect aria-label="What happened" value={kind} onChange={event => { const next = ACCOUNT_FOLLOW_UP_ACTIONS.find(value => value === event.target.value); if (next) setKind(next); }}>
        {ACCOUNT_FOLLOW_UP_ACTIONS.map(value => <option key={value} value={value}>{ACTION_LABEL[value]}</option>)}
      </DenSelect>
    </label>
    <label className="grid gap-1 text-xs text-[var(--dls-text-secondary)]">Internal note
      <DenTextarea aria-label="Internal note" rows={2} maxLength={500} value={note} onChange={event => setNote(event.target.value)} placeholder="What you said or learned" />
    </label>
    {!ends ? <div className="grid gap-3">
      <label className="grid gap-1 text-xs text-[var(--dls-text-secondary)]">Next action
        <DenInput aria-label="Next action" maxLength={240} value={nextAction} onChange={event => setNextAction(event.target.value)} />
      </label>
      <label className="grid gap-1 text-xs text-[var(--dls-text-secondary)]">Follow-up date (UTC)
        <DenInput aria-label="Follow-up date" type="date" min={utcToday()} value={nextDate} onChange={event => setNextDate(event.target.value)} />
      </label>
    </div> : null}
    <div className="grid gap-3">
      <label className="grid gap-1 text-xs text-[var(--dls-text-secondary)]">Confirmed opportunity
        <DenSelect aria-label="Confirmed opportunity" value={confirmed} onChange={event => setConfirmed(event.target.value)}>
          <option value="">None confirmed</option><option value="expansion">Expansion confirmed</option><option value="commercial">Commercial confirmed</option>
        </DenSelect>
      </label>
      <span className="flex items-center gap-2 self-end pb-2 text-xs"><DenSwitch size="sm" checked={assignToMe} onChange={setAssignToMe} aria-label="Assign to me" />Assign to me</span>
    </div>
    <div className="flex flex-wrap items-center gap-3">
      <DenButton type="submit" size="sm" disabled={saving}>{saving ? "Saving" : "Save step"}</DenButton>
      {message ? <p role={message.tone === "error" ? "alert" : "status"} className={`text-xs ${message.tone === "error" ? "text-[var(--ow-danger)]" : "text-[var(--ow-success)]"}`}>{message.text}</p> : null}
    </div>
  </form>;
}
