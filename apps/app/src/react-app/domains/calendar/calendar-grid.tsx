/** @jsxImportSource react */
import { useEffect, useMemo, useRef } from "react"
import { CheckCircle2, Cloud, Loader2, Lock, MinusCircle, Monitor, Plus, XCircle } from "lucide-react"

import { cn } from "@/lib/utils"
import { resolveExtensionIconSrc } from "@/react-app/design-system/extension-icon-src"
import {
  addDays,
  type AutomationCalendarItem,
  CALENDAR_PROVIDER_LABEL,
  type CalendarEvent,
  type CalendarRange,
  compareDates,
  formatDayHeader,
  formatHourLabel,
  formatTime,
  isSameDate,
  layoutOverlappingBlocks,
  type LocalDate,
  localDateOf,
  minutesIntoDay,
  startOfDay,
  dateKey,
  formatDate,
  slotAt,
  type CalendarSlot,
} from "@openwork/calendar"

export const HOUR_HEIGHT_PX = 48
const DAY_MINUTES = 24 * 60
const SCROLL_TO_HOUR = 7

export type CalendarSelection =
  | { kind: "automation"; automationId: string; itemKey: string | null }
  | { kind: "meeting"; key: string }
  | null

type GridProps = {
  polish?: boolean
  range: CalendarRange
  timeZone: string
  now: number
  automations: readonly AutomationCalendarItem[]
  meetings: readonly CalendarEvent[]
  selection: CalendarSelection
  onSelect: (selection: CalendarSelection) => void
  /** Opens "New automation" at an empty half hour; the card is placed near the click. */
  onCreateAt?: (anchor: { slot: CalendarSlot; x: number; y: number }) => void
}

const STATUS_LABEL: Record<AutomationCalendarItem["status"], string> = {
  succeeded: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  skipped: "Skipped",
  running: "Running",
  upcoming: "Scheduled",
  blocked: "Blocked until fixed",
}

export function AutomationStatusIcon({ item, className }: { item: Pick<AutomationCalendarItem, "status" | "executionTarget">; className?: string }) {
  const base = cn("size-3.5 shrink-0", className)
  switch (item.status) {
    case "succeeded": return <CheckCircle2 className={cn(base, "text-green-11")} aria-hidden="true" />
    case "failed": return <XCircle className={cn(base, "text-red-11")} aria-hidden="true" />
    case "running": return <Loader2 className={cn(base, "animate-spin motion-reduce:animate-none")} aria-hidden="true" />
    case "blocked": return <Lock className={cn(base, "text-muted-foreground")} aria-hidden="true" />
    case "cancelled":
    case "skipped": return <MinusCircle className={cn(base, "text-muted-foreground")} aria-hidden="true" />
    case "upcoming": return item.executionTarget === "cloud"
      ? <Cloud className={cn(base, "text-blue-11")} aria-hidden="true" />
      : <Monitor className={cn(base, "text-blue-11")} aria-hidden="true" />
  }
}

function automationBlockClass(item: AutomationCalendarItem, selected: boolean) {
  return cn(
    "flex w-full min-w-0 items-start gap-1 overflow-hidden rounded-md border px-1.5 py-1 text-left text-xs leading-4 transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
    item.status === "blocked"
      ? "border-dashed border-border bg-muted/60 text-muted-foreground hover:bg-muted"
      : item.status === "upcoming"
        ? "border-blue-6 bg-blue-2 text-blue-12 hover:bg-blue-3"
        : item.status === "failed"
          ? "border-red-6 bg-red-2 text-foreground hover:bg-red-3"
          : "border-blue-5 bg-blue-3 text-blue-12 hover:bg-blue-4",
    selected && "ring-2 ring-blue-8",
  )
}

function meetingBlockClass(selected: boolean) {
  return cn(
    "flex w-full min-w-0 flex-col overflow-hidden rounded-md border border-gray-7 bg-background px-1.5 py-1 text-left text-xs leading-4 text-foreground transition-colors duration-150 hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
    selected && "ring-2 ring-gray-8",
  )
}

function automationAriaLabel(item: AutomationCalendarItem, timeZone: string) {
  return `${item.name}, ${STATUS_LABEL[item.status]}, ${formatTime(item.at, timeZone)}`
}

function AutomationBlock(props: { item: AutomationCalendarItem; timeZone: string; selected: boolean; compact?: boolean; fill?: boolean; onSelect: () => void }) {
  const { item } = props
  return (
    <button
      type="button"
      data-calendar-automation={item.automationId}
      data-calendar-status={item.status}
      aria-pressed={props.selected}
      aria-label={automationAriaLabel(item, props.timeZone)}
      title={`${item.name} · ${STATUS_LABEL[item.status]}`}
      className={cn(automationBlockClass(item, props.selected), props.fill && "h-full")}
      onClick={props.onSelect}
    >
      <AutomationStatusIcon item={item} className="mt-px" />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{item.name}</span>
        {props.compact ? null : (
          <span className="block truncate opacity-75">
            {formatTime(item.at, props.timeZone)}{item.status === "blocked" ? " · Needs attention" : ""}
          </span>
        )}
      </span>
    </button>
  )
}

function MeetingBlock(props: { polish?: boolean; event: CalendarEvent; timeZone: string; selected: boolean; compact?: boolean; fill?: boolean; onSelect: () => void }) {
  const { event } = props
  const source = CALENDAR_PROVIDER_LABEL[event.provider]
  return (
    <button
      type="button"
      data-calendar-meeting={event.key}
      data-calendar-provider={event.provider}
      aria-pressed={props.selected}
      aria-label={`${event.title}, ${source}${event.timing.kind === "timed" ? `, ${formatTime(event.timing.start, props.timeZone)}` : ", all day"}`}
      title={`${event.title}, ${source}`}
      className={cn(meetingBlockClass(props.selected), props.fill && "h-full")}
      onClick={props.onSelect}
    >
      {props.polish ? (
        <span className="flex min-w-0 items-start gap-1.5 font-medium">
          <img aria-hidden="true" alt="" data-calendar-provider-logo={event.provider} className="size-3 shrink-0" src={resolveExtensionIconSrc(event.provider === "google" ? "/ext-google-workspace.svg" : "/ext-microsoft-365.svg")} />
          <span className={cn("min-w-0 flex-1", props.compact ? "truncate" : "line-clamp-2 break-words")}>{event.title}</span>
        </span>
      ) : <span className="truncate font-medium">{event.title} <span className="font-normal text-muted-foreground">{source}</span></span>}
      {props.compact || event.timing.kind !== "timed" ? null : (
        <span className="truncate text-muted-foreground">{formatTime(event.timing.start, props.timeZone)}</span>
      )}
    </button>
  )
}

function allDayCovers(event: CalendarEvent, date: LocalDate): boolean {
  return event.timing.kind === "all_day"
    && compareDates(event.timing.startDate, date) <= 0
    && compareDates(event.timing.endDate, date) > 0
}

type DayBlock =
  | { key: string; start: number; end: number; kind: "automation"; item: AutomationCalendarItem }
  | { key: string; start: number; end: number; kind: "meeting"; event: CalendarEvent }

function blocksForDay(date: LocalDate, timeZone: string, automations: readonly AutomationCalendarItem[], meetings: readonly CalendarEvent[]): DayBlock[] {
  const dayStart = startOfDay(date, timeZone)
  const dayEnd = startOfDay(addDays(date, 1), timeZone)
  const blocks: DayBlock[] = []
  for (const item of automations) {
    if (item.at >= dayStart && item.at < dayEnd) blocks.push({ key: item.key, start: item.at, end: Math.min(item.end, dayEnd), kind: "automation", item })
  }
  for (const event of meetings) {
    if (event.timing.kind !== "timed") continue
    if (event.timing.end <= dayStart || event.timing.start >= dayEnd) continue
    blocks.push({ key: event.key, start: Math.max(event.timing.start, dayStart), end: Math.min(event.timing.end, dayEnd), kind: "meeting", event })
  }
  return blocks
}

function isSelected(selection: CalendarSelection, block: DayBlock): boolean {
  if (!selection) return false
  if (block.kind === "meeting") return selection.kind === "meeting" && selection.key === block.event.key
  return selection.kind === "automation" && (selection.itemKey === block.item.key || (selection.itemKey === null && selection.automationId === block.item.automationId))
}

/** Day and week views: an all-day lane above a 24-hour grid with a current-time line. */
export function CalendarTimeGrid(props: GridProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const today = localDateOf(props.now, props.timeZone)
  const columns = `3.5rem repeat(${props.range.days.length}, minmax(0, 1fr))`
  const allDay = props.meetings.filter((event) => event.timing.kind === "all_day")
  const showAllDayLane = props.range.days.some((day) => allDay.some((event) => allDayCovers(event, day)))

  useEffect(() => {
    const node = scrollRef.current
    // Hour labels are centered on their lines. Land half an hour earlier so the first label is fully visible.
    if (node) node.scrollTop = SCROLL_TO_HOUR * HOUR_HEIGHT_PX - HOUR_HEIGHT_PX / 2
  }, [props.range.start])

  const dayBlocks = useMemo(() => props.range.days.map((day) => {
    const blocks = blocksForDay(day, props.timeZone, props.automations, props.meetings)
    return { day, blocks, placements: layoutOverlappingBlocks(blocks) }
  }), [props.automations, props.meetings, props.range.days, props.timeZone])

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-calendar-grid={props.range.view}>
      <div className="grid border-b border-border" style={{ gridTemplateColumns: columns }}>
        <div />
        {props.range.days.map((day) => {
          const header = formatDayHeader(day)
          const isToday = isSameDate(day, today)
          return (
            <div key={`${day.year}-${day.month}-${day.day}`} className="flex min-w-0 flex-col items-center justify-center gap-0.5 border-l border-border px-1 py-2 text-xs sm:flex-row sm:items-baseline sm:justify-start sm:gap-1.5 sm:px-2" data-calendar-day={`${day.year}-${String(day.month).padStart(2, "0")}-${String(day.day).padStart(2, "0")}`}>
              <span className="text-muted-foreground">{header.weekday}</span>
              <span className={cn("font-medium", isToday && "flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground")}>{header.day}</span>
            </div>
          )
        })}
      </div>
      {showAllDayLane ? (
        <div className="grid border-b border-border" style={{ gridTemplateColumns: columns }} data-calendar-all-day>
          <div className="px-2 py-1 text-[11px] text-muted-foreground">All day</div>
          {props.range.days.map((day) => (
            <div key={`all-day-${day.year}-${day.month}-${day.day}`} className="flex min-w-0 flex-col gap-0.5 border-l border-border p-0.5">
              {allDay.filter((event) => allDayCovers(event, day)).map((event) => (
                <MeetingBlock
                  polish={props.polish}
                  key={event.key}
                  event={event}
                  timeZone={props.timeZone}
                  compact
                  selected={props.selection?.kind === "meeting" && props.selection.key === event.key}
                  onSelect={() => props.onSelect({ kind: "meeting", key: event.key })}
                />
              ))}
            </div>
          ))}
        </div>
      ) : null}
      <div ref={scrollRef} data-calendar-scroll className="min-h-0 flex-1 overflow-y-auto">
        <div className="relative grid" style={{ gridTemplateColumns: columns, height: 24 * HOUR_HEIGHT_PX }}>
          <div className="relative">
            {Array.from({ length: 24 }, (_, hour) => (
              <span key={hour} data-calendar-hour={hour} className="absolute right-2 -translate-y-1/2 text-xs text-muted-foreground" style={{ top: hour * HOUR_HEIGHT_PX }}>
                {hour === 0 ? "" : formatHourLabel(hour)}
              </span>
            ))}
          </div>
          {dayBlocks.map(({ day, blocks, placements }) => {
            const isToday = isSameDate(day, today)
            return (
              <div
                key={`col-${day.year}-${day.month}-${day.day}`}
                className="relative border-l border-border"
                style={{ backgroundImage: `repeating-linear-gradient(to bottom, transparent 0, transparent ${HOUR_HEIGHT_PX - 1}px, var(--border) ${HOUR_HEIGHT_PX - 1}px, var(--border) ${HOUR_HEIGHT_PX}px)` }}
              >
                {props.onCreateAt ? Array.from({ length: 48 }, (_, index) => {
                  // Empty half hours: hover shows where a new automation would go; a click opens the card there.
                  const slot = slotAt(day, index * 30, props.timeZone)
                  const time = formatTime(slot.at, props.timeZone)
                  return (
                    <button
                      key={`slot-${index}`}
                      type="button"
                      tabIndex={-1}
                      aria-label={`New automation on ${formatDate(day)} at ${time}`}
                      data-calendar-slot={`${dateKey(day)}T${String(slot.hour).padStart(2, "0")}:${String(slot.minute).padStart(2, "0")}`}
                      className="group absolute inset-x-0 z-0 px-0.5 focus-visible:outline-none"
                      style={{ top: index * (HOUR_HEIGHT_PX / 2) + 1, height: HOUR_HEIGHT_PX / 2 - 2 }}
                      onClick={(event) => props.onCreateAt?.({ slot, x: event.clientX + 12, y: event.clientY - 28 })}
                    >
                      <span className="hidden h-full items-center gap-1 rounded-md border border-dashed border-foreground/35 bg-foreground/[0.04] px-1.5 text-xs group-hover:flex">
                        <Plus className="size-3 shrink-0" aria-hidden="true" />
                        <span className="truncate font-medium">New automation</span>
                        <span className="shrink-0 text-muted-foreground">{time}</span>
                      </span>
                    </button>
                  )
                }) : null}
                {blocks.map((block) => {
                  const placement = placements.get(block.key) ?? { column: 0, columns: 1 }
                  const top = Math.min(minutesIntoDay(block.start, day, props.timeZone), DAY_MINUTES) / 60 * HOUR_HEIGHT_PX
                  const bottom = Math.min(minutesIntoDay(block.end, day, props.timeZone), DAY_MINUTES) / 60 * HOUR_HEIGHT_PX
                  const height = Math.max(bottom - top, HOUR_HEIGHT_PX / 2) - 2
                  const width = 100 / placement.columns
                  const compact = height < HOUR_HEIGHT_PX * 0.75
                  return (
                    <div
                      key={block.key}
                      className="absolute px-0.5"
                      style={{ top: top + 1, height, left: `${placement.column * width}%`, width: `${width}%`, zIndex: block.kind === "automation" ? 2 : 1 }}
                    >
                      {block.kind === "automation" ? (
                        <AutomationBlock
                          item={block.item}
                          timeZone={props.timeZone}
                          compact={compact}
                          fill
                          selected={isSelected(props.selection, block)}
                          onSelect={() => props.onSelect({ kind: "automation", automationId: block.item.automationId, itemKey: block.item.key })}
                        />
                      ) : (
                        <MeetingBlock
                          polish={props.polish}
                          event={block.event}
                          timeZone={props.timeZone}
                          compact={compact}
                          fill
                          selected={isSelected(props.selection, block)}
                          onSelect={() => props.onSelect({ kind: "meeting", key: block.event.key })}
                        />
                      )}
                    </div>
                  )
                })}
                {isToday ? (
                  <div
                    data-calendar-now
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-x-0 z-10 h-0.5 bg-red-9"
                    style={{ top: minutesIntoDay(props.now, day, props.timeZone) / 60 * HOUR_HEIGHT_PX }}
                  >
                    <span className="absolute -left-1 -top-[3px] size-2 rounded-full bg-red-9" />
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

const MONTH_CELL_LIMIT = 3

/** Month view: one cell per day with the first few entries and a count of the rest. */
export function CalendarMonthGrid(props: GridProps & { anchorMonth: number; onOpenDay: (date: LocalDate) => void }) {
  const today = localDateOf(props.now, props.timeZone)
  const weeks = props.range.days.length / 7
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
    <div className="sticky top-0 z-10 grid grid-cols-7 border-b border-border bg-background" aria-hidden="true">
      {props.range.days.slice(0, 7).map((day) => (
        <div key={`h-${day.year}-${day.month}-${day.day}`} className="border-r border-border px-2 py-1.5 text-xs text-muted-foreground">{formatDayHeader(day).weekday}</div>
      ))}
    </div>
    <div className="grid min-h-full grid-cols-7" style={{ gridTemplateRows: `repeat(${weeks}, minmax(7.5rem, 1fr))` }} data-calendar-grid="month">
      {props.range.days.map((day) => {
        const timed = blocksForDay(day, props.timeZone, props.automations, props.meetings).sort((left, right) => left.start - right.start)
        const allDay = props.meetings.filter((event) => allDayCovers(event, day))
        const entries = [...allDay.map((event) => ({ kind: "all_day" as const, event })), ...timed]
        const isToday = isSameDate(day, today)
        const outside = day.month !== props.anchorMonth
        return (
          <div key={`m-${day.year}-${day.month}-${day.day}`} className={cn("flex min-w-0 flex-col gap-0.5 border-b border-r border-border p-1", outside && "bg-muted/30")}>
            <button
              type="button"
              className={cn("self-start rounded px-1 text-xs hover:bg-muted", outside ? "text-muted-foreground" : "text-foreground", isToday && "bg-primary text-primary-foreground hover:bg-primary")}
              aria-label={`Open ${formatDayHeader(day).weekday} ${day.day}`}
              onClick={() => props.onOpenDay(day)}
            >
              {day.day}
            </button>
            {entries.slice(0, MONTH_CELL_LIMIT).map((entry) => entry.kind === "automation" ? (
              <AutomationBlock
                key={entry.key}
                item={entry.item}
                timeZone={props.timeZone}
                compact
                selected={isSelected(props.selection, entry)}
                onSelect={() => props.onSelect({ kind: "automation", automationId: entry.item.automationId, itemKey: entry.item.key })}
              />
            ) : (
              <MeetingBlock
                polish={props.polish}
                key={entry.event.key}
                event={entry.event}
                timeZone={props.timeZone}
                compact
                selected={props.selection?.kind === "meeting" && props.selection.key === entry.event.key}
                onSelect={() => props.onSelect({ kind: "meeting", key: entry.event.key })}
              />
            ))}
            {entries.length > MONTH_CELL_LIMIT ? (
              <button type="button" className="self-start px-1 text-[11px] text-muted-foreground hover:text-foreground" onClick={() => props.onOpenDay(day)}>
                {entries.length - MONTH_CELL_LIMIT} more
              </button>
            ) : null}
          </div>
        )
      })}
    </div>
    </div>
  )
}
