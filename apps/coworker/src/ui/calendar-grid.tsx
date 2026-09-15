import { useEffect, useMemo, useRef, useState } from "react";
import type { CalendarItem } from "@/lib/calendar";
import { ActivityIcon } from "@/ui/kit";
import { CalendarIcon } from "@/ui/main-content-switch";

export type CalendarMode = "day" | "week" | "month";

export function plusDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  next.setHours(0, 0, 0, 0);
  return next;
}

export function calendarDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function calendarRange(at: number, mode: CalendarMode) {
  const selected = new Date(at);
  selected.setHours(0, 0, 0, 0);
  const start = new Date(selected);
  if (mode === "month") start.setDate(1);
  if (mode !== "day")
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  start.setHours(0, 0, 0, 0);
  const monthDays = new Date(
    selected.getFullYear(),
    selected.getMonth() + 1,
    0,
  ).getDate();
  const leading =
    (new Date(selected.getFullYear(), selected.getMonth(), 1).getDay() + 6) % 7;
  const count =
    mode === "day"
      ? 1
      : mode === "week"
        ? 7
        : Math.max(5, Math.ceil((leading + monthDays) / 7)) * 7;
  return {
    start,
    end: plusDays(start, count),
    days: Array.from({ length: count }, (_, index) => plusDays(start, index)),
  };
}

const HOUR_HEIGHT = 64;
const MIN_ITEM_HEIGHT = 36;
const DAY_HEIGHT = 24 * HOUR_HEIGHT;
const clockMinutes = (at: number) => {
  const date = new Date(at);
  return date.getHours() * 60 + date.getMinutes();
};
const time = (at: number) =>
  new Date(at).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
const onDay = (item: CalendarItem, day: Date) =>
  item.startsAt < plusDays(day, 1).getTime() &&
  (item.endsAt ?? item.startsAt + 1) > day.getTime();

/** Visual minimums participate in packing, so even five-minute entries remain separate targets. */
function timedItems(items: CalendarItem[], day: Date) {
  const end = plusDays(day, 1).getTime();
  const positions = items
    .filter((item) => onDay(item, day))
    .map((item) => {
      const starts = Math.max(item.startsAt, day.getTime());
      const minute = clockMinutes(starts);
      let finish =
        item.endsAt === null
          ? minute + 30
          : item.endsAt >= end
            ? 1440
            : clockMinutes(item.endsAt);
      // A repeated clock hour can make the wall-clock end precede the start.
      if (finish <= minute)
        finish =
          minute + Math.max(1, ((item.endsAt ?? starts) - starts) / 60000);
      const top = Math.min(
        (minute * HOUR_HEIGHT) / 60,
        DAY_HEIGHT - MIN_ITEM_HEIGHT,
      );
      const bottom = Math.min(
        DAY_HEIGHT,
        Math.max(top + MIN_ITEM_HEIGHT, (finish * HOUR_HEIGHT) / 60),
      );
      return { item, top, bottom, lane: 0, lanes: 1 };
    })
    .sort(
      (a, b) =>
        a.top - b.top ||
        b.bottom - a.bottom ||
        a.item.id.localeCompare(b.item.id),
    );
  let group: typeof positions = [];
  let laneEnds: number[] = [];
  let groupEnd = 0;
  let maxLanes = 1;
  const finishGroup = () => {
    for (const position of group) position.lanes = laneEnds.length;
    maxLanes = Math.max(maxLanes, laneEnds.length);
    group = [];
    laneEnds = [];
  };
  for (const position of positions) {
    if (position.top >= groupEnd) finishGroup();
    const free = laneEnds.findIndex((bottom) => bottom <= position.top);
    position.lane = free < 0 ? laneEnds.length : free;
    laneEnds[position.lane] = position.bottom;
    group.push(position);
    groupEnd = Math.max(groupEnd, position.bottom);
  }
  finishGroup();
  return { positions, minWidth: Math.max(80, maxLanes * 48) };
}

export function CalendarGrid({
  mode,
  days,
  date,
  items,
  active,
  canCreate,
  selectedId,
  name,
  onOpen,
  onCreate,
  onDay: openDay,
}: {
  mode: CalendarMode;
  days: Date[];
  date: number;
  items: CalendarItem[];
  active: boolean;
  canCreate: boolean;
  selectedId?: string;
  name: (slug: string) => string;
  onOpen: (item: CalendarItem, opener: HTMLElement) => void;
  onCreate: (at: number, opener: HTMLElement) => void;
  onDay: (day: Date) => void;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const shownMode = useRef<CalendarMode | null>(null);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 60000);
    return () => window.clearInterval(timer);
  }, [active]);
  useEffect(() => {
    if (!active || !scroll.current || shownMode.current === mode) return;
    scroll.current.scrollTop = mode === "month" ? 0 : 7 * HOUR_HEIGHT;
    scroll.current.scrollLeft = 0;
    shownMode.current = mode;
  }, [active, mode]);
  const layout = useMemo(
    () => (mode === "month" ? [] : days.map((day) => timedItems(items, day))),
    [days, items, mode],
  );
  const today = calendarDate(new Date(now));
  const describe = (item: CalendarItem) =>
    `${item.title}. ${time(item.startsAt)}${item.endsAt === null ? "" : ` - ${time(item.endsAt)}`}. ${item.planned ? "Scheduled" : "Actual"} / ${item.status.replaceAll("_", " ")}. ${item.kind === "event" ? "Event" : "Responsibility"}. ${item.coworkerSlugs.map(name).join(", ")}`;
  const colors = (item: CalendarItem) =>
    `${item.kind === "event" ? "border-l-spark text-snow bg-panel" : "border-l-mint text-snow bg-panel"} ${item.planned ? "border-dashed" : "border-solid"} ${selectedId === item.id ? "ring-2 ring-inset ring-spark/60" : ""}`;

  if (mode === "month")
    return (
      <div
        ref={scroll}
        className="min-h-0 flex-1 overflow-auto"
        tabIndex={0}
        aria-label="Month calendar; scroll horizontally in a narrow window"
        data-testid="calendar-month"
      >
        <div
          className="grid min-h-full min-w-[560px] grid-cols-7"
          style={{
            gridTemplateRows: `24px repeat(${days.length / 7}, minmax(120px, 1fr))`,
          }}
        >
          {days.slice(0, 7).map((day) => (
            <div
              key={day.getTime()}
              className="sticky top-0 z-10 border-b border-line bg-ink px-2 py-1.5 text-[9px] font-medium uppercase leading-3 tracking-wider text-mist"
            >
              {day.toLocaleDateString(undefined, { weekday: "short" })}
            </div>
          ))}
          {days.map((day) => {
            const rows = items.filter((item) => onDay(item, day));
            const isToday = calendarDate(day) === today;
            const adjacent = day.getMonth() !== new Date(date).getMonth();
            return (
              <section
                key={day.getTime()}
                data-date={calendarDate(day)}
                className={`group relative min-w-0 border-b border-r border-line ${isToday ? "bg-spark/5" : adjacent ? "bg-black/10" : ""}`}
              >
                <button
                  type="button"
                  disabled={!canCreate}
                  className="absolute inset-0 outline-none hover:bg-white/[0.025] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-spark/60"
                  aria-label={`Create event on ${day.toLocaleDateString(undefined, { dateStyle: "full" })} at 9 AM`}
                  onClick={(event) => {
                    const at = new Date(day);
                    at.setHours(9, 0, 0, 0);
                    onCreate(at.getTime(), event.currentTarget);
                  }}
                />
                <div className="pointer-events-none relative flex items-center justify-between px-1.5 py-1">
                  <button
                    type="button"
                    className={`pointer-events-auto flex size-6 items-center justify-center rounded-full text-[11px] ${isToday ? "bg-spark font-semibold text-ink" : adjacent ? "text-mist/50" : "text-mist hover:bg-white/5"}`}
                    onClick={() => openDay(day)}
                    aria-label={`Show ${day.toLocaleDateString()} in Day view`}
                  >
                    {day.getDate()}
                  </button>
                  {canCreate ? (
                    <span
                      aria-hidden="true"
                      className="px-2 text-xs text-mist opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
                    >
                      +
                    </span>
                  ) : null}
                </div>
                <div className="pointer-events-none relative space-y-0.5 px-1 pb-1">
                  {rows.slice(0, 3).map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      data-testid="calendar-item"
                      data-kind={item.kind}
                      data-planned={item.planned}
                      aria-label={describe(item)}
                      title={describe(item)}
                      onClick={(event) => onOpen(item, event.currentTarget)}
                      className={`pointer-events-auto flex w-full min-w-0 items-center gap-1 overflow-hidden rounded border border-line border-l-2 px-1 py-0.5 text-left text-[10px] leading-[14px] outline-none hover:brightness-125 focus-visible:ring-2 focus-visible:ring-spark ${colors(item)}`}
                    >
                      <span className="shrink-0 text-[10px] text-mist">
                        {time(item.startsAt)}
                      </span>
                      <span className="truncate font-medium">{item.title}</span>
                    </button>
                  ))}
                  {rows.length > 3 ? (
                    <button
                      type="button"
                      onClick={() => openDay(day)}
                      className="pointer-events-auto rounded px-1 py-0.5 text-[10px] font-medium leading-3 text-mist hover:bg-white/5 hover:text-snow"
                    >
                      +{rows.length - 3} more
                    </button>
                  ) : null}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    );

  const columns = `56px ${layout.map((column) => `minmax(${column.minWidth}px, 1fr)`).join(" ")}`;
  return (
    <div
      ref={scroll}
      className="min-h-0 flex-1 overflow-auto"
      tabIndex={0}
      aria-label={`${mode === "day" ? "Day" : "Week"} calendar; scroll for all 24 hours and horizontally in a narrow window`}
      data-testid={`calendar-${mode}`}
    >
      <div
        className="grid"
        style={{
          gridTemplateColumns: columns,
          minWidth:
            56 + layout.reduce((sum, column) => sum + column.minWidth, 0),
        }}
      >
        <div className="sticky left-0 top-0 z-40 flex h-12 items-end justify-end border-b border-line bg-ink px-2 pb-2 text-[9px] text-mist">
          LOCAL
        </div>
        {days.map((day) => (
          <button
            type="button"
            key={day.getTime()}
            onClick={() => openDay(day)}
            className={`sticky top-0 z-30 flex h-12 items-center justify-center gap-1.5 border-b border-l border-line bg-ink text-[11px] ${calendarDate(day) === today ? "text-spark" : "text-mist"}`}
            aria-label={`Show ${day.toLocaleDateString()} in Day view`}
          >
            <span>
              {day.toLocaleDateString(undefined, { weekday: "short" })}
            </span>
            <span
              className={`flex size-7 items-center justify-center rounded-full text-base ${calendarDate(day) === today ? "bg-spark text-ink" : "text-snow"}`}
            >
              {day.getDate()}
            </span>
          </button>
        ))}
        <div
          className="sticky left-0 z-30 border-r border-line bg-ink"
          style={{ height: DAY_HEIGHT }}
          aria-hidden="true"
        >
          {Array.from({ length: 24 }, (_, hour) => (
            <span
              key={hour}
              className="absolute right-2 text-[10px] tabular-nums text-mist/70"
              style={{ top: hour * HOUR_HEIGHT + (hour === 0 ? 3 : -7) }}
            >
              {String(hour).padStart(2, "0")}:00
            </span>
          ))}
        </div>
        {days.map((day, index) => {
          const isToday = calendarDate(day) === today;
          return (
            <section
              key={day.getTime()}
              aria-label={day.toLocaleDateString(undefined, {
                dateStyle: "full",
              })}
              data-date={calendarDate(day)}
              className={`relative border-r border-line ${isToday ? "bg-spark/[0.025]" : ""}`}
              style={{ height: DAY_HEIGHT }}
            >
              {Array.from({ length: 48 }, (_, slot) => {
                const at = new Date(day);
                at.setHours(Math.floor(slot / 2), (slot % 2) * 30, 0, 0);
                const exists =
                  at.getHours() === Math.floor(slot / 2) &&
                  at.getMinutes() === (slot % 2) * 30;
                const label = exists
                  ? `Create event ${at.toLocaleString(undefined, { dateStyle: "full", timeStyle: "long" })}`
                  : "This time does not exist because the clock changes";
                return (
                  <button
                    key={slot}
                    type="button"
                    disabled={!canCreate || !exists}
                    tabIndex={slot === 18 ? 0 : -1}
                    data-testid="calendar-time-slot"
                    data-starts-at={exists ? at.getTime() : undefined}
                    aria-label={label}
                    title={label}
                    onClick={(event) =>
                      onCreate(at.getTime(), event.currentTarget)
                    }
                    onKeyDown={(event) => {
                      if (event.key !== "ArrowUp" && event.key !== "ArrowDown")
                        return;
                      event.preventDefault();
                      const slots = [
                        ...(event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                          '[data-testid="calendar-time-slot"]:not(:disabled)',
                        ) ?? []),
                      ];
                      const next =
                        slots.indexOf(event.currentTarget) +
                        (event.key === "ArrowUp" ? -1 : 1);
                      slots[next]?.focus();
                    }}
                    className={`absolute inset-x-0 outline-none hover:bg-spark/5 focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-spark/60 ${slot % 2 === 0 ? "border-t border-line" : "border-t border-dashed border-white/[0.035]"} ${!exists ? "bg-white/5" : ""}`}
                    style={{
                      top: (slot * HOUR_HEIGHT) / 2,
                      height: HOUR_HEIGHT / 2,
                    }}
                  />
                );
              })}
              {layout[index]?.positions.map(
                ({ item, top, bottom, lane, lanes }) => (
                  <button
                    key={item.id}
                    type="button"
                    data-testid="calendar-item"
                    data-kind={item.kind}
                    data-planned={item.planned}
                    data-starts-at={item.startsAt}
                    aria-label={describe(item)}
                    title={`${describe(item)}${item.endsAt === null ? ". Duration not recorded. Uses a 30-minute layout default, with a minimum readable height." : ""}`}
                    onClick={(event) => onOpen(item, event.currentTarget)}
                    className={`absolute z-10 flex min-w-0 flex-col overflow-hidden rounded-md border border-line border-l-2 px-1.5 py-0.5 text-left outline-none transition-[filter] hover:brightness-125 focus-visible:z-20 focus-visible:ring-2 focus-visible:ring-spark ${colors(item)}`}
                    style={{
                      top,
                      height: bottom - top - 1,
                      left: `calc(${(lane * 100) / lanes}% + 2px)`,
                      width: `calc(${100 / lanes}% - 4px)`,
                    }}
                  >
                    <span
                      className={`flex h-3.5 shrink-0 items-center gap-1 text-[10px] leading-[14px] ${item.kind === "event" ? "text-spark" : "text-mint"}`}
                    >
                      {lanes === 1 ? (
                        <span className="shrink-0 [&_svg]:size-2.5">
                          {item.kind === "event" ? (
                            <CalendarIcon />
                          ) : (
                            <ActivityIcon />
                          )}
                        </span>
                      ) : null}
                      <span className="truncate">
                        {time(item.startsAt)}
                        {item.endsAt !== null && lanes === 1
                          ? ` - ${time(item.endsAt)}`
                          : ""}
                      </span>
                    </span>
                    <span className="shrink-0 truncate text-[11px] font-semibold leading-[14px]">
                      {item.title}
                    </span>
                    {bottom - top >= 52 ? (
                      <span
                        className={`shrink-0 truncate text-[9px] leading-[12px] ${item.kind === "event" ? "text-mist" : "text-mint/80"}`}
                      >
                        {item.planned ? "Scheduled" : "Actual"} /{" "}
                        {item.kind === "event" ? "Event" : "Responsibility"}
                      </span>
                    ) : null}
                    {bottom - top >= 84 ? (
                      <span className="mt-0.5 truncate text-[10px] text-mist">
                        {item.coworkerSlugs.map(name).join(", ")}
                      </span>
                    ) : null}
                  </button>
                ),
              )}
              {isToday ? (
                <div
                  className="pointer-events-none absolute inset-x-0 z-20 border-t border-rose/80"
                  data-testid="calendar-now"
                  style={{ top: (clockMinutes(now) * HOUR_HEIGHT) / 60 }}
                >
                  <span className="absolute -left-1 -top-1 size-2 rounded-full bg-rose" />
                  <span className="sr-only">Current time {time(now)}</span>
                </div>
              ) : null}
            </section>
          );
        })}
      </div>
    </div>
  );
}
