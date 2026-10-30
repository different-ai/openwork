"use client";

import Link from "next/link";
import { Check, ChevronDown, ChevronRight, Lock, PencilLine } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  AGENT_PREFERENCE_COPY,
  AGENT_PREFERENCE_FIELDS,
  AGENT_PREFERENCE_MAX,
  type AgentChangeField,
  type AgentPreferenceField,
  type MemberAgentCheck,
  type MemberAgentInput,
  type MemberAgentSource,
  type MemberAgentSourceConnection,
  type MemberAgentView,
} from "@openwork/types/den/workbot-proactive";
import { DenBadge } from "../../_components/ui/badge";
import { DenButton } from "../../_components/ui/button";
import { DenDropdownPopup, DenDropdownRoot, DenDropdownTrigger } from "../../_components/ui/dropdown-popup";
import { denDropdownListClass, denDropdownRowBaseClass, denDropdownRowIdleClass, denDropdownRowSelectedClass } from "../../_components/ui/dropdown-styles";
import { DenSelect } from "../../_components/ui/select";
import { DenSwitch } from "../../_components/ui/switch";
import { DenTextarea } from "../../_components/ui/textarea";
import { ItemPanel, ItemRow, ItemRowsSkeleton, ItemSection } from "./item-list";
import { ItemHeader, ItemPage } from "./item-header";
import { ConnectorLogo } from "./item-logo";
import { SourceIcon } from "./source-icon";
import {
  OUTCOME_PILL,
  changeSourceLine,
  clockLabel,
  dayClockLabel,
  hourLabel,
  hoursLabel,
  isSameDay,
  latestChange,
  myAgentStateLine,
  sentTodayLabel,
  whenPhrase,
} from "./my-agent-view";

/**
 * My agent in the Library (`workbotAgentLibrary`): the member's own background agent, what it did and why it stayed
 * quiet, and what they told it. Chat is the main way to change it; every change shows where it came from with an
 * Undo, here and in chat alike. These components only render; my-agent-screen.tsx loads and saves.
 */

const ADMIN_LOCK = "Set by your admin in Manage › Workbot.";

/** A field as tall as what's written in it: CSS where the browser sizes fields itself, a line estimate elsewhere. */
const GROW = "resize-none [field-sizing:content]";
function growRows(text: string) {
  const lines = text.split("\n").reduce((total, line) => total + Math.max(1, Math.ceil(line.length / 72)), 0);
  return Math.min(6, Math.max(1, lines));
}

export function AgentLogo({ size = "sm" }: { size?: "sm" | "lg" }) {
  return <ConnectorLogo name="My bot" iconUrl="/openwork-mark.svg" size={size} />;
}

function LockNote({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] leading-4 text-gray-500">
      <Lock size={12} strokeWidth={1.5} aria-hidden className="shrink-0" />
      <span>{children}</span>
    </span>
  );
}

// ---- The Library row ------------------------------------------------------------------------------------------------

/** Pinned above the Library's filters: where the agent stands, today's count, its switch and the way in. */
export function MyAgentRow({ view, href, now, saving, onToggle }: {
  view: MemberAgentView;
  href: string;
  now: number;
  saving: boolean;
  onToggle: (on: boolean) => void;
}) {
  const locked = !view.available;
  const count = !locked && view.on ? sentTodayLabel(view) : null;
  return (
    <ItemPanel>
      <div data-testid="my-agent-row" data-state={locked ? "locked" : view.on ? "on" : "off"}>
        <ItemRow
          compact
          wideAction
          href={href}
          logo={<AgentLogo />}
          title="My bot"
          description={locked ? <LockNote>Turned off by your admin in Manage › Workbot.</LockNote> : myAgentStateLine(view, now)}
          status={count ?? ""}
          action={(
            <span className="flex items-center gap-2">
              <DenSwitch size="sm" aria-label="My bot" checked={view.available && view.on} disabled={locked || saving} onChange={onToggle} />
              <Link href={href} aria-label="Open My bot" className="flex h-7 w-7 items-center justify-center rounded-lg text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900">
                <ChevronRight className="h-4 w-4" aria-hidden />
              </Link>
            </span>
          )}
        />
      </div>
    </ItemPanel>
  );
}

export function MyAgentRowSkeleton() {
  return <ItemPanel><ItemRowsSkeleton label="Loading your agent" rows={1} /></ItemPanel>;
}

export function MyAgentRowError({ message, retrying, onRetry }: { message: string; retrying: boolean; onRetry: () => void }) {
  return (
    <ItemPanel>
      <div data-testid="my-agent-row" data-state="error">
        <ItemRow compact wideAction logo={<AgentLogo />} title="My bot" description={message}
          action={<DenButton variant="secondary" size="xs" loading={retrying} onClick={onRetry}>Try again</DenButton>} />
      </div>
    </ItemPanel>
  );
}

// ---- The page -------------------------------------------------------------------------------------------------------

export type MyAgentLinks = {
  library: string;
  /** The Google Workspace connector in the member's Library, or where to add it. */
  google: { href: string; status: string };
  /** A connection's page in the member's Library, where they connect or reconnect their account. */
  connector: (connectionId: string) => string;
  /** The Library's connector catalog, for a source the organization has no connection for yet. */
  catalog: string;
};

type Change = (change: MemberAgentInput) => void;

/** "Saved from chat at 11:20 AM. Undo" for the change behind a field. */
function ChangeNote({ view, field, now, saving, onChange }: { view: MemberAgentView; field: AgentChangeField; now: number; saving: boolean; onChange: Change }) {
  const change = latestChange(view, field);
  if (!change) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 text-[12px] leading-4 text-gray-500" data-testid={`my-agent-change-${field}`} data-source={change.source}>
      <span>{changeSourceLine(change, view.timeZone, now)}</span>
      <button type="button" disabled={saving} onClick={() => onChange({ undo: change.id })} aria-label={`Undo ${change.summary}`}
        className="rounded font-medium text-gray-900 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900 disabled:opacity-50">
        Undo
      </button>
    </span>
  );
}

/** A compact settings row: label left, its state or control right, one note under it. */
function Row({ label, labelId, hint, note, children, testId }: { label: string; labelId?: string; hint?: string; note?: ReactNode; children?: ReactNode; testId?: string }) {
  return (
    <div className="flex flex-col gap-1 py-2.5" data-testid={testId}>
      <div className="flex min-h-[28px] flex-wrap items-center justify-between gap-3">
        <span id={labelId} className="text-[13px] font-medium text-gray-900" title={hint}>{label}</span>
        <div className="flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2">{children}</div>
      </div>
      {note ? <div>{note}</div> : null}
    </div>
  );
}

function CheckRow({ check, label }: { check: MemberAgentCheck; label: string }) {
  const pill = OUTCOME_PILL[check.outcome];
  return (
    <div className="flex min-h-10 items-center gap-3 py-2" data-testid="my-agent-check" data-outcome={check.outcome}>
      <span className="w-[88px] shrink-0 whitespace-nowrap text-[12px] tabular-nums text-gray-500">{label}</span>
      <span className="min-w-0 flex-1 text-[13px] leading-[18px] text-gray-900">{check.summary}</span>
      {check.slackUrl ? (
        <a href={check.slackUrl} target="_blank" rel="noreferrer" className="shrink-0 text-[12px] font-medium text-gray-700 underline-offset-2 hover:text-gray-900 hover:underline">
          Open in Slack
        </a>
      ) : null}
      <DenBadge size="sm" tone={pill.tone} className="w-[58px] shrink-0 justify-center">{pill.label}</DenBadge>
    </div>
  );
}

function wordsChange(field: AgentPreferenceField, text: string): NonNullable<MemberAgentInput["preferences"]> {
  const preferences: NonNullable<MemberAgentInput["preferences"]> = {};
  preferences[field] = text;
  return preferences;
}

function WordsField({ view, field, now, saving, onChange }: { view: MemberAgentView; field: AgentPreferenceField; now: number; saving: boolean; onChange: Change }) {
  const id = useId();
  const value = view.preferences?.[field] ?? "";
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const changed = draft.trim() !== value.trim();
  const change = latestChange(view, field);
  return (
    <div className="grid gap-1.5 py-2.5 sm:grid-cols-[180px_minmax(0,1fr)] sm:items-start sm:gap-x-4" data-testid={`my-agent-words-${field}`}>
      <label htmlFor={id} className="text-[13px] font-medium text-gray-900 sm:pt-2.5">{AGENT_PREFERENCE_COPY[field].label}</label>
      <div className="flex min-w-0 flex-col gap-1.5">
        <DenTextarea id={id} rows={growRows(draft)} maxLength={AGENT_PREFERENCE_MAX} value={draft} disabled={saving} placeholder={AGENT_PREFERENCE_COPY[field].placeholder}
          className={GROW} onChange={(event) => setDraft(event.target.value)} />
        {change || changed ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <ChangeNote view={view} field={field} now={now} saving={saving} onChange={onChange} />
            {changed ? (
              <span className="ml-auto flex gap-2">
                <DenButton variant="secondary" size="xs" onClick={() => setDraft(value)}>Discard</DenButton>
                <DenButton size="xs" disabled={saving} onClick={() => onChange({ preferences: wordsChange(field, draft.trim()) })}>Save</DenButton>
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function focalLine(view: MemberAgentView, now: number): { title: string; sentence: ReactNode } {
  if (!view.available) return { title: "Turned off by your admin", sentence: <LockNote>Your admin turns it on in Manage › Workbot.</LockNote> };
  if (!view.on) return { title: "Off", sentence: "It isn't checking your email or calendar." };
  if (view.snoozedUntil) return { title: `Snoozed until ${clockLabel(view.snoozedUntil, view.timeZone)}`, sentence: view.lastCheck ? `Last check ${whenPhrase(view.lastCheck.at, view.timeZone, now)}: ${view.lastCheck.summary}` : "No checks yet." };
  if (view.lastCheck) return { title: `Last check ${whenPhrase(view.lastCheck.at, view.timeZone, now)}`, sentence: view.lastCheck.summary };
  return { title: "No checks yet", sentence: view.destination?.blocked === "member_not_linked" ? "Link your Slack account to Workbot to get its messages." : "It reads your calendar, email and team chat in your working hours." };
}

export function MyAgentPanel({ view, now, links, saving, error, earlier, onChange }: {
  view: MemberAgentView;
  now: number;
  links: MyAgentLinks;
  saving: boolean;
  error: string | null;
  earlier: { open: boolean; onToggle: (open: boolean) => void; checks: MemberAgentCheck[] | null; loading: boolean; error: string | null };
  onChange: Change;
}) {
  const ids = { hours: useId(), cap: useId() };
  const focal = focalLine(view, now);
  const active = view.available && view.on;
  const limits = view.limits;
  const today = view.todayChecks ?? [];
  const earlierChecks = (earlier.checks ?? []).filter((check) => !isSameDay(check.at, now, view.timeZone));
  const fix = view.lastCheck?.fix ?? null;
  const reconnect = view.lastCheck?.sources[0] ?? null;
  const google = links.google;

  return (
    <ItemPage testId="my-agent-screen">
      <ItemHeader
        compact
        logo={<AgentLogo size="lg" />}
        title="My bot"
        actions={<DenSwitch aria-label="My bot" checked={active} disabled={!view.available || saving} onChange={(on) => onChange({ on })} />}
      />

      {error ? <p role="alert" className="-mt-3 text-[13px] text-red-700">{error}</p> : null}

      <section className="flex flex-col gap-1.5" data-testid="my-agent-last-check" data-outcome={view.lastCheck?.outcome ?? "none"}>
        <h2 className="text-[20px] font-semibold leading-7 tracking-[-0.3px] text-gray-950">{focal.title}</h2>
        <p className="text-[14px] leading-5 text-gray-700">{focal.sentence}</p>
        {active ? (
          <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] leading-5 text-gray-500">
            {view.nextCheckAt ? <span>{`Next check ${whenPhrase(view.nextCheckAt, view.timeZone, now)}`}</span> : null}
            {limits && view.sentToday !== undefined ? <span>{`${view.sentToday} of ${limits.dailyCap} sent today`}</span> : null}
            {view.snoozedUntil ? <DenButton variant="secondary" size="xs" disabled={saving} onClick={() => onChange({ snooze: null })}>Resume</DenButton> : null}
            {fix === "reconnect_google" ? <Link href={google.href} className="font-medium text-gray-900 underline-offset-2 hover:underline">Reconnect Google</Link> : null}
            {fix === "reconnect" && reconnect?.connectionId ? <Link href={links.connector(reconnect.connectionId)} className="font-medium text-gray-900 underline-offset-2 hover:underline">{`Reconnect ${reconnect.name}`}</Link> : null}
          </p>
        ) : null}
      </section>

      <ItemSection title="Today" variant="rule" testId="my-agent-today">
        <div className="flex flex-col divide-y divide-gray-100">
          {today.length === 0 ? <p className="py-3 text-[13px] text-gray-500">No checks yet today.</p> : null}
          {today.map((check) => <CheckRow key={check.id} check={check} label={clockLabel(check.at, view.timeZone)} />)}
        </div>
        <details className="group border-t border-gray-100" data-testid="my-agent-earlier" open={earlier.open} onToggle={(event) => earlier.onToggle(event.currentTarget.open)}>
          <summary className="flex min-h-10 cursor-pointer list-none items-center gap-1.5 text-[13px] font-medium text-gray-700 [&::-webkit-details-marker]:hidden">
            <ChevronRight className="h-4 w-4 text-gray-500 transition-transform duration-150 ease-out group-open:rotate-90 motion-reduce:transition-none" aria-hidden />
            Earlier this week
          </summary>
          <div className="flex flex-col divide-y divide-gray-100 pb-1">
            {earlier.loading ? <ItemRowsSkeleton label="Loading this week's checks" rows={2} /> : null}
            {earlier.error ? <p className="py-3 text-[13px] text-gray-600">{earlier.error}</p> : null}
            {earlier.checks && earlierChecks.length === 0 ? <p className="py-3 text-[13px] text-gray-500">No earlier checks this week.</p> : null}
            {earlierChecks.map((check) => <CheckRow key={check.id} check={check} label={dayClockLabel(check.at, view.timeZone)} />)}
          </div>
        </details>
      </ItemSection>

      <ItemSection title="What it tells you about" variant="rule" testId="my-agent-responsibilities">
        <div className="flex flex-col divide-y divide-gray-100">
          {view.responsibilities.map((responsibility) => (
            <Row key={responsibility.id} label={responsibility.label} hint={responsibility.tells} testId={`my-agent-${responsibility.id}`}
              note={!responsibility.enabled
                ? <LockNote>Turned off by your admin in Manage › Workbot.</LockNote>
                : <ChangeNote view={view} field={responsibility.id} now={now} saving={saving} onChange={onChange} />}>
              <DenSwitch size="sm" aria-label={responsibility.label} checked={responsibility.enabled && !responsibility.muted} disabled={!responsibility.enabled || saving}
                onChange={(on) => onChange(on ? { unmute: [responsibility.id] } : { mute: [responsibility.id] })} />
            </Row>
          ))}
        </div>
      </ItemSection>

      <ItemSection title="In your words" variant="rule" testId="my-agent-words">
        <div className="flex flex-col divide-y divide-gray-100">
          {AGENT_PREFERENCE_FIELDS.map((field) => <WordsField key={field} view={view} field={field} now={now} saving={saving} onChange={onChange} />)}
        </div>
      </ItemSection>

      <ItemSection title="What it reads" variant="rule" testId="my-agent-uses">
        <div className="flex flex-col divide-y divide-gray-100">
          {(view.sources ?? []).map((source) => <SourceRow key={source.id} view={view} source={source} now={now} saving={saving} links={links} onChange={onChange} />)}
        </div>
        {(view.sources ?? []).some(sourceLocked) ? (
          <p className="border-t border-gray-100 pt-2.5" data-testid="my-agent-sources-locked"><LockNote>{`Locked sources are ${ADMIN_LOCK.charAt(0).toLowerCase()}${ADMIN_LOCK.slice(1)}`}</LockNote></p>
        ) : null}
      </ItemSection>

      {limits ? (
        <ItemSection title="Limits" variant="rule" testId="my-agent-limits">
          <div className="flex flex-col divide-y divide-gray-100">
            <Row label="Hours" labelId={ids.hours} testId="my-agent-hours"
              note={limits.narrowed.hours ? <ChangeNote view={view} field="hours" now={now} saving={saving} onChange={onChange} /> : null}>
              <span className="text-[13px] text-gray-500">{limits.workingDays === "everyday" ? "Every day" : "Weekdays"}</span>
              <div className="w-24">
                <DenSelect aria-label="Start of your day" menuWidth="trigger" value={String(limits.startHour)} disabled={saving}
                  onChange={(event) => onChange({ hours: { startHour: Number(event.target.value), endHour: limits.endHour } })}>
                  {hourRange(limits.admin.startHour, limits.endHour - 1).map((hour) => <option key={hour} value={String(hour)}>{hourLabel(hour)}</option>)}
                </DenSelect>
              </div>
              <span className="text-[13px] text-gray-500">to</span>
              <div className="w-24">
                <DenSelect aria-label="End of your day" menuWidth="trigger" value={String(limits.endHour)} disabled={saving}
                  onChange={(event) => onChange({ hours: { startHour: limits.startHour, endHour: Number(event.target.value) } })}>
                  {hourRange(limits.startHour + 1, limits.admin.endHour).map((hour) => <option key={hour} value={String(hour)}>{hourLabel(hour)}</option>)}
                </DenSelect>
              </div>
            </Row>
            {limits.quietWindow ? (
              <Row label="Only urgent" testId="my-agent-quiet-window" note={<ChangeNote view={view} field="quietWindow" now={now} saving={saving} onChange={onChange} />}>
                <span className="text-[13px] text-gray-900">{hoursLabel(limits.quietWindow)}</span>
              </Row>
            ) : null}
            <Row label="Daily limit" labelId={ids.cap} testId="my-agent-cap"
              note={limits.narrowed.dailyCap
                ? <span className="flex flex-col gap-1"><ChangeNote view={view} field="dailyCap" now={now} saving={saving} onChange={onChange} /><LockNote>{`Your admin allows ${limits.admin.dailyCap} a day.`}</LockNote></span>
                : <LockNote>{ADMIN_LOCK}</LockNote>}>
              <span className="text-[13px] text-gray-900">{`${limits.dailyCap} a day`}</span>
            </Row>
          </div>
        </ItemSection>
      ) : null}
    </ItemPage>
  );
}

/** "Saved from chat at 10:42 AM." for the latest change to one source's switch or instruction. */
function SourceChangeNote({ view, sourceId, field, now }: { view: MemberAgentView; sourceId: string; field: "source" | "sourceInstruction"; now: number }) {
  const change = (view.changes ?? []).find((entry) => entry.field === field && entry.sourceId === sourceId && !entry.undone);
  return change ? <span data-source={change.source}>{changeSourceLine(change, view.timeZone, now)}</span> : null;
}

/**
 * Whether a source's row shows a lock: not allowed, or another source the admin turned on for everyone. Calendar,
 * email and team chat on for everyone show no lock: picking where they read from is the member's control there.
 */
function sourceLocked(source: MemberAgentSource) {
  return source.policy === "off" || (source.kind === "other" && source.policy === "everyone");
}

const PICKER_NOUN: Record<Exclude<MemberAgentSource["kind"], "other">, string> = { calendar: "calendar", email: "email", chat: "team chat" };

function pickerTitle(kind: Exclude<MemberAgentSource["kind"], "other">) {
  return `Read your ${PICKER_NOUN[kind]} from`;
}

/** The picker's menu: the allowed apps, a check on the chosen one, and Connect on those the member hasn't connected. */
export function AccountPickerOptions({ kind, options, chosen, onPick }: {
  kind: Exclude<MemberAgentSource["kind"], "other">;
  options: MemberAgentSourceConnection[];
  chosen: MemberAgentSourceConnection | null;
  onPick: (connectionId: string) => void;
}) {
  const title = pickerTitle(kind);
  return (
    <>
      <p className="px-4 pb-1 pt-3 text-[12px] font-medium text-gray-500">{title}</p>
      <div className={denDropdownListClass} role="menu" aria-label={title}>
        {options.map((option) => {
          const selected = option.id === chosen?.id;
          return (
            <button key={option.id} type="button" role="menuitemradio" aria-checked={selected} aria-label={option.name}
              className={`${denDropdownRowBaseClass} ${selected ? denDropdownRowSelectedClass : denDropdownRowIdleClass} items-center`}
              onClick={() => onPick(option.id)}>
              <span className="flex min-w-0 items-center gap-3">
                <ConnectorLogo name={option.name} url={option.url} size="xs" />
                <span className="truncate text-[13px] text-gray-900">{option.name}</span>
                {selected ? <Check size={14} strokeWidth={1.5} aria-hidden className="shrink-0 text-gray-900" /> : null}
              </span>
              {option.state !== "connected" ? <span className="shrink-0 text-[12px] font-medium text-gray-700">{option.state === "reconnect" ? "Reconnect" : "Connect"}</span> : null}
            </button>
          );
        })}
      </div>
    </>
  );
}

/**
 * Where calendar, email or team chat reads from, when the admin allowed several apps: the chosen app's logo and name,
 * opening a menu of the allowed apps with a check on the chosen one and Connect on those the member hasn't connected.
 */
function AccountPicker({ kind, options, chosen, disabled, onPick }: {
  kind: Exclude<MemberAgentSource["kind"], "other">;
  options: MemberAgentSourceConnection[];
  chosen: MemberAgentSourceConnection | null;
  disabled: boolean;
  onPick: (connectionId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const title = pickerTitle(kind);
  return (
    <DenDropdownRoot open={open} onOpenChange={setOpen}>
      <DenDropdownTrigger ref={triggerRef} type="button" disabled={disabled} aria-label={`${title}: ${chosen?.name ?? "choose an app"}`} data-testid={`my-agent-picker-${kind}`}
        className="flex h-8 min-w-0 max-w-[240px] items-center gap-2 rounded-lg border border-gray-200 bg-white pl-1.5 pr-2.5 text-[13px] text-gray-900 outline-hidden transition-colors duration-150 ease-out hover:border-gray-300 hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-gray-900/10 disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none">
        {chosen ? <ConnectorLogo name={chosen.name} url={chosen.url} size="xs" /> : null}
        <span className="truncate">{chosen?.name ?? "Choose an app"}</span>
        <ChevronDown size={14} strokeWidth={1.5} aria-hidden className="shrink-0 text-gray-500" />
      </DenDropdownTrigger>
      {open ? (
        <DenDropdownPopup anchor={triggerRef} popupRef={popupRef}>
          <AccountPickerOptions kind={kind} options={options} chosen={chosen}
            onPick={(connectionId) => {
              setOpen(false);
              if (connectionId !== chosen?.id) onPick(connectionId);
            }} />
        </DenDropdownPopup>
      ) : null}
    </DenDropdownRoot>
  );
}

/**
 * One source in What it reads, as one row. Calendar, email and team chat: their icon, a state line (when it was last
 * read, or the Connect action when the member's account isn't ready) and the app it reads from, a picker when the
 * admin allowed several. Another source: its own logo and state. Then a quiet button for the member's instruction and,
 * where the member chooses, its switch (a lock where the admin decided; the reason is said once, under the list). The
 * instruction, once written, sits under it.
 */
function SourceRow({ view, source, now, saving, links, onChange }: { view: MemberAgentView; source: MemberAgentSource; now: number; saving: boolean; links: MyAgentLinks; onChange: Change }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(source.instruction);
  useEffect(() => setDraft(source.instruction), [source.instruction]);
  const core = source.kind === "other" ? null : source.kind;
  const locked = sourceLocked(source);
  const ready = source.connections.find((connection) => connection.state === "connected") ?? null;
  const fix = source.connections.find((connection) => connection.state !== "connected") ?? null;
  const logoFrom = ready ?? source.connections[0] ?? null;
  const steerable = source.on && source.policy !== "off";
  // The app a core source reads from, under its own name ("Google Workspace"), as the picker lists it.
  const chosen = source.options.find((option) => option.id === source.connections[0]?.id) ?? null;
  const showSwitch = !core || source.policy !== "everyone";
  const save = (instruction: string) => {
    onChange({ sources: [{ source: source.id, instruction }] });
    setEditing(false);
  };
  const status = source.policy === "off"
    ? "Not allowed"
    : !source.on
      ? "Off"
      : !source.connections.length
        ? `No ${source.name.toLowerCase()} connected`
        : !ready
          ? null
          : source.lastReadAt ? `Last read ${whenPhrase(source.lastReadAt, view.timeZone, now)}` : "Not read yet";
  const instructionLabel = `${source.instruction ? "Edit the" : "Add an"} instruction for ${source.name}`;
  const connectAction = source.on && source.policy !== "off" && !ready ? (
    fix
      ? <Link href={links.connector(fix.id)} className="whitespace-nowrap text-[12px] font-medium text-gray-900 underline-offset-2 hover:underline">{`${fix.state === "reconnect" ? "Reconnect" : "Connect"} ${fix.name}`}</Link>
      : <Link href={links.catalog} className="whitespace-nowrap text-[12px] font-medium text-gray-900 underline-offset-2 hover:underline">{`Connect ${source.name.toLowerCase()}`}</Link>
  ) : null;
  return (
    <div className="group flex flex-col gap-1.5 py-2" data-testid={`my-agent-source-${source.id}`} data-on={source.on} data-policy={source.policy}>
      <div className="flex min-h-[36px] items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-3">
          {core ? <SourceIcon kind={core} /> : logoFrom ? <ConnectorLogo name={logoFrom.name} url={logoFrom.url} size="xs" /> : <SourceIcon kind={source.kind} />}
          <span className="flex min-w-0 flex-col">
            <span className={`truncate text-[13px] font-medium ${source.on ? "text-gray-900" : "text-gray-500"}`}>{source.name}</span>
            {core && (status || connectAction) ? (
              <span className="flex min-w-0 items-center gap-2 text-[12px] leading-4 text-gray-500" data-testid={`my-agent-state-${source.id}`}>
                {status ? <span className="truncate">{status}</span> : null}
                {connectAction}
              </span>
            ) : null}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {!core && status ? <span className="whitespace-nowrap text-[12px] text-gray-500">{status}</span> : null}
          {!core ? connectAction : null}
          {core && source.policy !== "off" && source.options.length > 1 ? (
            <AccountPicker kind={core} options={source.options} chosen={chosen} disabled={saving}
              onPick={(connectionId) => onChange({ sources: [{ source: source.id, connectionId }] })} />
          ) : null}
          {core && source.policy !== "off" && source.options.length === 1 && chosen ? (
            <span className="flex min-w-0 max-w-[220px] items-center gap-2 px-2 text-[12px] text-gray-700" data-testid={`my-agent-app-${source.id}`}>
              <ConnectorLogo name={chosen.name} url={chosen.url} size="xs" />
              <span className="truncate">{chosen.name}</span>
            </span>
          ) : null}
          {steerable && !editing ? (
            <button type="button" disabled={saving} onClick={() => setEditing(true)} aria-label={instructionLabel} title={instructionLabel}
              className={`flex h-7 w-7 items-center justify-center rounded-lg text-gray-500 transition-[color,background-color,opacity] duration-150 ease-out hover:bg-gray-100 hover:text-gray-900 focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100 motion-reduce:transition-none ${source.instruction ? "" : "opacity-0"} focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900 disabled:opacity-50`}>
              <PencilLine size={16} strokeWidth={1.5} aria-hidden />
            </button>
          ) : null}
          {showSwitch ? (
            <>
              <span className="flex w-4 justify-center">
                {locked ? <Lock size={14} strokeWidth={1.5} className="text-gray-500" role="img" aria-label={source.policy === "off" ? "Not allowed by your admin" : "On for everyone, set by your admin"} /> : null}
              </span>
              <DenSwitch size="sm" aria-label={source.name} checked={source.on} disabled={locked || saving}
                onChange={(on) => onChange({ sources: [{ source: source.id, on }] })} />
            </>
          ) : null}
        </span>
      </div>
      {steerable && editing ? (
        <div className="flex flex-col gap-1.5 pl-9">
          <DenTextarea rows={growRows(draft)} maxLength={AGENT_PREFERENCE_MAX} value={draft} disabled={saving} aria-label={`Instruction for ${source.name}`} autoFocus className={GROW}
            placeholder="Use my meeting notes for context and action items." onChange={(event) => setDraft(event.target.value)} />
          <span className="flex justify-end gap-2">
            <DenButton variant="secondary" size="xs" onClick={() => { setDraft(source.instruction); setEditing(false); }}>Cancel</DenButton>
            <DenButton size="xs" disabled={saving || draft.trim() === source.instruction.trim()} onClick={() => save(draft.trim())}>Save instruction</DenButton>
          </span>
        </div>
      ) : steerable && source.instruction ? (
        <div className="flex flex-col gap-0.5 pl-9" data-testid={`my-agent-source-instruction-${source.id}`}>
          <p className="text-[13px] leading-[18px] text-gray-700">{`“${source.instruction}”`}</p>
          <span className="text-[12px] leading-4 text-gray-500"><SourceChangeNote view={view} sourceId={source.id} field="sourceInstruction" now={now} /></span>
        </div>
      ) : null}
    </div>
  );
}

function hourRange(from: number, to: number): number[] {
  return Array.from({ length: Math.max(0, to - from + 1) }, (_, index) => from + index);
}

/** The page's layout while the agent loads: the focal line and sections where they will be. */
export function MyAgentPanelSkeleton({ library }: { library: string }) {
  return (
    <ItemPage testId="my-agent-screen">
      <ItemHeader compact logo={<AgentLogo size="lg" />} title="My bot" />
      <div className="flex flex-col gap-2 motion-safe:animate-pulse" role="status" aria-label="Loading your agent" data-testid="my-agent-skeleton">
        <span className="h-6 w-48 rounded bg-gray-100" />
        <span className="h-4 w-72 max-w-full rounded bg-gray-100" />
      </div>
      <ItemSection title="Today" variant="rule"><ItemRowsSkeleton label="Loading today's checks" rows={3} /></ItemSection>
    </ItemPage>
  );
}
