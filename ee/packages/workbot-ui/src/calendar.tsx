"use client";

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
  layoutOverlappingBlocks,
  localDateOf,
  minutesIntoDay,
  nextOpenSlot,
  runPlacement,
  shiftAnchor,
  slotAt,
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
import { useMeetingsQuery, useRunsInRangeQuery } from "@openwork/calendar/react";
import type { AutomationList, AutomationRun, AutomationSchedule } from "@openwork/types/automations";
import { ChevronLeft, ChevronRight, Lock, Plus, X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { CreateAutomationCard, type CreateAnchor } from "./calendar-create";
import { workbotHost } from "./host";
import { calendarKey, useAutomationRuns, useCalendarAction, useCalendarSources, useRunReceipt, useWorkbotAutomations } from "./calendar-data";

/**
 * Workbot's Calendar: the person's Automations next to their meetings, with the selected one's details and
 * Pause / Edit schedule / Run now. Layout and values follow the Paper file "WorkBot — one chat, set up once",
 * page v3, screens 4 and 4b. "Also watching" (event-triggered work) is not shown: Automations have no event
 * triggers yet. "Uses" and "Sends to" are not shown either: nothing records them reliably.
 */

type ListItem = AutomationList["items"][number];
type Selection = { kind: "automation"; automationId: string; itemKey: string | null } | { kind: "meeting"; key: string } | null;

const HOUR_PX = 58;
const PROVIDERS: readonly CalendarProviderId[] = ["google", "microsoft"];
const DAY_START_HOUR = 8;
const DAY_END_HOUR = 18;
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

/* ── Blocks ─────────────────────────────────────────────────────────────────────────────────────────────── */

function blockTone(item: AutomationCalendarItem, selected: boolean) {
  if (selected) return "bg-[#011627] text-[#E6EDF3] shadow-[0_4px_12px_-4px_#01162759]";
  if (item.status === "blocked") return "bg-[#F1F3F5] text-[#687076] shadow-[inset_0_0_0_1px_#01162714]";
  if (item.status === "skipped" || item.status === "cancelled") return "bg-[#F1F3F5] text-[#687076]";
  if (item.status === "upcoming" || item.status === "running") return "bg-[#DCE6EF] text-[#011627]";
  return "bg-[#E6ECF1] text-[#011627]";
}

function AutomationBlock({ item, selected, subtitle, onSelect }: { item: AutomationCalendarItem; selected: boolean; subtitle: string | null; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      aria-label={`${item.name}, ${STATUS_LABEL[item.status]}, ${formatTime(item.at, timeZone())}`}
      data-calendar-automation={item.automationId}
      data-calendar-status={item.status}
      className={`flex h-full w-full flex-col gap-0.5 overflow-hidden rounded-md px-2 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)] ${subtitle ? "py-1.5" : "justify-center"} ${blockTone(item, selected)}`}
    >
      <span className="flex min-w-0 items-center gap-1.25">
        <StatusIcon item={item} selected={selected} />
        <span className="truncate text-[11px] font-semibold leading-3.5">{item.name}</span>
      </span>
      {subtitle ? <span className={`truncate text-[11px] leading-3.5 ${selected ? "text-[#AFC0CF]" : "text-[#687076]"}`}>{subtitle}</span> : null}
    </button>
  );
}

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
      <span className="truncate text-[11px] font-semibold leading-3.5 text-[#687076]">{event.title}</span>
      {compact ? null : <span className="truncate text-[11px] leading-3.5 text-[#687076]">{source}</span>}
    </button>
  );
}

/* ── Grid ──────────────────────────────────────────────────────────────────────────────────────────────── */

type DayBlock =
  | { key: string; start: number; end: number; kind: "automation"; item: AutomationCalendarItem }
  | { key: string; start: number; end: number; kind: "meeting"; event: CalendarEvent };

function blocksForDay(day: LocalDate, zone: string, automations: readonly AutomationCalendarItem[], meetings: readonly CalendarEvent[]): DayBlock[] {
  const dayStart = startOfDay(day, zone);
  const dayEnd = startOfDay(addDays(day, 1), zone);
  const blocks: DayBlock[] = [];
  for (const item of automations) if (item.at >= dayStart && item.at < dayEnd) blocks.push({ key: item.key, start: item.at, end: Math.min(item.end, dayEnd), kind: "automation", item });
  for (const event of meetings) {
    if (event.timing.kind !== "timed" || event.timing.end <= dayStart || event.timing.start >= dayEnd) continue;
    blocks.push({ key: event.key, start: Math.max(event.timing.start, dayStart), end: Math.min(event.timing.end, dayEnd), kind: "meeting", event });
  }
  return blocks;
}

function allDayOn(event: CalendarEvent, day: LocalDate) {
  return event.timing.kind === "all_day" && compareDates(event.timing.startDate, day) <= 0 && compareDates(event.timing.endDate, day) > 0;
}

function hourLabel(hour: number) {
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(2024, 0, 1, hour)));
}

function subtitleFor(item: AutomationCalendarItem, automations: readonly ListItem[]): string | null {
  if (item.status !== "blocked") return null;
  const reason = automations.find((entry) => entry.automation.id === item.automationId)?.automation.needsAttentionReason?.message ?? "Needs attention";
  return reason.split(/[.!]/)[0] ?? reason;
}

function TimeGrid(props: {
  range: CalendarRange; days: LocalDate[]; zone: string; now: number;
  automations: AutomationCalendarItem[]; meetings: CalendarEvent[]; list: readonly ListItem[];
  selection: Selection; onSelect: (selection: Selection) => void;
  /** Opens "New automation" at an empty slot; the card is placed near the click. */
  onCreateAt: (anchor: CreateAnchor) => void;
}) {
  const today = localDateOf(props.now, props.zone);
  const perDay = props.days.map((day) => {
    const blocks = blocksForDay(day, props.zone, props.automations, props.meetings);
    // Short items are drawn taller than their duration; lay them out by what is drawn so nothing overlaps.
    const drawn = blocks.map((block) => {
      const minutes = (block.kind === "meeting" || (block.kind === "automation" && block.item.status === "blocked") ? 57 : 27) * 60_000;
      return { key: block.key, start: block.start, end: Math.max(block.end, block.start + minutes) };
    });
    return { day, blocks, placements: layoutOverlappingBlocks(drawn) };
  });
  // Working hours, widened to whatever this range actually holds.
  let firstHour = DAY_START_HOUR;
  let lastHour = DAY_END_HOUR;
  for (const { day, blocks } of perDay) {
    for (const block of blocks) {
      firstHour = Math.min(firstHour, Math.floor(minutesIntoDay(block.start, day, props.zone) / 60));
      lastHour = Math.max(lastHour, Math.ceil(minutesIntoDay(block.end, day, props.zone) / 60));
    }
  }
  lastHour = Math.min(24, Math.max(lastHour, firstHour + 1));
  const hours = Array.from({ length: lastHour - firstHour }, (_, index) => firstHour + index);
  const top = (instant: number, day: LocalDate) => (minutesIntoDay(instant, day, props.zone) / 60 - firstHour) * HOUR_PX;
  const allDay = props.meetings.filter((event) => event.timing.kind === "all_day");
  const hasAllDay = props.days.some((day) => allDay.some((event) => allDayOn(event, day)));
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-calendar-grid={props.range.view}>
      <div className="flex border-b border-[#01162712] pl-14">
        {props.days.map((day) => {
          const isToday = compareDates(day, today) === 0;
          return (
            <div key={dateKey(day)} className="flex h-11 flex-1 basis-0 items-center gap-1.5 px-2.5" data-calendar-day={dateKey(day)}>
              <span className="text-[12px] font-medium leading-4 text-[#687076]">{formatDate(day, "en-US", { weekday: "short" })}</span>
              {isToday
                ? <span className="flex h-5.5 min-w-5.5 items-center justify-center rounded-full bg-[#011627] px-1.5 text-[12px] font-semibold leading-4 text-[#E6EDF3]">{day.day}</span>
                : <span className="text-[13px] font-semibold leading-4 text-black">{day.day}</span>}
            </div>
          );
        })}
      </div>
      {hasAllDay ? (
        <div className="flex border-b border-[#01162712] pl-14" data-calendar-all-day>
          {props.days.map((day) => (
            <div key={`all-${dateKey(day)}`} className="flex min-w-0 flex-1 basis-0 flex-col gap-0.5 px-1 py-1">
              {allDay.filter((event) => allDayOn(event, day)).map((event) => (
                <div key={event.key} className="h-6.5">
                  <MeetingBlock event={event} compact selected={props.selection?.kind === "meeting" && props.selection.key === event.key} onSelect={() => props.onSelect({ kind: "meeting", key: event.key })} />
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto pt-2.5">
        <div className="flex" style={{ height: hours.length * HOUR_PX }}>
          <div className="flex w-14 shrink-0 flex-col">
            {hours.map((hour) => (
              <div key={hour} className="flex h-14.5 shrink-0 justify-end pr-2.5">
                <span className="-mt-1.75 text-[11px] leading-3.5 text-[#9BA1A6]">{hourLabel(hour)}</span>
              </div>
            ))}
          </div>
          <div className="flex flex-1">
            {perDay.map(({ day, blocks, placements }) => (
              <div key={`col-${dateKey(day)}`} className="relative flex flex-1 basis-0 flex-col border-l border-[#0116270F]">
                {hours.map((hour) => <div key={hour} className="h-14.5 shrink-0 border-t border-[#0116270F]" />)}
                {/* Empty half hours: hover shows where a new automation would go, a click opens the card there. */}
                {hours.flatMap((hour) => [0, 30].map((minute) => {
                  const slot = slotAt(day, hour * 60 + minute, props.zone);
                  const time = formatTime(slot.at, props.zone);
                  return (
                    <button
                      key={`slot-${hour}-${minute}`}
                      type="button"
                      tabIndex={-1}
                      aria-label={`New automation on ${formatDate(day, "en-US")} at ${time}`}
                      data-calendar-slot={`${dateKey(day)}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`}
                      onClick={(event) => props.onCreateAt({ slot, x: event.clientX + 12, y: event.clientY - 28 })}
                      className="group absolute inset-x-0 z-0 pl-1 pr-1.5 focus-visible:outline-none"
                      style={{ top: (hour - firstHour) * HOUR_PX + (minute ? HOUR_PX / 2 : 0) + 1, height: HOUR_PX / 2 - 1 }}
                    >
                      <span className="hidden h-full items-center gap-1.5 rounded-md border-[1.5px] border-dashed border-[#01162759] bg-[#0116270A] px-2 group-hover:flex">
                        <Plus size={11} strokeWidth={2.25} className="shrink-0 text-[#011627]" aria-hidden />
                        <span className="truncate text-[11px] font-semibold leading-3.5 text-[#011627]">New automation</span>
                        <span className="shrink-0 text-[11px] leading-3.5 text-[#687076]">{time}</span>
                      </span>
                    </button>
                  );
                }))}
                {blocks.map((block) => {
                  const placement = placements.get(block.key) ?? { column: 0, columns: 1 };
                  const y = Math.max(0, top(block.start, day));
                  const subtitle = block.kind === "automation" ? subtitleFor(block.item, props.list) : null;
                  const minHeight = block.kind === "meeting" || subtitle ? 55 : 26;
                  const height = Math.max(top(block.end, day) - y - 2, minHeight);
                  const width = 100 / placement.columns;
                  const selected = block.kind === "automation"
                    ? props.selection?.kind === "automation" && (props.selection.itemKey === block.item.key || (props.selection.itemKey === null && props.selection.automationId === block.item.automationId))
                    : props.selection?.kind === "meeting" && props.selection.key === block.event.key;
                  return (
                    <div key={block.key} className="absolute pl-1 pr-1.5" style={{ top: y + 1, height, left: `${placement.column * width}%`, width: `${width}%`, zIndex: selected ? 3 : block.kind === "automation" ? 2 : 1 }}>
                      {block.kind === "automation"
                        ? <AutomationBlock item={block.item} subtitle={subtitle} selected={selected} onSelect={() => props.onSelect({ kind: "automation", automationId: block.item.automationId, itemKey: block.item.key })} />
                        : <MeetingBlock event={block.event} compact={height < 50} selected={selected} onSelect={() => props.onSelect({ kind: "meeting", key: block.event.key })} />}
                    </div>
                  );
                })}
                {compareDates(day, today) === 0 && top(props.now, day) >= 0 && top(props.now, day) <= hours.length * HOUR_PX ? (
                  <div data-calendar-now aria-hidden className="pointer-events-none absolute -left-1 right-0 z-10 flex h-0.5 items-center bg-[#E5484D]" style={{ top: top(props.now, day) }}>
                    <span className="-ml-px size-2 shrink-0 rounded-full bg-[#E5484D]" />
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function MonthGrid(props: { range: CalendarRange; zone: string; now: number; anchorMonth: number; automations: AutomationCalendarItem[]; meetings: CalendarEvent[]; list: readonly ListItem[]; selection: Selection; onSelect: (selection: Selection) => void; onOpenDay: (day: LocalDate) => void }) {
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
            ...blocksForDay(day, props.zone, props.automations, props.meetings).sort((left, right) => left.start - right.start),
          ];
          const isToday = compareDates(day, today) === 0;
          return (
            <div key={`m-${dateKey(day)}`} className={`flex min-h-28 min-w-0 flex-col gap-1 border-b border-l border-[#0116270F] p-1.5 ${day.month === props.anchorMonth ? "" : "bg-[#F8F9FA]"}`}>
              <button type="button" onClick={() => props.onOpenDay(day)} className={`self-start rounded-full px-1.5 text-[12px] font-semibold leading-5 ${isToday ? "bg-[#011627] text-[#E6EDF3]" : day.month === props.anchorMonth ? "text-black" : "text-[#9BA1A6]"}`}>{day.day}</button>
              {entries.slice(0, 3).map((entry) => (
                <div key={entry.key} className="h-6.5">
                  {entry.kind === "automation"
                    ? <AutomationBlock item={entry.item} subtitle={null} selected={props.selection?.kind === "automation" && props.selection.itemKey === entry.item.key} onSelect={() => props.onSelect({ kind: "automation", automationId: entry.item.automationId, itemKey: entry.item.key })} />
                    : <MeetingBlock event={entry.event} compact selected={props.selection?.kind === "meeting" && props.selection.key === entry.event.key} onSelect={() => props.onSelect({ kind: "meeting", key: entry.event.key })} />}
                </div>
              ))}
              {entries.length > 3 ? <button type="button" onClick={() => props.onOpenDay(day)} className="self-start px-1 text-[11px] text-[#687076] hover:text-black">{entries.length - 3} more</button> : null}
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
    <div className="flex min-h-9 items-center border-b border-[#0116270F] py-2">
      <span className="w-24 shrink-0 text-[12px] leading-4 text-[#687076]">{label}</span>
      <span className="min-w-0 flex-1 text-[13px] leading-4 text-black">{children}</span>
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
      <div className="flex h-8.5 shrink-0 items-center gap-2.5">
        <RunIcon run={run} />
        <span className="w-22.5 shrink-0 text-[13px] leading-4 text-black">{shortDate(runPlacement(run), zone)}</span>
        <span className="min-w-0 flex-1 truncate text-[12px] leading-4 text-[#687076]">{describeRunOutcome(run)}</span>
        <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} className="text-[12px] font-medium leading-4 text-black hover:underline">{open ? "Close" : "Open"}</button>
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

function ScheduleDialog({ schedule, busy, onClose, onSave }: { schedule: AutomationSchedule; busy: boolean; onClose: () => void; onSave: (schedule: AutomationSchedule) => void }) {
  const [draft, setDraft] = useState<AutomationSchedule>(schedule);
  const time = draft.kind === "once" ? null : `${String(draft.hour).padStart(2, "0")}:${String(draft.minute).padStart(2, "0")}`;
  const setKind = (kind: "daily" | "weekly") => {
    const hour = draft.kind === "once" ? 9 : draft.hour;
    const minute = draft.kind === "once" ? 0 : draft.minute;
    setDraft(kind === "daily" ? { kind, timezone: draft.timezone, hour, minute } : { kind, timezone: draft.timezone, hour, minute, daysOfWeek: draft.kind === "weekly" ? draft.daysOfWeek : [1, 2, 3, 4, 5] });
  };
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-[#01162733] p-4" role="dialog" aria-modal="true" aria-label="Edit schedule" onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}>
      <form className="w-full max-w-sm rounded-xl bg-white p-5 shadow-[var(--wb-panel-shadow)]" onSubmit={(event) => { event.preventDefault(); onSave(draft); }}>
        <div className="flex items-center justify-between">
          <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-black">Edit schedule</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="grid size-7 place-items-center rounded-[7px] text-[#687076] hover:bg-[#F1F3F5]"><X size={15} strokeWidth={1.75} /></button>
        </div>
        {draft.kind === "once" ? (
          <p className="mt-3 text-[13px] text-[#687076]">This runs once, {formatInstant(draft.at, draft.timezone)}. Change it to repeat:</p>
        ) : null}
        <div className="mt-4 flex rounded-lg bg-[#F1F3F5] p-0.5" role="radiogroup" aria-label="Repeats">
          {(["daily", "weekly"] as const).map((kind) => (
            <button key={kind} type="button" role="radio" aria-checked={draft.kind === kind} onClick={() => setKind(kind)} className={`h-6.5 flex-1 rounded-md text-[12px] leading-4 ${draft.kind === kind ? "bg-white font-semibold text-black shadow-[0_1px_2px_#0116271A]" : "font-medium text-[#687076]"}`}>
              {kind === "daily" ? "Every day" : "Some days"}
            </button>
          ))}
        </div>
        {draft.kind === "weekly" ? (
          <div className="mt-3 flex flex-wrap gap-1.5" aria-label="Days">
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
        <label className="mt-3 flex items-center gap-3 text-[13px] text-black">
          <span className="w-16 text-[12px] text-[#687076]">Time</span>
          <input type="time" value={time ?? "09:00"} onChange={(event) => {
            const [hour, minute] = event.currentTarget.value.split(":").map(Number);
            if (Number.isInteger(hour) && Number.isInteger(minute)) setDraft(draft.kind === "once" ? { kind: "daily", timezone: draft.timezone, hour, minute } : { ...draft, hour, minute });
          }} className="h-8 flex-1 rounded-md px-2 shadow-[0_0_0_1px_#0116271F] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]" />
        </label>
        <label className="mt-2 flex items-center gap-3 text-[13px] text-black">
          <span className="w-16 text-[12px] text-[#687076]">Time zone</span>
          <input value={draft.timezone} onChange={(event) => setDraft({ ...draft, timezone: event.currentTarget.value })} className="h-8 flex-1 rounded-md px-2 shadow-[0_0_0_1px_#0116271F] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]" />
        </label>
        <div className="mt-5 flex gap-2">
          <button type="button" onClick={onClose} className="h-8.5 flex-1 rounded-lg text-[13px] font-medium text-black shadow-[0_0_0_1px_#0116271F]">Cancel</button>
          <button type="submit" disabled={busy} className="h-8.5 flex-1 rounded-lg bg-[#011627] text-[13px] font-medium text-[#E6EDF3] disabled:opacity-60">{busy ? "Saving…" : "Save schedule"}</button>
        </div>
      </form>
    </div>
  );
}

function AutomationPanel({ item, block, zone, onToast }: { item: ListItem; block: AutomationCalendarItem | null; zone: string; onToast: (text: string) => void }) {
  const { automation, revision } = item;
  const runs = useAutomationRuns(automation.id);
  const action = useCalendarAction();
  const [editing, setEditing] = useState(false);
  const blocked = automation.state === "needs_attention";
  const when = block?.run ? formatInstant(runPlacement(block.run), zone) : block ? formatInstant(block.at, zone) : automation.nextDueAt ? formatInstant(automation.nextDueAt, zone) : null;
  const run = (kind: "pause" | "resume" | "run", done: string) => action.mutate({ kind, automationId: automation.id }, {
    onSuccess: () => onToast(done),
    onError: (error) => onToast(error.message),
  });
  return (
    <aside className="flex w-95 shrink-0 flex-col gap-4.5 border-l border-[#01162712] bg-white p-6" aria-label={automation.name} data-calendar-detail={automation.id}>
      <div className="flex flex-col gap-1">
        <span className="text-[12px] leading-4 text-[#687076]" data-calendar-next-run>
          {blocked ? "Not scheduled until fixed" : automation.state === "inactive" ? "Paused" : when ?? "No run scheduled"}
        </span>
        <h2 className="text-[18px] font-semibold leading-5.5 tracking-[-0.015em] text-black">{automation.name}</h2>
      </div>
      {blocked && automation.needsAttentionReason ? (
        <div className="flex items-start gap-2 rounded-lg bg-[#F4F6F7] px-3 py-2.5" data-calendar-blocked>
          <span className="mt-0.5"><LockIcon size={13} /></span>
          <span className="text-[13px] leading-4.5 text-[#11181C]">{automation.needsAttentionReason.message}</span>
        </div>
      ) : null}
      <div className="flex flex-col border-t border-[#0116270F]">
        <Row label="Repeats">{describeSchedule(revision.schedule, "", "en-US")}</Row>
        <Row label="Runs on">{(revision.executionTarget ?? "desktop") === "cloud" ? "The cloud. Your laptop can be closed." : "Your desktop. Keep OpenWork open at that time."}</Row>
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
        <button type="button" disabled={action.isPending} onClick={() => setEditing(true)} className="h-8.5 flex-1 rounded-lg text-[13px] font-medium text-black shadow-[0_0_0_1px_#0116271F] hover:bg-[#F4F6F7] disabled:opacity-60">Edit schedule</button>
        <button type="button" disabled={action.isPending || blocked} title={blocked ? "Fix what it needs first" : undefined} onClick={() => run("run", "Running now")} className="h-8.5 flex-1 rounded-lg bg-[#011627] text-[13px] font-medium text-[#E6EDF3] hover:opacity-90 disabled:opacity-50">Run now</button>
      </div>
      {editing ? (
        <ScheduleDialog
          schedule={revision.schedule}
          busy={action.isPending}
          onClose={() => setEditing(false)}
          onSave={(schedule) => action.mutate({ kind: "schedule", automationId: automation.id, schedule }, {
            onSuccess: () => { setEditing(false); onToast("Schedule saved"); },
            onError: (error) => onToast(error.message),
          })}
        />
      ) : null}
    </aside>
  );
}

function MeetingPanel({ event, zone }: { event: CalendarEvent; zone: string }) {
  const source = event.provider === "google" ? "Google Calendar" : "Outlook Calendar";
  const when = event.timing.kind === "timed"
    ? `${formatInstant(event.timing.start, zone)} – ${formatTime(event.timing.end, zone)}`
    : `${formatDate(event.timing.startDate, "en-US")} · All day`;
  return (
    <aside className="flex w-95 shrink-0 flex-col gap-4.5 border-l border-[#01162712] bg-white p-6" aria-label={event.title} data-calendar-meeting-detail={event.key}>
      <div className="flex flex-col gap-1">
        <span className="text-[12px] leading-4 text-[#687076]">{when}</span>
        <h2 className="text-[18px] font-semibold leading-5.5 tracking-[-0.015em] text-black">{event.title}</h2>
      </div>
      <div className="flex flex-col border-t border-[#0116270F]">
        <Row label="From">{source}</Row>
        {event.location ? <Row label="Where">{event.location}</Row> : null}
        {event.attendeeCount > 0 ? <Row label="Guests">{event.attendeeCount}</Row> : null}
      </div>
      <div className="flex-1" />
      <div className="flex gap-2">
        {event.meetingUrl ? <a href={event.meetingUrl} target="_blank" rel="noreferrer" className="flex h-8.5 flex-1 items-center justify-center rounded-lg text-[13px] font-medium text-black shadow-[0_0_0_1px_#0116271F]">Join</a> : null}
        {event.sourceUrl ? <a href={event.sourceUrl} target="_blank" rel="noreferrer" className="flex h-8.5 flex-1 items-center justify-center rounded-lg bg-[#011627] text-[13px] font-medium text-[#E6EDF3]">Open in {source}</a> : null}
      </div>
    </aside>
  );
}

/* ── Page ──────────────────────────────────────────────────────────────────────────────────────────────── */

function Legend({ checked, onToggle, children, testId }: { checked: boolean; onToggle: () => void; children: ReactNode; testId: string }) {
  return (
    <button type="button" role="checkbox" aria-checked={checked} onClick={onToggle} data-calendar-layer={testId} className="flex items-center gap-1.5 rounded focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]">
      <span className={`size-2.5 shrink-0 rounded-[3px] ${checked ? "bg-[#DCE6EF] shadow-[inset_0_0_0_1px_#0116271F]" : "shadow-[inset_0_0_0_1.2px_#9BA1A6]"}`} />
      <span className={`text-[12px] font-medium leading-4 ${checked ? "text-black" : "text-[#687076]"}`}>{children}</span>
    </button>
  );
}

function blockedLabel(error: CalendarConnectionError) {
  const name = error.provider === "google" ? "Google Calendar" : "Outlook Calendar";
  if (error.kind === "auth_expired") return `Reconnect ${name}`;
  if (error.kind === "not_connected") return `Connect ${name}`;
  if (error.kind === "permission_missing") return `${name} needs calendar access`;
  if (error.kind === "policy_blocked") return `${name} is blocked by your organization`;
  return null;
}

function weekdaysOnly(days: LocalDate[], automations: AutomationCalendarItem[], meetings: CalendarEvent[], zone: string) {
  const weekend = days.filter((day) => weekdayOf(day) === 0 || weekdayOf(day) === 6);
  const busy = weekend.some((day) => blocksForDay(day, zone, automations, meetings).length > 0 || meetings.some((event) => allDayOn(event, day)));
  return busy ? days : days.filter((day) => weekdayOf(day) !== 0 && weekdayOf(day) !== 6);
}

export function WorkbotCalendar({ connectionsHref, assistantName }: { connectionsHref: string | null; assistantName: string }) {
  const zone = timeZone();
  const sources = useCalendarSources();
  const [now, setNow] = useState(() => Date.now());
  const [view, setView] = useState<CalendarView>("week");
  const [anchor, setAnchor] = useState<LocalDate>(() => localDateOf(Date.now(), zone));
  const [layers, setLayers] = useState({ automations: true, meetings: true });
  const [selection, setSelection] = useState<Selection>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [creating, setCreating] = useState<CreateAnchor | null>(null);
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
  const runs = useRunsInRangeQuery({ keyPrefix: calendarKey, source: sources.runs, range, automations: list.data?.items, enabled: layers.automations });
  const google = useMeetingsQuery({ keyPrefix: calendarKey, provider: "google", transport: sources.transport, range, enabled: layers.meetings });
  const microsoft = useMeetingsQuery({ keyPrefix: calendarKey, provider: "microsoft", transport: sources.transport, range, enabled: layers.meetings });
  const meetingQueries = { google, microsoft };

  const items = useMemo(() => layers.automations && list.data && runs.data
    ? buildAutomationCalendarItems({ automations: list.data.items, runs: runs.data.runs, range, now })
    : [], [layers.automations, list.data, now, range, runs.data]);
  const meetings = useMemo(() => layers.meetings ? [...(google.data?.events ?? []), ...(microsoft.data?.events ?? [])] : [], [google.data, layers.meetings, microsoft.data]);

  // Open on the next thing that will run, as the design shows a selection.
  useEffect(() => {
    if (selection || items.length === 0) return;
    const next = items.find((item) => item.status === "upcoming") ?? items.at(-1);
    if (next) setSelection({ kind: "automation", automationId: next.automationId, itemKey: next.key });
  }, [items, selection]);

  const days = view === "week" ? weekdaysOnly(range.days, items, meetings, zone) : range.days;
  const selectedItem = selection?.kind === "automation" ? list.data?.items.find((entry) => entry.automation.id === selection.automationId) ?? null : null;
  const selectedBlock = selection?.kind === "automation" ? items.find((item) => item.key === selection.itemKey) ?? null : null;
  const selectedMeeting = selection?.kind === "meeting" ? meetings.find((event) => event.key === selection.key) ?? null : null;
  const connected = PROVIDERS.filter((provider) => meetingQueries[provider].data);
  const meetingSource = connected.length === 2 ? "Google Calendar and Outlook" : connected[0] === "microsoft" ? "Outlook Calendar" : "Google Calendar";
  const label = view === "week" && days.length === 5 ? `${formatDate(days[0]!, "en-US", { month: "short", day: "numeric" })} – ${days[4]!.month === days[0]!.month ? formatDate(days[4]!, "en-US", { day: "numeric" }) : formatDate(days[4]!, "en-US", { month: "short", day: "numeric" })}` : formatRangeLabel(range, anchor, "en-US");
  const nowParts = zonedParts(now, zone);

  return (
    <div className="flex min-h-0 flex-1" data-calendar-page>
      <div className="flex min-w-0 flex-1 flex-col pl-5 pr-7 pt-6">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3 pl-2">
          <div className="flex items-center gap-3">
            <h2 className="text-[20px] font-semibold leading-6 tracking-[-0.015em] text-black" data-calendar-range-label>{label}</h2>
            <div className="flex gap-0.5">
              <button type="button" aria-label="Previous" onClick={() => setAnchor((current) => shiftAnchor(view, current, -1))} className="grid size-7 place-items-center rounded-[7px] text-[#687076] hover:bg-[#F1F3F5]"><ChevronLeft size={15} strokeWidth={1.75} /></button>
              <button type="button" aria-label="Next" onClick={() => setAnchor((current) => shiftAnchor(view, current, 1))} className="grid size-7 place-items-center rounded-[7px] text-[#687076] hover:bg-[#F1F3F5]"><ChevronRight size={15} strokeWidth={1.75} /></button>
            </div>
            <button
              type="button"
              data-calendar-new
              onClick={(event) => {
                const box = event.currentTarget.getBoundingClientRect();
                setCreating({ slot: nextOpenSlot(Date.now(), zone), x: box.left, y: box.bottom + 8 });
              }}
              className="flex h-7 items-center gap-1.25 rounded-[7px] px-2.5 text-[12px] font-medium text-black shadow-[0_0_0_1px_#0116271A] hover:bg-[#F4F6F7] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]"
            >
              <Plus size={12} strokeWidth={2} aria-hidden />New automation
            </button>
            {compareDates(anchor, { year: nowParts.year, month: nowParts.month, day: nowParts.day }) !== 0 ? (
              <button type="button" onClick={() => setAnchor(localDateOf(Date.now(), zone))} className="h-7 rounded-[7px] px-2.5 text-[12px] font-medium text-black shadow-[0_0_0_1px_#0116271A]">Today</button>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <Legend testId="automations" checked={layers.automations} onToggle={() => setLayers((current) => ({ ...current, automations: !current.automations }))}>Your automations</Legend>
            <Legend testId="meetings" checked={layers.meetings} onToggle={() => setLayers((current) => ({ ...current, meetings: !current.meetings }))}>Your meetings, from {meetingSource}</Legend>
            {layers.meetings ? PROVIDERS.map((provider) => {
              const error = meetingQueries[provider].error;
              const text = error ? blockedLabel(error) : null;
              // A provider the organization never set up stays out of the way.
              if (!error || (error.kind === "not_connected" && connected.length > 0) || error.kind === "unsupported") return null;
              return (
                <span key={provider} className="flex items-center gap-1 text-[12px] leading-4 text-[#687076]" data-calendar-provider-status={provider} data-state={error.kind} title={error.message}>
                  <Lock size={11} strokeWidth={2} aria-hidden />
                  {text && connectionsHref ? <a href={connectionsHref} target="_blank" rel="noreferrer" className="font-medium text-black underline-offset-2 hover:underline">{text}</a>
                    : text ? <span>{text}</span>
                    : <button type="button" onClick={() => void meetingQueries[provider].refetch()} className="font-medium text-black hover:underline">Couldn&apos;t load {provider === "google" ? "Google Calendar" : "Outlook"} · Try again</button>}
                </span>
              );
            }) : null}
            <div className="flex rounded-lg bg-[#F1F3F5] p-0.5" role="radiogroup" aria-label="Calendar view">
              {(["day", "week", "month"] as const).map((option) => (
                <button key={option} type="button" role="radio" aria-checked={view === option} onClick={() => setView(option)} className={`flex h-6.5 items-center px-2.5 text-[12px] leading-4 ${view === option ? "rounded-md bg-white font-semibold text-black shadow-[0_1px_2px_#0116271A]" : "font-medium text-[#687076]"}`}>
                  {option === "day" ? "Day" : option === "week" ? "Week" : "Month"}
                </button>
              ))}
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
        ) : view === "month" ? (
          <MonthGrid range={range} zone={zone} now={now} anchorMonth={anchor.month} automations={items} meetings={meetings} list={list.data?.items ?? []} selection={selection} onSelect={setSelection} onOpenDay={(target) => { setAnchor(target); setView("day"); }} />
        ) : (
          <TimeGrid range={range} days={days} zone={zone} now={now} automations={items} meetings={meetings} list={list.data?.items ?? []} selection={selection} onSelect={setSelection} onCreateAt={setCreating} />
        )}
        {list.data && list.data.items.every((entry) => entry.automation.state === "archived") && layers.automations ? (
          <p className="py-4 pl-16 text-[13px] text-[#687076]" data-calendar-empty>No automations yet. Ask in Home to set up something that repeats.</p>
        ) : null}
      </div>
      {selectedItem ? <AutomationPanel key={selectedItem.automation.id} item={selectedItem} block={selectedBlock} zone={zone} onToast={setToast} />
        : selectedMeeting ? <MeetingPanel event={selectedMeeting} zone={zone} />
        : <aside className="hidden w-95 shrink-0 border-l border-[#01162712] bg-white p-6 text-[13px] text-[#687076] lg:block">Pick something on the calendar to see it here.</aside>}
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
