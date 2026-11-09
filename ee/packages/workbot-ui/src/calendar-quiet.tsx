"use client";

import {
  addDays,
  compareDates,
  dateKey,
  describeRunOutcome,
  describeSchedule,
  formatDate,
  formatTime,
  layoutOverlappingBlocks,
  localDateOf,
  minutesIntoDay,
  startOfDay,
  weekdayOf,
  type AutomationCalendarItem,
  type CalendarEvent,
  type CalendarRange,
  type LocalDate,
} from "@openwork/calendar";
import type { AutomationList } from "@openwork/types/automations";
import { ChevronDown, ChevronRight, Lock, RotateCcw, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * The quiet calendar (`workbotQuietCalendar`). Meetings own the time grid at full width; Workbot's automation runs are
 * small dots at their time on the left edge of each day, never chips that fight meetings for width. Each day says how
 * many runs it had in plain text; the Workbot panel (Needs you, Up next, a 7-day track per automation) opens on demand
 * from the toolbar. Routine success is grey: only a failure is red, and it is a dot, not a banner. Narrow widths and
 * phones get an agenda list instead of a 7-column grid. Surfaces are separated by fill, never by outlines (DESIGN V3).
 */

type ListItem = AutomationList["items"][number];
export type QuietSelection = { kind: "automation"; automationId: string; itemKey: string | null } | { kind: "meeting"; key: string } | null;

export const QUIET_HOUR_PX = 64;
const DAY_START_HOUR = 8;
const DAY_END_HOUR = 18;
/** Runs closer together than this, with the same status, share one dot. */
const MERGE_MINUTES = 10;

const DONE = new Set<AutomationCalendarItem["status"]>(["succeeded", "skipped", "cancelled"]);
const NEXT = new Set<AutomationCalendarItem["status"]>(["upcoming", "running"]);

function inDay(at: number, day: LocalDate, zone: string) {
  return at >= startOfDay(day, zone) && at < startOfDay(addDays(day, 1), zone);
}

function allDayOn(event: CalendarEvent, day: LocalDate) {
  return event.timing.kind === "all_day" && compareDates(event.timing.startDate, day) <= 0 && compareDates(event.timing.endDate, day) > 0;
}

function hourLabel(hour: number) {
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(2024, 0, 1, hour)));
}

export type DayCounts = { failed: number; blocked: number; done: number; next: number };

export function countRuns(items: readonly AutomationCalendarItem[]): DayCounts {
  const counts = { failed: 0, blocked: 0, done: 0, next: 0 };
  for (const item of items) {
    if (item.status === "failed") counts.failed += 1;
    else if (item.status === "blocked") counts.blocked += 1;
    else if (DONE.has(item.status)) counts.done += 1;
    else if (NEXT.has(item.status)) counts.next += 1;
  }
  return counts;
}

/** "17 runs", "1 failed, 15 done", "8 done, 9 to go", "1 won't run, 17 planned"; null for a day with no runs. */
export function daySummary(counts: DayCounts): { attention: string | null; rest: string | null } | null {
  const attention = [counts.failed ? `${counts.failed} failed` : null, counts.blocked ? `${counts.blocked} won’t run` : null].filter(Boolean).join(", ") || null;
  const rest = counts.done && counts.next ? `${counts.done} done, ${counts.next} to go`
    : counts.done ? (attention ? `${counts.done} done` : `${counts.done} ${counts.done === 1 ? "run" : "runs"}`)
    : counts.next ? `${counts.next} planned`
    : null;
  return attention || rest ? { attention, rest } : null;
}

function DaySummaryLine({ items, day, zone }: { items: readonly AutomationCalendarItem[]; day: LocalDate; zone: string }) {
  const summary = daySummary(countRuns(items.filter((item) => inDay(item.at, day, zone))));
  if (!summary) return <span className="h-3.5" aria-hidden />;
  return (
    <span className="truncate text-[11px] leading-3.5 text-[var(--wb-muted)] tabular-nums" data-calendar-day-summary>
      {summary.attention ? <span className="font-medium text-[var(--wb-text)]">{summary.attention}</span> : null}
      {summary.attention && summary.rest ? ", " : null}
      {summary.rest}
    </span>
  );
}

/** Merges runs within MERGE_MINUTES of each other that share a status, so a busy hour stays one quiet dot. */
function mergeNearby(items: readonly AutomationCalendarItem[]) {
  const out: Array<{ item: AutomationCalendarItem; count: number }> = [];
  for (const item of [...items].sort((left, right) => left.at - right.at)) {
    const last = out.at(-1);
    if (last && item.status === last.item.status && item.at - last.item.at < MERGE_MINUTES * 60_000) { last.count += 1; continue; }
    out.push({ item, count: 1 });
  }
  return out;
}

const STATUS_WORD: Record<AutomationCalendarItem["status"], string> = {
  succeeded: "done", failed: "failed", cancelled: "cancelled", skipped: "skipped", running: "running now", upcoming: "next", blocked: "won’t run until fixed",
};

/** One run (or a few close together) as a dot. Done is filled grey, still to come is a ring, failed is a red dot. */
function RunDot({ status, selected }: { status: AutomationCalendarItem["status"]; selected: boolean }) {
  const base = "block size-[7px] rounded-full transition-transform duration-150";
  const ring = selected ? " scale-150" : "";
  if (status === "failed") return <span aria-hidden className={`${base} bg-[var(--wb-danger)]${ring}`} />;
  if (status === "blocked") return <span aria-hidden className={`${base} border-[1.5px] border-[var(--wb-muted)]${ring}`} />;
  if (status === "running") return <span aria-hidden className={`${base} workbot-presence-dot${ring}`} />;
  if (status === "upcoming") return <span aria-hidden className={`${base} border-[1.5px] border-[var(--wb-faint)]${ring}`} />;
  return <span aria-hidden className={`${base} bg-[var(--wb-faint)]${ring}`} />;
}

function QuietMeeting({ event, past, live, selected, height, onSelect }: { event: CalendarEvent; past: boolean; live: boolean; selected: boolean; height: number; onSelect(): void }) {
  const short = height < 40;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const time = event.timing.kind === "timed" ? `${formatTime(event.timing.start, zone)} – ${formatTime(event.timing.end, zone)}` : "All day";
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      aria-label={`${event.title}, ${time}`}
      data-calendar-meeting={event.key}
      data-calendar-provider={event.provider}
      className={`flex h-full w-full flex-col gap-0.5 overflow-hidden rounded-[7px] px-2.5 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)] ${short ? "justify-center" : "py-1.5"} ${live ? "bg-[#e2e9ef]" : past ? "bg-[var(--wb-tray)] hover:bg-[var(--wb-chip)]" : "bg-[#eef2f5] hover:bg-[#e6ecf1]"} ${selected ? "shadow-[inset_0_0_0_1.5px_var(--wb-ink)]" : ""}`}
    >
      <span className={`text-[12px] font-semibold leading-[15px] ${past ? "text-[var(--wb-muted)]" : "text-[var(--wb-text)]"} ${short || height < 64 ? "truncate" : "line-clamp-2 break-words"}`}>{event.title}</span>
      {short ? null : <span className="truncate text-[11px] leading-3.5 text-[var(--wb-muted)] tabular-nums">{time}</span>}
    </button>
  );
}

export function QuietTimeGrid(props: {
  range: CalendarRange; days: LocalDate[]; zone: string; now: number;
  automations: AutomationCalendarItem[]; meetings: CalendarEvent[];
  selection: QuietSelection; onSelect: (selection: QuietSelection) => void;
}) {
  const today = localDateOf(props.now, props.zone);
  const perDay = props.days.map((day) => {
    const dayStart = startOfDay(day, props.zone);
    const dayEnd = startOfDay(addDays(day, 1), props.zone);
    const meetings = props.meetings.filter((event) => event.timing.kind === "timed" && event.timing.end > dayStart && event.timing.start < dayEnd);
    // Meetings alone share the width; at least 30 minutes tall so a short one stays readable.
    const blocks = meetings.map((event) => {
      const timing = event.timing.kind === "timed" ? event.timing : null;
      const start = Math.max(timing?.start ?? dayStart, dayStart);
      const end = Math.min(timing?.end ?? dayEnd, dayEnd);
      return { key: event.key, start, end: Math.max(end, start + 30 * 60_000), event };
    });
    return { day, blocks, placements: layoutOverlappingBlocks(blocks), runs: props.automations.filter((item) => item.at >= dayStart && item.at < dayEnd) };
  });
  // Working hours, widened only by meetings: a run at 7 AM or 11 PM is counted in the header, not a reason to scroll.
  let firstHour = DAY_START_HOUR;
  let lastHour = DAY_END_HOUR;
  for (const { day, blocks } of perDay) for (const block of blocks) {
    firstHour = Math.min(firstHour, Math.floor(minutesIntoDay(block.start, day, props.zone) / 60));
    lastHour = Math.max(lastHour, Math.ceil(minutesIntoDay(block.end, day, props.zone) / 60));
  }
  lastHour = Math.min(24, Math.max(lastHour, firstHour + 1));
  const hours = Array.from({ length: lastHour - firstHour }, (_, index) => firstHour + index);
  const top = (instant: number, day: LocalDate) => (minutesIntoDay(instant, day, props.zone) / 60 - firstHour) * QUIET_HOUR_PX;
  const height = hours.length * QUIET_HOUR_PX;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-calendar-grid={props.range.view} data-calendar-quiet>
      <div className="flex pl-14">
        {props.days.map((day) => {
          const isToday = compareDates(day, today) === 0;
          const location = props.meetings.find((event) => allDayOn(event, day));
          return (
            <div key={dateKey(day)} className="flex h-14 min-w-0 flex-1 basis-0 flex-col justify-center gap-1 pl-4 pr-2" data-calendar-day={dateKey(day)}>
              <span className="flex min-w-0 items-center justify-between gap-1.5">
                <span className="flex items-center gap-1.5">
                  <span className="text-[12px] font-medium leading-4 text-[var(--wb-muted)]">{formatDate(day, "en-US", { weekday: "short" })}</span>
                  {isToday
                    ? <span className="flex h-5.5 min-w-5.5 items-center justify-center rounded-full bg-[var(--wb-ink)] px-1.5 text-[12px] font-semibold leading-4 text-[var(--wb-mark-text)]">{day.day}</span>
                    : <span className="text-[13px] font-semibold leading-4 text-[var(--wb-text)]">{day.day}</span>}
                </span>
                {location ? (
                  <button type="button" onClick={() => props.onSelect({ kind: "meeting", key: location.key })} className="truncate rounded text-[11px] font-medium leading-3.5 text-[var(--wb-muted)] hover:text-[var(--wb-text)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]" data-calendar-all-day-label>{location.title}</button>
                ) : null}
              </span>
              <DaySummaryLine items={props.automations} day={day} zone={props.zone} />
            </div>
          );
        })}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pt-2.5">
        <div className="flex" style={{ height }}>
          <div className="flex w-14 shrink-0 flex-col">
            {hours.map((hour) => (
              <div key={hour} className="flex shrink-0 justify-end pr-2.5" style={{ height: QUIET_HOUR_PX }}>
                <span data-calendar-hour={hour} className="-mt-1.75 text-[12px] leading-4 text-[var(--wb-muted)] tabular-nums">{hourLabel(hour)}</span>
              </div>
            ))}
          </div>
          <div className="flex flex-1">
            {perDay.map(({ day, blocks, placements, runs }) => {
              const weekend = weekdayOf(day) === 0 || weekdayOf(day) === 6;
              return (
                <div key={`col-${dateKey(day)}`} className={`relative flex flex-1 basis-0 flex-col ${weekend ? "bg-[#f8f9fa]" : ""}`}>
                  {hours.map((hour, index) => <div key={hour} aria-hidden className="absolute inset-x-0 h-px bg-[#0116270a]" style={{ top: index * QUIET_HOUR_PX }} />)}
                  {blocks.map((block) => {
                    const placement = placements.get(block.key) ?? { column: 0, columns: 1 };
                    const y = Math.max(0, top(block.start, day));
                    const blockHeight = Math.max(top(block.end, day) - y - 4, 26);
                    const end = block.event.timing.kind === "timed" ? block.event.timing.end : block.end;
                    const start = block.event.timing.kind === "timed" ? block.event.timing.start : block.start;
                    const selected = props.selection?.kind === "meeting" && props.selection.key === block.event.key;
                    return (
                      // Inset 16px on the left: the run dots' lane.
                      <div key={block.key} className="absolute" style={{ top: y + 2, height: blockHeight, left: `calc(16px + ${placement.column} * (100% - 22px) / ${placement.columns})`, width: `calc((100% - 22px) / ${placement.columns} - ${placement.columns > 1 ? 3 : 0}px)`, zIndex: selected ? 3 : 1 }}>
                        <QuietMeeting event={block.event} past={end <= props.now} live={start <= props.now && end > props.now} selected={selected} height={blockHeight} onSelect={() => props.onSelect({ kind: "meeting", key: block.event.key })} />
                      </div>
                    );
                  })}
                  {mergeNearby(runs).filter(({ item }) => {
                    const y = top(item.at, day);
                    return y >= 0 && y <= height;
                  }).map(({ item, count }) => {
                    const selected = props.selection?.kind === "automation" && (props.selection.itemKey === item.key || (props.selection.itemKey === null && props.selection.automationId === item.automationId));
                    const label = `${count > 1 ? `${count} runs, ` : ""}${item.name}, ${formatTime(item.at, props.zone)}, ${STATUS_WORD[item.status]}`;
                    return (
                      <button
                        key={item.key}
                        type="button"
                        onClick={() => props.onSelect({ kind: "automation", automationId: item.automationId, itemKey: item.key })}
                        aria-label={label}
                        title={label}
                        aria-pressed={selected}
                        data-calendar-run={item.automationId}
                        data-calendar-status={item.status}
                        // What needs the person draws over a routine run at the same moment.
                        className={`absolute left-0.5 grid size-3.5 -translate-y-1/2 place-items-center rounded-full focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)] ${item.status === "failed" || item.status === "blocked" ? "z-[3]" : "z-[2]"}`}
                        style={{ top: top(item.at, day) }}
                      >
                        <RunDot status={item.status} selected={selected} />
                      </button>
                    );
                  })}
                  {compareDates(day, today) === 0 && top(props.now, day) >= 0 && top(props.now, day) <= height ? (
                    <div data-calendar-now aria-hidden className="pointer-events-none absolute -left-1 right-0 z-10 flex h-[1.5px] items-center bg-[var(--wb-ink)]" style={{ top: top(props.now, day) }}>
                      <span className="size-[7px] shrink-0 rounded-full bg-[var(--wb-ink)]" />
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

/** What needs the person: failed runs in range, newest first, and automations that won't run until fixed. */
export function needsYou(items: readonly AutomationCalendarItem[], list: readonly ListItem[]) {
  const failed = items.filter((item) => item.status === "failed").sort((left, right) => right.at - left.at);
  const blocked = list.filter((entry) => entry.automation.state === "needs_attention");
  return { failed, blocked, count: failed.length + blocked.length };
}

/** The toolbar's one line about Workbot, which opens its panel: "1 needs you · 95 runs". */
export function WorkbotStatusButton({ items, list, open, onToggle }: { items: readonly AutomationCalendarItem[]; list: readonly ListItem[]; open: boolean; onToggle(): void }) {
  const needs = needsYou(items, list).count;
  const runs = items.filter((item) => item.status !== "blocked").length;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls="workbot-calendar-week-panel"
      className="flex h-7 shrink-0 items-center gap-1.5 rounded-[7px] bg-[var(--wb-chip)] px-2.5 text-[12px] leading-4 transition-colors duration-150 hover:bg-[var(--wb-bubble)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]"
      data-calendar-workbot-status
    >
      {needs ? <><span aria-hidden className="size-1.5 rounded-full bg-[var(--wb-danger)]" /><span className="font-semibold text-[var(--wb-text)]">{needs} {needs === 1 ? "needs" : "need"} you</span></> : null}
      <span className="text-[var(--wb-muted)] tabular-nums">{runs} {runs === 1 ? "run" : "runs"}</span>
      <ChevronDown size={13} strokeWidth={1.75} aria-hidden className={`text-[var(--wb-faint)] transition-transform duration-150 ${open ? "rotate-180" : ""}`} />
    </button>
  );
}

type TrackState = "done" | "partial" | "failed" | "next" | "none";
function trackState(items: readonly AutomationCalendarItem[]): TrackState {
  if (items.length === 0) return "none";
  if (items.some((item) => item.status === "failed")) return "failed";
  const done = items.some((item) => DONE.has(item.status));
  const next = items.some((item) => NEXT.has(item.status) || item.status === "blocked");
  return done && next ? "partial" : done ? "done" : "next";
}

function TrackDot({ state }: { state: TrackState }) {
  if (state === "none") return <span aria-hidden className="h-[1.5px] w-1.5 rounded-full bg-[var(--wb-bubble)]" />;
  if (state === "failed") return <span aria-hidden className="size-2 rounded-full bg-[var(--wb-danger)]" />;
  if (state === "next") return <span aria-hidden className="size-2 rounded-full border-[1.5px] border-[var(--wb-disabled)]" />;
  if (state === "partial") return <svg aria-hidden width="8" height="8" viewBox="0 0 8 8" className="shrink-0"><circle cx="4" cy="4" r="3.4" fill="none" stroke="var(--wb-faint)" strokeWidth="1.2" /><path d="M4 .6A3.4 3.4 0 0 1 4 7.4Z" fill="var(--wb-faint)" /></svg>;
  return <span aria-hidden className="size-2 rounded-full bg-[var(--wb-faint)]" />;
}

/**
 * "Workbot this week": what needs the person, what runs next, and each automation's week as a row of dots. Opens from
 * the toolbar; selecting a row opens that automation's own panel.
 */
export function WorkbotWeekPanel(props: {
  days: LocalDate[]; zone: string; now: number; title: string;
  items: AutomationCalendarItem[]; list: readonly ListItem[];
  onSelect(selection: QuietSelection): void; onRunNow(automationId: string): void; busy: boolean; onClose(): void;
}) {
  const needs = needsYou(props.items, props.list);
  const next = props.items.filter((item) => NEXT.has(item.status) && item.at >= props.now).sort((left, right) => left.at - right.at).slice(0, 3);
  const active = props.list.filter((entry) => entry.automation.state !== "archived");
  const today = localDateOf(props.now, props.zone);
  const counts = countRuns(props.items);
  return (
    <aside id="workbot-calendar-week-panel" className="flex w-full min-w-0 shrink-0 flex-col gap-6 bg-[var(--wb-surface)] p-4 lg:w-90 lg:overflow-y-auto lg:p-6 lg:shadow-[-1px_0_0_var(--wb-hairline)]" aria-label={props.title} data-calendar-week-panel>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-[18px] font-semibold leading-5.5 tracking-[-0.015em] text-[var(--wb-text)]">{props.title}</h2>
          <p className="text-[12px] leading-4 text-[var(--wb-muted)] tabular-nums">{[`${counts.done + counts.failed + counts.next} runs`, counts.failed ? `${counts.failed} failed` : null, needs.blocked.length ? `${needs.blocked.length} won’t run` : null].filter(Boolean).join(", ")}</p>
        </div>
        <button type="button" onClick={props.onClose} aria-label="Close" className="grid size-7 shrink-0 place-items-center rounded-[7px] text-[var(--wb-muted)] hover:bg-[var(--wb-chip)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]"><X size={15} strokeWidth={1.75} aria-hidden /></button>
      </div>
      {needs.count ? (
        <section className="flex flex-col" aria-label="Needs you" data-calendar-needs-you>
          <h3 className="pb-1.5 text-[12px] font-semibold leading-4 text-[var(--wb-text)]">Needs you</h3>
          {needs.failed.slice(0, 4).map((item) => (
            <div key={item.key} className="flex items-start gap-2.5 border-b border-[var(--wb-row-line)] py-2.5 last:border-b-0">
              <span className="mt-1.5"><span aria-hidden className="block size-2 rounded-full bg-[var(--wb-danger)]" /></span>
              <button type="button" onClick={() => props.onSelect({ kind: "automation", automationId: item.automationId, itemKey: item.key })} className="flex min-w-0 flex-1 flex-col gap-0.5 rounded text-left focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]">
                <span className="truncate text-[13px] font-semibold leading-4.5 text-[var(--wb-text)]">{item.name}</span>
                <span className="line-clamp-2 text-[12px] leading-4 text-[var(--wb-muted)]">Failed {formatDate(localDateOf(item.at, props.zone), "en-US", { weekday: "short" })} {formatTime(item.at, props.zone)}{item.run ? `: ${describeRunOutcome(item.run)}` : ""}</span>
              </button>
              <button type="button" disabled={props.busy} onClick={() => props.onRunNow(item.automationId)} className="flex h-7 shrink-0 items-center gap-1 rounded-[7px] bg-[var(--wb-chip)] px-2.5 text-[12px] font-medium text-[var(--wb-text)] hover:bg-[var(--wb-bubble)] disabled:opacity-50 focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]"><RotateCcw size={12} strokeWidth={2} aria-hidden />Try again</button>
            </div>
          ))}
          {needs.blocked.map((entry) => (
            <button key={entry.automation.id} type="button" onClick={() => props.onSelect({ kind: "automation", automationId: entry.automation.id, itemKey: null })} className="flex items-start gap-2.5 border-b border-[var(--wb-row-line)] py-2.5 text-left last:border-b-0 focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]">
              <Lock size={12} strokeWidth={2} aria-hidden className="mt-1 shrink-0 text-[var(--wb-muted)]" />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-[13px] font-semibold leading-4.5 text-[var(--wb-text)]">{entry.automation.name}</span>
                <span className="line-clamp-2 text-[12px] leading-4 text-[var(--wb-muted)]">{entry.automation.needsAttentionReason?.message ?? "Won’t run until it’s fixed."}</span>
              </span>
              <ChevronRight size={14} strokeWidth={1.75} aria-hidden className="mt-0.5 shrink-0 text-[var(--wb-faint)]" />
            </button>
          ))}
        </section>
      ) : null}
      {next.length ? (
        <section className="flex flex-col gap-1" aria-label="Up next">
          <h3 className="pb-1 text-[12px] font-semibold leading-4 text-[var(--wb-text)]">Up next</h3>
          {next.map((item) => (
            <button key={item.key} type="button" onClick={() => props.onSelect({ kind: "automation", automationId: item.automationId, itemKey: item.key })} className="flex items-baseline gap-3 rounded py-1 text-left focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]">
              <span className="w-16 shrink-0 text-[12px] font-medium leading-4.5 text-[var(--wb-muted)] tabular-nums">{formatTime(item.at, props.zone)}</span>
              <span className="min-w-0 flex-1 truncate text-[13px] leading-4.5 text-[var(--wb-text)]">{item.name}</span>
            </button>
          ))}
        </section>
      ) : null}
      {active.length ? (
        <section className="flex flex-col" aria-label="Automations" data-calendar-tracks>
          <div className="flex items-center pb-1.5">
            <h3 className="flex-1 text-[12px] font-semibold leading-4 text-[var(--wb-text)]">Automations</h3>
            <span className="flex" aria-hidden>
              {props.days.map((day) => <span key={dateKey(day)} className={`w-4.5 text-center text-[11px] leading-4 ${compareDates(day, today) === 0 ? "font-bold text-[var(--wb-ink)]" : "font-medium text-[var(--wb-faint)]"}`}>{formatDate(day, "en-US", { weekday: "narrow" })}</span>)}
            </span>
          </div>
          {active.map((entry) => {
            const mine = props.items.filter((item) => item.automationId === entry.automation.id);
            return (
              <button key={entry.automation.id} type="button" onClick={() => props.onSelect({ kind: "automation", automationId: entry.automation.id, itemKey: null })} className="flex items-center gap-3 border-t border-[var(--wb-row-line)] py-2.5 text-left focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]" data-calendar-track={entry.automation.id}>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-[13px] font-medium leading-4.5 text-[var(--wb-text)]">{entry.automation.name}</span>
                  <span className="truncate text-[12px] leading-4 text-[var(--wb-muted)]">{entry.automation.state === "inactive" ? "Paused" : describeSchedule(entry.revision.schedule, props.zone, "en-US")}</span>
                </span>
                <span className="flex shrink-0 items-center" aria-label={`${entry.automation.name} this week`}>
                  {props.days.map((day) => <span key={dateKey(day)} className="grid w-4.5 place-items-center"><TrackDot state={trackState(mine.filter((item) => inDay(item.at, day, props.zone)))} /></span>)}
                </span>
              </button>
            );
          })}
        </section>
      ) : <p className="text-[13px] text-[var(--wb-muted)]">No automations yet. Ask Workbot to set one up, or use New automation.</p>}
    </aside>
  );
}

/** The width of an element, for switching the week to an agenda when it gets too narrow for seven readable days. */
export function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => setWidth(entries[0]?.contentRect.width ?? null));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

function AgendaRow({ time, children, strong = false }: { time: string; children: ReactNode; strong?: boolean }) {
  return (
    <li className="flex gap-3 py-1">
      <span className={`w-16 shrink-0 pt-2 text-[12px] font-medium leading-4 tabular-nums ${strong ? "text-[var(--wb-text)]" : "text-[var(--wb-muted)]"}`}>{time}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </li>
  );
}

/**
 * The agenda: phones and narrow windows (and the Agenda view). Today onward, day by day: meetings as soft cards with the
 * Workbot runs that were about them inside; other runs as quiet rows; a day's finished routine runs collapse to one line.
 */
export function CalendarAgenda(props: {
  days: LocalDate[]; zone: string; now: number;
  automations: AutomationCalendarItem[]; meetings: CalendarEvent[]; list: readonly ListItem[];
  selection: QuietSelection; onSelect: (selection: QuietSelection) => void; onRunNow(automationId: string): void; busy: boolean;
}) {
  const today = localDateOf(props.now, props.zone);
  const shown = props.days.some((day) => compareDates(day, today) === 0) ? props.days.filter((day) => compareDates(day, today) >= 0) : props.days;
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const needs = needsYou(props.automations, props.list);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto pb-8 sm:pl-2" data-calendar-agenda>
      {needs.failed.slice(0, 2).map((item) => (
        <div key={item.key} className="flex items-center gap-3 rounded-xl bg-[var(--wb-tray)] px-3.5 py-3" data-calendar-needs-you>
          <span aria-hidden className="size-2 shrink-0 rounded-full bg-[var(--wb-danger)]" />
          <button type="button" onClick={() => props.onSelect({ kind: "automation", automationId: item.automationId, itemKey: item.key })} className="flex min-w-0 flex-1 flex-col gap-0.5 rounded text-left focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]">
            <span className="truncate text-[14px] font-semibold leading-5 text-[var(--wb-text)]">{item.name} failed</span>
            <span className="truncate text-[12px] leading-4 text-[var(--wb-muted)]">{formatDate(localDateOf(item.at, props.zone), "en-US", { weekday: "short" })} {formatTime(item.at, props.zone)}{item.run ? `: ${describeRunOutcome(item.run)}` : ""}</span>
          </button>
          <button type="button" disabled={props.busy} onClick={() => props.onRunNow(item.automationId)} className="h-8 shrink-0 rounded-[8px] bg-[var(--wb-surface)] px-3 text-[13px] font-medium text-[var(--wb-text)] disabled:opacity-50 focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]">Try again</button>
        </div>
      ))}
      {needs.blocked.map((entry) => (
        <button key={entry.automation.id} type="button" onClick={() => props.onSelect({ kind: "automation", automationId: entry.automation.id, itemKey: null })} className="flex items-center gap-3 rounded-xl bg-[var(--wb-tray)] px-3.5 py-3 text-left focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]">
          <Lock size={13} strokeWidth={2} aria-hidden className="shrink-0 text-[var(--wb-muted)]" />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-[14px] font-semibold leading-5 text-[var(--wb-text)]">{entry.automation.name}</span>
            <span className="truncate text-[12px] leading-4 text-[var(--wb-muted)]">{entry.automation.needsAttentionReason?.message ?? "Won’t run until it’s fixed."}</span>
          </span>
        </button>
      ))}
      {shown.map((day) => {
        const key = dateKey(day);
        const dayRuns = props.automations.filter((item) => inDay(item.at, day, props.zone));
        const dayMeetings = props.meetings.filter((event) => event.timing.kind === "timed" && inDay(event.timing.start, day, props.zone)).sort((left, right) => (left.timing.kind === "timed" ? left.timing.start : 0) - (right.timing.kind === "timed" ? right.timing.start : 0));
        const location = props.meetings.find((event) => allDayOn(event, day));
        // Runs that were about one of these meetings sit inside its card.
        const attached = new Map<string, AutomationCalendarItem[]>();
        for (const item of dayRuns) {
          const eventId = item.run?.triggerContext?.eventId;
          const meeting = eventId ? dayMeetings.find((event) => event.providerEventId === eventId) : undefined;
          if (meeting) attached.set(meeting.key, [...(attached.get(meeting.key) ?? []), item]);
        }
        const loose = dayRuns.filter((item) => ![...attached.values()].some((list) => list.includes(item)) && item.status !== "failed" && item.status !== "blocked");
        const done = loose.filter((item) => DONE.has(item.status));
        const upcoming = loose.filter((item) => NEXT.has(item.status));
        type Entry = { at: number; node: ReactNode };
        const entries: Entry[] = [
          ...dayMeetings.map((event): Entry => {
            const timing = event.timing.kind === "timed" ? event.timing : null;
            const start = timing?.start ?? 0;
            const end = timing?.end ?? 0;
            const past = end <= props.now;
            const live = start <= props.now && end > props.now;
            const runs = attached.get(event.key) ?? [];
            const selected = props.selection?.kind === "meeting" && props.selection.key === event.key;
            return {
              at: start,
              node: (
                <AgendaRow key={event.key} time={formatTime(start, props.zone)} strong>
                  <div className={`flex flex-col gap-2 rounded-[10px] px-3 py-2.5 ${live ? "bg-[#e2e9ef]" : past ? "bg-[var(--wb-tray)]" : "bg-[#eef2f5]"} ${selected ? "shadow-[inset_0_0_0_1.5px_var(--wb-ink)]" : ""}`}>
                    <button type="button" onClick={() => props.onSelect({ kind: "meeting", key: event.key })} className="flex flex-col gap-0.5 rounded text-left focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]" data-calendar-meeting={event.key}>
                      <span className="flex items-center gap-2">
                        <span className={`min-w-0 flex-1 truncate text-[14px] font-semibold leading-5 ${past ? "text-[var(--wb-muted)]" : "text-[var(--wb-text)]"}`}>{event.title}</span>
                        {live ? <span className="flex shrink-0 items-center gap-1 text-[12px] font-semibold text-[var(--wb-ink)]"><span aria-hidden className="size-1.5 rounded-full bg-[var(--wb-ink)]" />Now</span> : null}
                      </span>
                      <span className="text-[12px] leading-4 text-[var(--wb-muted)] tabular-nums">{formatTime(start, props.zone)} – {formatTime(end, props.zone)}</span>
                    </button>
                    {runs.map((item) => (
                      <button key={item.key} type="button" onClick={() => props.onSelect({ kind: "automation", automationId: item.automationId, itemKey: item.key })} className="flex items-center gap-2 border-t border-[#0116270d] pt-2 text-left focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]">
                        <span className="grid size-3.5 place-items-center"><RunDot status={item.status} selected={false} /></span>
                        <span className="min-w-0 flex-1 truncate text-[12px] font-medium leading-4 text-[var(--wb-text)]">{item.name}</span>
                        <span className="shrink-0 text-[12px] text-[var(--wb-muted)]">{STATUS_WORD[item.status]}</span>
                      </button>
                    ))}
                  </div>
                </AgendaRow>
              ),
            };
          }),
          ...upcoming.map((item): Entry => ({
            at: item.at,
            node: (
              <AgendaRow key={item.key} time={formatTime(item.at, props.zone)}>
                <button type="button" onClick={() => props.onSelect({ kind: "automation", automationId: item.automationId, itemKey: item.key })} className="flex w-full items-center gap-2 rounded py-1.5 text-left focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]" data-calendar-run={item.automationId} data-calendar-status={item.status}>
                  <span className="grid size-3.5 place-items-center"><RunDot status={item.status} selected={false} /></span>
                  <span className="min-w-0 flex-1 truncate text-[13px] leading-4.5 text-[var(--wb-text)]">{item.name}</span>
                </button>
              </AgendaRow>
            ),
          })),
        ].sort((left, right) => left.at - right.at);
        const isToday = compareDates(day, today) === 0;
        return (
          <section key={key} aria-label={formatDate(day, "en-US", { weekday: "long", month: "long", day: "numeric" })} className="flex flex-col gap-1" data-calendar-agenda-day={key}>
            <div className="flex items-baseline justify-between gap-3 pb-1">
              <h3 className="text-[15px] font-semibold leading-5 tracking-[-0.01em] text-[var(--wb-text)]">{isToday ? "Today" : formatDate(day, "en-US", { weekday: "long" })}<span className="font-normal text-[var(--wb-muted)]"> {formatDate(day, "en-US", { month: "short", day: "numeric" })}</span></h3>
              <span className="truncate text-[12px] text-[var(--wb-muted)]">{location ? location.title : null}</span>
            </div>
            {done.length ? (
              <div className="flex flex-col">
                <button type="button" aria-expanded={open[key] === true} onClick={() => setOpen((current) => ({ ...current, [key]: !current[key] }))} className="flex items-center gap-2 rounded-lg bg-[var(--wb-tray)] px-3 py-2 text-left text-[12px] font-medium text-[var(--wb-muted)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]">
                  <span className="grid size-3.5 place-items-center"><RunDot status="succeeded" selected={false} /></span>
                  <span className="flex-1">{done.length} routine {done.length === 1 ? "run" : "runs"} done</span>
                  <ChevronDown size={14} strokeWidth={1.75} aria-hidden className={`text-[var(--wb-faint)] transition-transform duration-150 ${open[key] ? "rotate-180" : ""}`} />
                </button>
                {open[key] ? <ul className="pl-3 pt-1">{done.map((item) => <li key={item.key}><button type="button" onClick={() => props.onSelect({ kind: "automation", automationId: item.automationId, itemKey: item.key })} className="flex w-full items-center gap-3 rounded py-1 text-left text-[12px] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]"><span className="w-16 shrink-0 text-[var(--wb-muted)] tabular-nums">{formatTime(item.at, props.zone)}</span><span className="min-w-0 flex-1 truncate text-[var(--wb-text)]">{item.name}</span></button></li>)}</ul> : null}
              </div>
            ) : null}
            {entries.length ? <ul className="flex flex-col">{entries.map((entry) => entry.node)}</ul> : !done.length ? <p className="text-[13px] text-[var(--wb-muted)]">Nothing scheduled.</p> : null}
          </section>
        );
      })}
    </div>
  );
}

/** Month cells under the quiet calendar: meetings only, then one quiet line for the day's runs. */
export function QuietMonthDaySummary({ items, day, zone }: { items: readonly AutomationCalendarItem[]; day: LocalDate; zone: string }) {
  return <DaySummaryLine items={items} day={day} zone={zone} />;
}
