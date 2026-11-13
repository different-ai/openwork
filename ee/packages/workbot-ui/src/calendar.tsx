"use client";

import { useWorkbotConnect, WorkbotConnectAction } from "./connect";

import type { WorkbotViewContext } from "@openwork/types/workbot-context";
import {
  addDays,
  buildAutomationCalendarItems,
  CALENDAR_PROVIDER_LABEL,
  calendarRange,
  compareDates,
  dateKey,
  describeRunOutcome,
  describeSchedule,
  formatDate,
  formatInstant,
  formatRangeLabel,
  formatTime,
  localDateOf,
  nextOpenSlot,
  runPlacement,
  shiftAnchor,
  startOfDay,
  weekdayOf,
  zonedParts,
  type AutomationCalendarItem,
  type CalendarConnectionError,
  type CalendarEvent,
  type CalendarProviderId,
  type CalendarRange,
  type CalendarView,
  type LocalDate,
} from "@openwork/calendar";
import { Dialog } from "@base-ui/react/dialog";
import { AppMark } from "./files";
import { useMeetingsQuery, useRunsInRangeQuery } from "@openwork/calendar/react";
import type { AutomationList, AutomationModel, AutomationRun, AutomationSchedule } from "@openwork/types/automations";
import { ChevronLeft, ChevronRight, Cloud, Lock, Monitor, Plus, X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { CreateAutomationCard, type CreateAnchor } from "./calendar-create";
import { ModelPicker, ModelSummary } from "./model-picker";
import { workbotHost, useRetainedSurface } from "./host";
import { CalendarAgenda, QuietMonthDaySummary, QuietTimeGrid, useElementWidth, WorkbotStatusButton, WorkbotWeekPanel } from "./calendar-quiet";
import { calendarKey, useAutomationModels, useAutomationRuns, useCalendarAction, useCalendarSources, useRunReceipt, useWorkbotAutomations, type AutomationChanges } from "./calendar-data";

/**
 * Workbot's Calendar: the person's Automations next to their meetings, with the selected one's details and
 * Pause / Edit schedule / Run now. Layout and values follow the Paper file "WorkBot — one chat, set up once",
 * page v3, screens 4 and 4b. "Also watching" (event-triggered work) is not shown: Automations have no event
 * triggers yet. "Uses" and "Sends to" are not shown either: nothing records them reliably.
 */

type ListItem = AutomationList["items"][number];
type Selection = { kind: "automation"; automationId: string; itemKey: string | null } | { kind: "meeting"; key: string } | null;

const PROVIDERS: readonly CalendarProviderId[] = ["google", "microsoft"];
const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/* ── Icons (Paper: 11px in blocks, 13px in lists) ─────────────────────────────────────────────────────────── */

function Check({ size = 11, color = "#30A46C" }: { size?: number; color?: string }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className="shrink-0"><path d="M20 6 9 17l-5-5" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
function Cross({ size = 11 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className="shrink-0"><path d="M6 6l12 12M18 6 6 18" fill="none" stroke="#E5484D" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
function CloudIcon({ color }: { color: string }) {
  return <svg width="11" height="11" viewBox="0 0 24 24" aria-hidden className="shrink-0"><path d="M17.5 19a4.5 4.5 0 1 0-1.4-8.8A6 6 0 1 0 6 17.7" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /><path d="M6 19h11.5" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
function DesktopIcon({ color }: { color: string }) {
  return <svg width="11" height="11" viewBox="0 0 24 24" aria-hidden className="shrink-0"><rect x="3" y="4" width="18" height="12" rx="2" fill="none" stroke={color} strokeWidth="2" /><path d="M8 20h8M12 16v4" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" /></svg>;
}
function LockIcon({ size = 11 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className="shrink-0"><rect x="5" y="11" width="14" height="10" rx="2" fill="none" stroke="#687076" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /><path d="M8 11V7a4 4 0 0 1 8 0v4" fill="none" stroke="#687076" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
function Dash({ size = 11 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className="shrink-0"><path d="M6 12h12" fill="none" stroke="#687076" strokeWidth="2.25" strokeLinecap="round" /></svg>;
}

function StatusIcon({ item, selected }: { item: Pick<AutomationCalendarItem, "status" | "executionTarget">; selected?: boolean }) {
  const ink = selected ? "#E6EDF3" : "#011627";
  switch (item.status) {
    case "succeeded": return <Check color={selected ? "#E6EDF3" : "#30A46C"} />;
    case "failed": return <Cross />;
    case "blocked": return <LockIcon />;
    case "cancelled":
    case "skipped": return <Dash />;
    default: return item.executionTarget === "cloud" ? <CloudIcon color={ink} /> : <DesktopIcon color={ink} />;
  }
}

const STATUS_LABEL: Record<AutomationCalendarItem["status"], string> = {
  succeeded: "Completed", failed: "Failed", cancelled: "Cancelled", skipped: "Skipped", running: "Running", upcoming: "Scheduled", blocked: "Blocked until fixed",
};

function MeetingBlock({ event, selected, compact, onSelect }: { event: CalendarEvent; selected: boolean; compact: boolean; onSelect: () => void }) {
  const source = CALENDAR_PROVIDER_LABEL[event.provider] === "Outlook" ? "Outlook Calendar" : CALENDAR_PROVIDER_LABEL[event.provider];
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      aria-label={`${event.title}, ${source}${event.timing.kind === "timed" ? `, ${formatTime(event.timing.start, timeZone())}` : ", all day"}`}
      data-calendar-meeting={event.key}
      data-calendar-provider={event.provider}
      className={`flex h-full w-full flex-col gap-0.5 overflow-hidden rounded-md bg-white px-2 text-left focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)] ${compact ? "justify-center" : "py-1.5"} ${selected ? "shadow-[inset_0_0_0_1.5px_#011627]" : "shadow-[inset_0_0_0_1px_#D7DBDF]"}`}
    >
      <span className="flex min-w-0 items-start gap-1.5 text-[11px] font-semibold leading-3.5 text-[var(--wb-text)]">
        <span aria-hidden="true" data-calendar-provider-logo={event.provider}><AppMark name={event.provider === "google" ? "Google Calendar" : "Microsoft 365"} size={12} /></span>
        <span className={compact ? "min-w-0 flex-1 truncate" : "min-w-0 flex-1 line-clamp-2 break-words"}>{event.title}</span>
      </span>
    </button>
  );
}

/* ── Grid ──────────────────────────────────────────────────────────────────────────────────────────────── */

type DayBlock = { key: string; start: number; end: number; kind: "meeting"; event: CalendarEvent };

function blocksForDay(day: LocalDate, zone: string, meetings: readonly CalendarEvent[]): DayBlock[] {
  const dayStart = startOfDay(day, zone);
  const dayEnd = startOfDay(addDays(day, 1), zone);
  const blocks: DayBlock[] = [];
  for (const event of meetings) {
    if (event.timing.kind !== "timed" || event.timing.end <= dayStart || event.timing.start >= dayEnd) continue;
    blocks.push({ key: event.key, start: Math.max(event.timing.start, dayStart), end: Math.min(event.timing.end, dayEnd), kind: "meeting", event });
  }
  return blocks;
}

function allDayOn(event: CalendarEvent, day: LocalDate) {
  return event.timing.kind === "all_day" && compareDates(event.timing.startDate, day) <= 0 && compareDates(event.timing.endDate, day) > 0;
}

function MonthGrid(props: { range: CalendarRange; zone: string; now: number; anchorMonth: number; automations: AutomationCalendarItem[]; meetings: CalendarEvent[]; selection: Selection; onSelect: (selection: Selection) => void; onOpenDay: (day: LocalDate) => void; }) {
  const today = localDateOf(props.now, props.zone);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-calendar-grid="month">
      <div className="grid grid-cols-7 border-b border-[#01162712]">
        {props.range.days.slice(0, 7).map((day) => <div key={`h-${dateKey(day)}`} className="h-11 px-2.5 pt-3.5 text-[12px] font-medium leading-4 text-[#687076]">{formatDate(day, "en-US", { weekday: "short" })}</div>)}
      </div>
      <div className="grid grid-cols-7">
        {props.range.days.map((day) => {
          const entries = [
            ...props.meetings.filter((event) => allDayOn(event, day)).map((event) => ({ kind: "meeting" as const, key: event.key, event })),
            ...blocksForDay(day, props.zone, props.meetings).sort((left, right) => left.start - right.start),
          ];
          const isToday = compareDates(day, today) === 0;
          return (
            <div key={`m-${dateKey(day)}`} className={`flex min-h-28 min-w-0 flex-col gap-1 border-b border-l border-[#0116270F] p-1.5 ${day.month === props.anchorMonth ? "" : "bg-[#F8F9FA]"}`}>
              <button type="button" onClick={() => props.onOpenDay(day)} className={`self-start rounded-full px-1.5 text-[12px] font-semibold leading-5 ${isToday ? "bg-[#011627] text-[#E6EDF3]" : day.month === props.anchorMonth ? "text-black" : "text-[#9BA1A6]"}`}>{day.day}</button>
              {entries.slice(0, 3).map((entry) => (
                <div key={entry.key} className="h-6.5">
                  <MeetingBlock event={entry.event} compact selected={props.selection?.kind === "meeting" && props.selection.key === entry.event.key} onSelect={() => props.onSelect({ kind: "meeting", key: entry.event.key })} />
                </div>
              ))}
              {entries.length > 3 ? <button type="button" onClick={() => props.onOpenDay(day)} className="self-start px-1 text-[11px] text-[#687076] hover:text-black">{entries.length - 3} more</button> : null}
              <span className="px-1"><QuietMonthDaySummary items={props.automations} day={day} zone={props.zone} /></span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── Detail panel ──────────────────────────────────────────────────────────────────────────────────────── */

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-9 items-start border-b border-[var(--wb-hairline)] py-2">
      <span className="w-24 shrink-0 text-[12px] leading-4 text-[var(--wb-muted)]">{label}</span>
      <span className="min-w-0 flex-1 break-words text-[13px] leading-4 text-[var(--wb-text)]">{children}</span>
    </div>
  );
}

function shortDate(instant: number, zone: string) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: zone }).format(new Date(instant));
}

function RunIcon({ run }: { run: AutomationRun }) {
  if (run.status === "succeeded") return <Check size={13} />;
  if (run.status === "failed") return <Cross size={13} />;
  return <Dash size={13} />;
}

function PastRun({ run, zone }: { run: AutomationRun; zone: string }) {
  const [open, setOpen] = useState(false);
  const receipt = useRunReceipt(open ? run.id : null);
  const detail = receipt.data?.run.resultSummary ?? receipt.data?.run.error?.message ?? null;
  return (
    <li className="flex flex-col" data-calendar-past-run={run.id}>
      <div className="flex min-h-8.5 shrink-0 items-start gap-2.5 py-2">
        <span className="mt-0.5 shrink-0"><RunIcon run={run} /></span>
        <span className="w-22.5 shrink-0 text-[13px] leading-4 text-[var(--wb-text)]">{shortDate(runPlacement(run), zone)}</span>
        <span data-calendar-run-outcome data-calendar-run-status={run.status} className="min-w-0 flex-1 break-words text-[12px] leading-4 text-[var(--wb-muted)]">{describeRunOutcome(run)}</span>
        <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} className="shrink-0 rounded text-[12px] font-medium leading-4 text-[var(--wb-text)] hover:underline focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]">{open ? "Close" : "Open"}</button>
      </div>
      {open ? (
        <p className="mb-2 ml-[23px] whitespace-pre-wrap rounded-md bg-[#F4F6F7] px-2.5 py-2 text-[12px] leading-4 text-[#11181C]">
          {receipt.isLoading ? "Loading…" : detail ?? "No result was recorded for this run."}
        </p>
      ) : null}
    </li>
  );
}

const WEEKDAYS = [["Mon", 1], ["Tue", 2], ["Wed", 3], ["Thu", 4], ["Fri", 5], ["Sat", 6], ["Sun", 0]] as const;

function ScheduleFields({ draft, setDraft }: { draft: AutomationSchedule; setDraft: (schedule: AutomationSchedule) => void }) {
  const clock = draft.kind === "daily" || draft.kind === "weekly" ? draft : null;
  const time = clock ? `${String(clock.hour).padStart(2, "0")}:${String(clock.minute).padStart(2, "0")}` : null;
  const setKind = (kind: "daily" | "weekly") => {
    const hour = clock ? clock.hour : draft.kind === "interval" ? draft.startHour : 9;
    const minute = clock ? clock.minute : 0;
    setDraft(kind === "daily" ? { kind, timezone: draft.timezone, hour, minute } : { kind, timezone: draft.timezone, hour, minute, daysOfWeek: draft.kind === "weekly" || draft.kind === "interval" ? draft.daysOfWeek : [1, 2, 3, 4, 5] });
  };
  return (
    <>
      {draft.kind === "once" ? (
        <p className="text-[13px] text-[#687076]">This runs once, {formatInstant(draft.at, draft.timezone)}. Change it to repeat:</p>
      ) : draft.kind === "interval" || draft.kind === "calendar" ? (
        <p className="text-[13px] text-[#687076]">This runs {describeSchedule(draft, draft.timezone, "en-US").toLowerCase()}. Change it to run at one time:</p>
      ) : null}
      <div className="flex rounded-lg bg-[#F1F3F5] p-0.5" role="radiogroup" aria-label="Repeats">
        {(["daily", "weekly"] as const).map((kind) => (
          <button key={kind} type="button" role="radio" aria-checked={draft.kind === kind} onClick={() => setKind(kind)} className={`h-6.5 flex-1 rounded-md text-[12px] leading-4 ${draft.kind === kind ? "bg-white font-semibold text-black shadow-[0_0_0_1px_var(--wb-ring)]" : "font-medium text-[#687076]"}`}>
            {kind === "daily" ? "Every day" : "Some days"}
          </button>
        ))}
      </div>
      {draft.kind === "weekly" ? (
        <div className="flex flex-wrap gap-1.5" aria-label="Days">
          {WEEKDAYS.map(([label, value]) => {
            const on = draft.daysOfWeek.includes(value);
            return (
              <button key={label} type="button" aria-pressed={on} onClick={() => {
                const days = on ? draft.daysOfWeek.filter((day) => day !== value) : [...draft.daysOfWeek, value].sort((left, right) => left - right);
                if (days.length > 0) setDraft({ ...draft, daysOfWeek: days });
              }} className={`h-7 rounded-md px-2.5 text-[12px] font-medium ${on ? "bg-[#011627] text-[#E6EDF3]" : "text-black shadow-[0_0_0_1px_#0116271F]"}`}>{label}</button>
            );
          })}
        </div>
      ) : null}
      <div className="flex gap-2">
        <label className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-[12px] text-[#687076]">Time</span>
          <input type="time" value={time ?? "09:00"} onChange={(event) => {
            const [hour, minute] = event.currentTarget.value.split(":").map(Number);
            if (Number.isInteger(hour) && Number.isInteger(minute)) setDraft(clock ? { ...clock, hour, minute } : { kind: "daily", timezone: draft.timezone, hour, minute });
          }} className="h-8 min-w-0 w-full rounded-md px-2 text-[13px] shadow-[0_0_0_1px_var(--wb-ring)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]" />
        </label>
        <label className="flex min-w-0 flex-[1.4] flex-col gap-1">
          <span className="text-[12px] text-[#687076]">Time zone</span>
          <input value={draft.timezone} onChange={(event) => setDraft({ ...draft, timezone: event.currentTarget.value })} className="h-8 min-w-0 w-full rounded-md px-2 text-[13px] shadow-[0_0_0_1px_var(--wb-ring)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]" />
        </label>
      </div>
    </>
  );
}

function FieldLabel({ children }: { children: ReactNode }) {
  return <span className="text-[12px] font-medium leading-4 text-[#11181C]">{children}</span>;
}

/** Where it runs, read-only: Workbot creates and keeps Automations in the cloud; desktop ones move from the app. */
function RunsOnCard({ target }: { target: "desktop" | "cloud" }) {
  return (
    <div className="flex items-start gap-2.5 rounded-lg px-3 py-2.5 shadow-[inset_0_0_0_1px_#0116271A]" data-calendar-runs-on={target}>
      <span className="mt-0.5 text-[#011627]">{target === "cloud" ? <Cloud size={15} strokeWidth={1.75} aria-hidden /> : <Monitor size={15} strokeWidth={1.75} aria-hidden />}</span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[13px] font-medium leading-4.5 text-black">{target === "cloud" ? "Cloud: Only connected accounts" : "Desktop: Connected accounts and files on your computer"}</span>
        <span className="text-[12px] leading-4 text-[#687076]">{target === "cloud" ? "Runs in the cloud, even when your computer is off." : "Needs OpenWork open on one of your computers. Move it to the cloud from the OpenWork app."}</span>
      </span>
    </div>
  );
}

/**
 * Edit an Automation: what it does, when it repeats, where it runs and its model. Only what changed is sent;
 * Den's Workbot allowlist accepts the name, schedule, instructions and model.
 */
function EditDialog({ item, busy, onClose, onSave }: { item: ListItem; busy: boolean; onClose: () => void; onSave: (changes: AutomationChanges) => void }) {
  const surface = useRetainedSurface(true);
  const { revision } = item;
  const target = revision.executionTarget ?? "desktop";
  const agent = revision.action?.kind !== "saved_script";
  const { models, isLoading } = useAutomationModels({ includeCloudDefault: target === "cloud" && workbotHost().canSchedule === true });
  const [schedule, setSchedule] = useState<AutomationSchedule>(revision.schedule);
  const [instructions, setInstructions] = useState(revision.instructions);
  const [model, setModel] = useState<AutomationModel>(revision.model);
  const changes: AutomationChanges = {
    ...(JSON.stringify(schedule) !== JSON.stringify(revision.schedule) ? { schedule } : {}),
    ...(agent && instructions.trim() !== revision.instructions ? { instructions: instructions.trim() } : {}),
    ...(agent && (model.providerId !== revision.model.providerId || model.modelId !== revision.model.modelId) ? { model } : {}),
  };
  const changed = Object.keys(changes).length > 0;
  return (
    <Dialog.Root open={surface.open} onOpenChange={(open) => { if (!surface.blocked && !open) onClose(); }}>
      <Dialog.Portal {...surface.portal}>
        <Dialog.Backdrop className="workbot fixed inset-0 z-50 bg-[var(--wb-ink)]/20" />
        <Dialog.Popup
          data-calendar-edit={item.automation.id}
          className="workbot fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-24px)] w-[calc(100vw-24px)] max-w-md -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl bg-[var(--wb-surface)] text-[var(--wb-text)] shadow-[var(--wb-panel-shadow)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]"
        >
          <form className="flex min-h-0 flex-col" onSubmit={(event) => { event.preventDefault(); if (changed) onSave(changes); else onClose(); }}>
            <div className="flex shrink-0 items-center justify-between px-4 pb-3 pt-4 sm:px-5 sm:pt-5">
              <Dialog.Title render={<h2 />} className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--wb-text)]">Edit automation</Dialog.Title>
              <Dialog.Close aria-label="Close" className="grid size-7 place-items-center rounded-[7px] text-[var(--wb-muted)] hover:bg-[var(--wb-chip)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]"><X size={15} strokeWidth={1.75} /></Dialog.Close>
            </div>
            <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-4 pb-1 sm:px-5" data-calendar-form-body>
              {agent ? (
                <label className="flex flex-col gap-1.5">
                  <FieldLabel>Instructions</FieldLabel>
                  <textarea
                    value={instructions}
                    rows={4}
                    maxLength={100_000}
                    onChange={(event) => setInstructions(event.currentTarget.value)}
                    className="min-h-24 resize-y rounded-lg bg-[var(--wb-surface)] px-2.5 py-2 text-[13px] leading-[19px] text-[var(--wb-text)] shadow-[inset_0_0_0_1px_var(--wb-ring)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]"
                  />
                </label>
              ) : null}
              <div className="flex flex-col gap-2">
                <FieldLabel>Repeats</FieldLabel>
                <ScheduleFields draft={schedule} setDraft={setSchedule} />
              </div>
              <div className="flex flex-col gap-1.5">
                <FieldLabel>Where it runs</FieldLabel>
                <RunsOnCard target={target} />
              </div>
              {agent ? (
                <div className="flex flex-col gap-1.5">
                  <FieldLabel>Model</FieldLabel>
                  <ModelPicker value={model} options={models} loading={isLoading} onChange={setModel} />
                </div>
              ) : null}
            </div>
            <div className="flex shrink-0 gap-2 p-4 sm:p-5" data-calendar-form-actions>
              <Dialog.Close className="h-8.5 flex-1 rounded-lg text-[13px] font-medium text-[var(--wb-text)] shadow-[0_0_0_1px_var(--wb-ring)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]">Cancel</Dialog.Close>
              <button type="submit" disabled={busy || !changed || (agent && !instructions.trim())} className="h-8.5 flex-1 rounded-lg bg-[var(--wb-ink)] text-[13px] font-medium text-[var(--wb-on-ink)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)] disabled:opacity-50">{busy ? "Saving…" : "Save changes"}</button>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function PanelClose({ onClose }: { onClose?: () => void }) {
  return onClose ? <button type="button" onClick={onClose} aria-label="Close" className="grid size-7 shrink-0 place-items-center rounded-[7px] text-[var(--wb-muted)] hover:bg-[var(--wb-chip)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]"><X size={15} strokeWidth={1.75} aria-hidden /></button> : null;
}

function AutomationPanel({ item, block, zone, onToast, onClose }: { item: ListItem; block: AutomationCalendarItem | null; zone: string; onToast: (text: string) => void; onClose?: () => void }) {
  const { automation, revision } = item;
  const runs = useAutomationRuns(automation.id);
  const action = useCalendarAction();
  const [editing, setEditing] = useState(false);
  const { models: panelModels } = useAutomationModels({ includeCloudDefault: (revision.executionTarget ?? "desktop") === "cloud" });
  const blocked = automation.state === "needs_attention";
  const when = block?.run ? formatInstant(runPlacement(block.run), zone) : block ? formatInstant(block.at, zone) : automation.nextDueAt ? formatInstant(automation.nextDueAt, zone) : null;
  const run = (kind: "pause" | "resume" | "run", done: string) => action.mutate({ kind, automationId: automation.id }, {
    onSuccess: () => onToast(done),
    onError: (error) => onToast(error.message),
  });
  return (
    <aside className="flex w-full min-w-0 shrink-0 flex-col gap-4.5 border-t border-[var(--wb-hairline)] bg-[var(--wb-surface)] p-4 lg:w-95 lg:overflow-y-auto lg:border-l lg:border-t-0 lg:p-6" aria-label={automation.name} data-calendar-detail={automation.id}>
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-[12px] leading-4 text-[#687076]" data-calendar-next-run>
            {block?.status === "failed" ? `Failed ${when ?? ""}`.trim() : blocked ? "Not scheduled until fixed" : automation.state === "inactive" ? "Paused" : when ?? "No run scheduled"}
          </span>
          <h2 className="text-[18px] font-semibold leading-5.5 tracking-[-0.015em] text-black">{automation.name}</h2>
        </div>
        <PanelClose onClose={onClose} />
      </div>
      {blocked && automation.needsAttentionReason ? (
        <div className="flex items-start gap-2 rounded-lg bg-[var(--wb-tray)] px-3 py-2.5" data-calendar-blocked>
          <span className="mt-0.5"><LockIcon size={13} /></span>
          <span data-calendar-recovery className="min-w-0 break-words text-[13px] leading-4.5 text-[var(--wb-text)]">{automation.needsAttentionReason.message}</span>
        </div>
      ) : null}
      <div className="flex flex-col border-t border-[#0116270F]">
        <Row label="Repeats">{describeSchedule(revision.schedule, "", "en-US")}</Row>
        <Row label="Runs on">{(revision.executionTarget ?? "desktop") === "cloud" ? "The cloud. Your laptop can be closed." : "Your desktop. Keep OpenWork open at that time."}</Row>
        {revision.action?.kind === "saved_script" ? null : (
          <>
            <Row label="Model"><ModelSummary model={revision.model} options={panelModels} /></Row>
            <Row label="Instructions"><span className="line-clamp-4 whitespace-pre-line" data-calendar-instructions>{revision.instructions}</span></Row>
          </>
        )}
      </div>
      <div className="flex min-h-0 flex-col">
        <h3 className="mb-1 text-[12px] font-semibold leading-4 text-black">Past runs</h3>
        {runs.isLoading ? <div className="h-8.5 animate-pulse rounded bg-[#F1F3F5]" /> : null}
        {runs.data && runs.data.items.length === 0 ? <p className="text-[12px] leading-4 text-[#687076]">No runs yet.</p> : null}
        <ul className="flex flex-col overflow-y-auto" data-calendar-past-runs>
          {runs.data?.items.slice(0, 5).map((entry) => <PastRun key={entry.id} run={entry} zone={zone} />)}
        </ul>
      </div>
      <div className="flex-1" />
      <div className="flex gap-2">
        {automation.state === "inactive" ? (
          <button type="button" disabled={action.isPending} onClick={() => run("resume", "Resumed")} className="h-8.5 flex-1 rounded-lg text-[13px] font-medium text-black shadow-[0_0_0_1px_#0116271F] hover:bg-[#F4F6F7] disabled:opacity-60">Resume</button>
        ) : (
          <button type="button" disabled={action.isPending || automation.state !== "active"} onClick={() => run("pause", "Paused")} className="h-8.5 flex-1 rounded-lg text-[13px] font-medium text-black shadow-[0_0_0_1px_#0116271F] hover:bg-[#F4F6F7] disabled:opacity-50">Pause</button>
        )}
        <button type="button" disabled={action.isPending} onClick={() => setEditing(true)} className="h-8.5 flex-1 rounded-lg text-[13px] font-medium text-black shadow-[0_0_0_1px_#0116271F] hover:bg-[#F4F6F7] disabled:opacity-60">Edit</button>
        <button type="button" disabled={action.isPending || blocked} title={blocked ? "Fix what it needs first" : undefined} onClick={() => run("run", "Running now")} className="h-8.5 flex-1 rounded-lg bg-[#011627] text-[13px] font-medium text-[#E6EDF3] hover:opacity-90 disabled:opacity-50">Run now</button>
      </div>
      {editing ? (
        <EditDialog
          item={item}
          busy={action.isPending}
          onClose={() => setEditing(false)}
          onSave={(changes) => action.mutate({ kind: "edit", automationId: automation.id, changes }, {
            onSuccess: () => { setEditing(false); onToast("Automation updated"); },
            onError: (error) => onToast(error.message),
          })}
        />
      ) : null}
    </aside>
  );
}

function MeetingPanel({ event, zone, runs = [], onSelectRun, onClose }: { event: CalendarEvent; zone: string; /** Workbot runs that were about this meeting (`triggerContext.eventId`). */ runs?: AutomationCalendarItem[]; onSelectRun?: (item: AutomationCalendarItem) => void; onClose?: () => void }) {
  const source = event.provider === "google" ? "Google Calendar" : "Outlook Calendar";
  const when = event.timing.kind === "timed"
    ? `${formatInstant(event.timing.start, zone)} – ${formatTime(event.timing.end, zone)}`
    : `${formatDate(event.timing.startDate, "en-US")} · All day`;
  return (
    <aside className="flex w-full min-w-0 shrink-0 flex-col gap-4.5 border-t border-[var(--wb-hairline)] bg-[var(--wb-surface)] p-4 lg:w-95 lg:overflow-y-auto lg:border-l lg:border-t-0 lg:p-6" aria-label={event.title} data-calendar-meeting-detail={event.key}>
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-[12px] leading-4 text-[#687076]">{when}</span>
          <h2 className="text-[18px] font-semibold leading-5.5 tracking-[-0.015em] text-black">{event.title}</h2>
        </div>
        <PanelClose onClose={onClose} />
      </div>
      <div className="flex flex-col border-t border-[#0116270F]">
        <Row label="From">{source}</Row>
        {event.location ? <Row label="Where">{event.location}</Row> : null}
        {event.attendeeCount > 0 ? <Row label="Guests">{event.attendeeCount}</Row> : null}
      </div>
      {runs.length ? (
        <div className="flex flex-col" data-calendar-meeting-runs>
          <h3 className="mb-1 text-[12px] font-semibold leading-4 text-black">Workbot for this meeting</h3>
          {runs.map((item) => (
            <button key={item.key} type="button" onClick={() => onSelectRun?.(item)} className="flex items-center gap-2.5 border-b border-[var(--wb-row-line)] py-2 text-left last:border-b-0 focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]">
              <StatusIcon item={item} />
              <span className="min-w-0 flex-1 truncate text-[13px] leading-4 text-[var(--wb-text)]">{item.name}</span>
              <span className="shrink-0 text-[12px] text-[var(--wb-muted)]">{STATUS_LABEL[item.status]}</span>
            </button>
          ))}
        </div>
      ) : null}
      <div className="flex-1" />
      <div className="flex gap-2">
        {event.meetingUrl ? <a href={event.meetingUrl} target="_blank" rel="noreferrer" className="flex h-8.5 flex-1 items-center justify-center rounded-lg text-[13px] font-medium text-black shadow-[0_0_0_1px_#0116271F]">Join</a> : null}
        {event.sourceUrl ? <a href={event.sourceUrl} target="_blank" rel="noreferrer" className="flex h-8.5 flex-1 items-center justify-center rounded-lg bg-[#011627] text-[13px] font-medium text-[#E6EDF3]">Open in {source}</a> : null}
      </div>
    </aside>
  );
}

/* ── Page ──────────────────────────────────────────────────────────────────────────────────────────────── */

function blockedLabel(error: CalendarConnectionError) {
  const name = error.provider === "google" ? "Google Calendar" : "Outlook Calendar";
  if (error.kind === "auth_expired") return `Reconnect ${name}`;
  if (error.kind === "not_connected") return `Connect ${name}`;
  if (error.kind === "permission_missing") return `${name} needs calendar access`;
  if (error.kind === "policy_blocked") return `${name} is blocked by your organization`;
  return null;
}

function weekdaysOnly(days: LocalDate[], meetings: CalendarEvent[], zone: string) {
  const weekend = days.filter((day) => weekdayOf(day) === 0 || weekdayOf(day) === 6);
  const busy = weekend.some((day) => blocksForDay(day, zone, meetings).length > 0 || meetings.some((event) => allDayOn(event, day)));
  return busy ? days : days.filter((day) => weekdayOf(day) !== 0 && weekdayOf(day) !== 6);
}

export function WorkbotCalendar({ connectionsHref, assistantName, onContextChange }: { connectionsHref: string | null; assistantName: string; onContextChange?(context: WorkbotViewContext | null): void }) {
  const zone = timeZone();
  const sources = useCalendarSources();
  const connect = useWorkbotConnect();
  const [now, setNow] = useState(() => Date.now());
  const [view, setView] = useState<CalendarView>("week");
  const [anchor, setAnchor] = useState<LocalDate>(() => localDateOf(Date.now(), zone));
  const [selection, setSelection] = useState<Selection>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [creating, setCreating] = useState<CreateAnchor | null>(null);
  // Meetings own the grid, runs are dots, the Workbot panel opens on demand, narrow widths get an agenda.

  const [agenda, setAgenda] = useState(false);
  const [weekPanel, setWeekPanel] = useState(false);
  const runAction = useCalendarAction();
  const width = useElementWidth<HTMLDivElement>();
  const narrow = width.width !== null && width.width < 760;
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 3_000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const { year, month, day } = anchor;
  const range = useMemo(() => calendarRange(view, { year, month, day }, zone, 1), [day, month, view, year, zone]);
  const list = useWorkbotAutomations();
  const runs = useRunsInRangeQuery({ keyPrefix: calendarKey, source: sources.runs, range, automations: list.data?.items, enabled: true });
  const google = useMeetingsQuery({ keyPrefix: calendarKey, provider: "google", transport: sources.transport, range, enabled: true });
  const microsoft = useMeetingsQuery({ keyPrefix: calendarKey, provider: "microsoft", transport: sources.transport, range, enabled: true });
  const meetingQueries = { google, microsoft };

  const items = useMemo(() => list.data && runs.data
    ? buildAutomationCalendarItems({ automations: list.data.items, runs: runs.data.runs, range, now })
    : [], [list.data, now, range, runs.data]);
  const meetings = useMemo(() => [...(google.data?.events ?? []), ...(microsoft.data?.events ?? [])], [google.data, microsoft.data]);

  // The quiet calendar keeps a weekend only for its meetings: runs there are counted in Workbot's panel.
  const days = view === "week" ? weekdaysOnly(range.days, meetings, zone) : range.days;
  const selectedItem = selection?.kind === "automation" ? list.data?.items.find((entry) => entry.automation.id === selection.automationId) ?? null : null;
  const selectedBlock = selection?.kind === "automation" ? items.find((item) => item.key === selection.itemKey) ?? null : null;
  const selectedMeeting = selection?.kind === "meeting" ? meetings.find((event) => event.key === selection.key) ?? null : null;
  useEffect(() => {
    const selected = selectedMeeting
      ? { kind: "meeting" as const, provider: selectedMeeting.provider, id: selectedMeeting.providerEventId, title: selectedMeeting.title.slice(0, 512) || "Untitled event" }
      : selectedItem ? { kind: "automation" as const, id: selectedItem.automation.id, title: selectedItem.automation.name.slice(0, 512) || "Untitled automation" } : undefined;
    onContextChange?.({ kind: "calendar", view, start: range.start, end: range.end, timeZone: zone, ...(selected ? { selected } : {}) });
  }, [onContextChange, selectedMeeting, selectedItem, view, range.start, range.end, zone]);
  const connected = PROVIDERS.filter((provider) => meetingQueries[provider].data);
  const label = view === "week" && days.length === 5 ? `${formatDate(days[0]!, "en-US", { month: "short", day: "numeric" })} – ${days[4]!.month === days[0]!.month ? formatDate(days[4]!, "en-US", { day: "numeric" }) : formatDate(days[4]!, "en-US", { month: "short", day: "numeric" })}` : formatRangeLabel(range, anchor, "en-US");
  const nowParts = zonedParts(now, zone);
  const providerStatuses = PROVIDERS.filter((provider) => {
    const error = meetingQueries[provider].error;
    return error && !(error.kind === "not_connected" && connected.length > 0) && error.kind !== "unsupported";
  });
  // Both providers can lack a catalog match. Their generic account/settings fallback is shared,
  // but known accounts must keep their own Connect/Reconnect actions.
  const unverifiedAccounts = connect.connections.isSuccess ? providerStatuses.filter((provider) => {
    const error = meetingQueries[provider].error;
    const nativeProvider = provider === "google" ? "google-workspace" : "microsoft-365";
    return (error?.kind === "not_connected" || error?.kind === "auth_expired")
      && !connect.connections.data?.some((connection) => connection.nativeProviderKey === nativeProvider);
  }) : [];

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden" data-calendar-page>
      <div ref={width.ref} className="flex h-[max(24rem,calc(100dvh-4rem))] min-w-0 shrink-0 flex-col px-3 pt-4 sm:px-5 lg:h-auto lg:min-h-0 lg:flex-1 lg:pr-7 lg:pt-6">
        <div className="mb-3 flex shrink-0 flex-col gap-3 sm:pl-2 xl:flex-row xl:flex-wrap xl:items-center xl:justify-between" data-calendar-toolbar>
          <div className="flex flex-wrap items-center justify-between gap-2 xl:justify-start">
            <div className="flex min-w-0 items-center gap-2">
              <h2 className="text-[18px] font-semibold leading-6 tracking-[-0.015em] text-[var(--wb-text)] sm:text-[20px]" data-calendar-range-label>{label}</h2>
              <div className="flex shrink-0 gap-0.5">
                <button type="button" aria-label="Previous" onClick={() => setAnchor((current) => shiftAnchor(view, current, -1))} className="grid size-7 place-items-center rounded-[7px] text-[#687076] hover:bg-[#F1F3F5]"><ChevronLeft size={15} strokeWidth={1.75} /></button>
                <button type="button" aria-label="Next" onClick={() => setAnchor((current) => shiftAnchor(view, current, 1))} className="grid size-7 place-items-center rounded-[7px] text-[#687076] hover:bg-[#F1F3F5]"><ChevronRight size={15} strokeWidth={1.75} /></button>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                data-calendar-new
                onClick={(event) => {
                  const box = event.currentTarget.getBoundingClientRect();
                  setCreating({ slot: nextOpenSlot(Date.now(), zone), x: box.left, y: box.bottom + 8 });
                }}
                className="flex h-7 items-center gap-1.25 rounded-[7px] px-2.5 text-[12px] font-medium text-[var(--wb-text)] shadow-[0_0_0_1px_var(--wb-ring)] hover:bg-[var(--wb-chip)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]"
              >
                <Plus size={12} strokeWidth={2} aria-hidden />New automation
              </button>
              <button type="button" data-calendar-today disabled={compareDates(anchor, { year: nowParts.year, month: nowParts.month, day: nowParts.day }) === 0} onClick={() => setAnchor(localDateOf(Date.now(), zone))} className="h-7 rounded-[7px] px-2.5 text-[12px] font-medium text-[var(--wb-text)] shadow-[0_0_0_1px_var(--wb-ring)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)] disabled:text-[var(--wb-muted)]">Today</button>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {providerStatuses.map((provider) => {
              const error = meetingQueries[provider].error;
              const text = error ? blockedLabel(error) : null;
              if (!error || (unverifiedAccounts.includes(provider) && provider !== unverifiedAccounts[0])) return null;
              return (
                <span key={provider} className="flex items-center gap-1 text-[12px] leading-4 text-[#687076]" data-calendar-provider-status={provider} data-state={error.kind} title={error.message}>
                  <Lock size={11} strokeWidth={2} aria-hidden />
                  {text && (error.kind === "not_connected" || error.kind === "auth_expired") ? <WorkbotConnectAction flow={connect} provider={provider === "google" ? "google-workspace" : "microsoft-365"} label={text} fallbackHref={connectionsHref} />
                    : text ? <span>{text}</span>
                    : <button type="button" onClick={() => void meetingQueries[provider].refetch()} className="font-medium text-black hover:underline">Couldn&apos;t load {provider === "google" ? "Google Calendar" : "Outlook"} · Try again</button>}
                </span>
              );
            })}
            {list.data ? <span className="ml-auto"><WorkbotStatusButton items={items} list={list.data.items} open={weekPanel && !selection} onToggle={() => { if (selection) { setSelection(null); setWeekPanel(true); } else setWeekPanel((open) => !open); }} /></span> : null}
            <div className={`flex shrink-0 rounded-lg bg-[#F1F3F5] p-0.5`} role="radiogroup" aria-label="Calendar view">
              {((["agenda", "week", "month"] as const)).map((option) => {
                const checked = (option === "agenda" ? agenda || narrow : !agenda && !narrow && view === option);
                return (
                  <button key={option} type="button" role="radio" aria-checked={checked} onClick={() => { if (option === "agenda") { setAgenda(true); setView("week"); } else { setAgenda(false); setView(option); } }} className={`flex h-6.5 items-center px-2.5 text-[12px] leading-4 ${checked ? "rounded-md bg-white font-semibold text-black shadow-[0_0_0_1px_var(--wb-ring)]" : "font-medium text-[#687076]"}`}>
                    {option === "agenda" ? "Agenda" : option === "week" ? "Week" : "Month"}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
        {list.isError ? (
          <p className="pl-2 text-[13px] text-[#687076]" role="alert">Couldn&apos;t load your automations. <button type="button" className="font-medium text-black hover:underline" onClick={() => void list.refetch()}>Try again</button></p>
        ) : null}
        {list.isLoading ? (
          <div className="flex flex-1 flex-col gap-2 pl-14 pt-12" aria-busy="true">
            {Array.from({ length: 6 }, (_, index) => <div key={index} className="h-14.5 animate-pulse rounded bg-[#F4F6F7]" />)}
          </div>
        ) : (agenda || narrow) ? (
          <CalendarAgenda days={range.days} zone={zone} now={now} automations={items} meetings={meetings} list={list.data?.items ?? []} selection={selection} onSelect={setSelection} busy={runAction.isPending} onRunNow={(automationId) => runAction.mutate({ kind: "run", automationId }, { onSuccess: () => setToast("Running now"), onError: (error) => setToast(error.message) })} />
        ) : view === "month" ? (
          <MonthGrid range={range} zone={zone} now={now} anchorMonth={anchor.month} automations={items} meetings={meetings} selection={selection} onSelect={setSelection} onOpenDay={(target) => { setAnchor(target); setView("week"); }} />
        ) : (
          <QuietTimeGrid range={range} days={days} zone={zone} now={now} automations={items} meetings={meetings} selection={selection} onSelect={setSelection} />
        )}
        {list.data && list.data.items.every((entry) => entry.automation.state === "archived") ? (
          <p className="py-4 pl-16 text-[13px] text-[#687076]" data-calendar-empty>No automations yet. Ask in Home to set up something that repeats.</p>
        ) : null}
      </div>
      {selectedItem ? <AutomationPanel key={selectedItem.automation.id} item={selectedItem} block={selectedBlock} zone={zone} onToast={setToast} onClose={() => setSelection(null)} />
        : selectedMeeting ? <MeetingPanel event={selectedMeeting} zone={zone} runs={items.filter((item) => item.run?.triggerContext?.eventId === selectedMeeting.providerEventId)} onSelectRun={(item) => setSelection({ kind: "automation", automationId: item.automationId, itemKey: item.key })} onClose={() => setSelection(null)} />
        : (weekPanel && list.data ? <WorkbotWeekPanel days={range.days.length <= 7 ? range.days : days.slice(0, 7)} zone={zone} now={now} title={view === "month" ? "Workbot this month" : "Workbot this week"} items={items} list={list.data.items} onSelect={setSelection} busy={runAction.isPending} onRunNow={(automationId) => runAction.mutate({ kind: "run", automationId }, { onSuccess: () => setToast("Running now"), onError: (error) => setToast(error.message) })} onClose={() => setWeekPanel(false)} /> : null)}
      {creating ? (
        <CreateAutomationCard
          key={creating.slot.at}
          anchor={creating}
          assistantName={assistantName}
          canSchedule={workbotHost().canSchedule === true}
          onClose={() => setCreating(null)}
          onCreated={(automationId) => {
            setCreating(null);
            setSelection({ kind: "automation", automationId, itemKey: null });
            setToast("Automation created");
          }}
        />
      ) : null}
      {toast ? (
        <div role="status" className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-[#011627] px-4 py-2 text-[13px] font-medium text-[#E6EDF3] shadow-[var(--wb-panel-shadow)]">{toast}</div>
      ) : null}
    </div>
  );
}
