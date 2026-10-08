import type { AutomationSchedule } from "@openwork/types/automations"

import { formatTime } from "./format"
import { addDays, localDateOf, weekdayOf, zonedParts, zonedTimeToInstant, type LocalDate } from "./time"

/**
 * Creating an Automation from a calendar slot: the slot a person picked, the
 * ways it can repeat from there, and a name drawn from what they asked for.
 * Shared by the desktop Calendar and Workbot's so both offer the same choices.
 */

export type SlotRepeat = "once" | "weekly" | "weekdays" | "daily"

export type CalendarSlot = {
  /** The local day the slot is on, in the display time zone. */
  date: LocalDate
  hour: number
  minute: number
  /** The slot's start instant. */
  at: number
  timeZone: string
}

const WEEKDAY_PLURAL = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"]

/** The slot a click lands in: the hour row clicked, at :00 or :30 by which half. */
export function slotAt(date: LocalDate, minutesIntoDay: number, timeZone: string): CalendarSlot {
  const snapped = Math.max(0, Math.min(23 * 60 + 30, Math.floor(minutesIntoDay / 30) * 30))
  const hour = Math.floor(snapped / 60)
  const minute = snapped % 60
  return { date, hour, minute, at: zonedTimeToInstant({ ...date, hour, minute }, timeZone), timeZone }
}

/** Where "New automation" without a slot starts: the next full hour today, or 9 AM tomorrow after 6 PM. */
export function nextOpenSlot(now: number, timeZone: string): CalendarSlot {
  const parts = zonedParts(now, timeZone)
  const today = localDateOf(now, timeZone)
  if (parts.hour >= 18) return slotAt(addDays(today, 1), 9 * 60, timeZone)
  return slotAt(today, (parts.hour + 1) * 60, timeZone)
}

export type SlotScheduleOption = { id: SlotRepeat; label: string; schedule: AutomationSchedule }

/** Once at the slot, or every slot weekday / every weekday / every day at the slot's time. */
export function slotScheduleOptions(slot: CalendarSlot): SlotScheduleOption[] {
  const weekday = weekdayOf(slot.date)
  const time = { hour: slot.hour, minute: slot.minute }
  return [
    { id: "once", label: "Once", schedule: { kind: "once", timezone: slot.timeZone, at: slot.at } },
    { id: "weekly", label: WEEKDAY_PLURAL[weekday] ?? "Weekly", schedule: { kind: "weekly", timezone: slot.timeZone, daysOfWeek: [weekday], ...time } },
    { id: "weekdays", label: "Weekdays", schedule: { kind: "weekly", timezone: slot.timeZone, daysOfWeek: [1, 2, 3, 4, 5], ...time } },
    { id: "daily", label: "Every day", schedule: { kind: "daily", timezone: slot.timeZone, ...time } },
  ]
}

/** Repeating on the slot's own weekday is what people pick most from a week view. */
export const DEFAULT_SLOT_REPEAT: SlotRepeat = "weekly"

/** "Tue, Oct 13 at 11:00 AM" for the card's header. */
export function slotLabel(slot: CalendarSlot, locale = "en-US"): string {
  const day = new Intl.DateTimeFormat(locale, { weekday: "short", month: "short", day: "numeric", timeZone: slot.timeZone }).format(new Date(slot.at))
  return `${day} at ${formatTime(slot.at, slot.timeZone, locale)}`
}

const NAME_LIMIT = 60

/** A short name from the request: its first sentence or line, capped at 60 characters on a word. */
export function automationNameFrom(instructions: string): string {
  const first = instructions.trim().split(/\n|(?<=[.!?])\s/)[0]?.trim().replace(/[.!?]+$/, "") ?? ""
  if (!first) return "New automation"
  const capped = first.length <= NAME_LIMIT ? first : `${first.slice(0, NAME_LIMIT).replace(/\s+\S*$/, "")}…`
  return capped.charAt(0).toUpperCase() + capped.slice(1)
}
