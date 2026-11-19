import { z } from "zod"

export const calendarTimeZoneSchema = z.string().trim().min(1).max(128).refine((timeZone) => {
  if (/^[+-]/.test(timeZone)) return false
  try { new Intl.DateTimeFormat("en", { timeZone }); return true } catch { return false }
}, "Pass a valid IANA timeZone, for example America/New_York.")

const untilSchema = z.union([z.string().date(), z.string().datetime({ offset: true })])
  .describe("Inclusive end: RFC3339 date-time with offset, or YYYY-MM-DD (through 23:59:59 UTC on that date).")
export const calendarRecurrenceSchema = z.object({
  frequency: z.enum(["daily", "weekly", "monthly", "yearly"]),
  interval: z.number().int().min(1).max(99).optional().describe("Repeat every N periods; defaults to 1."),
  byWeekday: z.array(z.enum(["MO", "TU", "WE", "TH", "FR", "SA", "SU"])).min(1).max(7).optional()
    .describe("Weekdays to repeat on, e.g. MO and WE for a twice-weekly recurring meeting."),
  count: z.number().int().min(1).max(730).optional().describe("Total occurrences, including the first; mutually exclusive with until."),
  until: untilSchema.optional(),
}).strict().superRefine((input, ctx) => {
  if ((input.count === undefined) === (input.until === undefined)) {
    ctx.addIssue({ code: "custom", message: "Provide exactly one of count or until; unbounded recurring series are not supported." })
  }
}).describe("Structured recurrence for a recurring meeting (repeat weekly, daily, monthly or yearly). Requires count or until and an explicit IANA timeZone. Do not combine with rrule.")

function utcUntil(value: string): string {
  return new Date(value.length === 10 ? `${value}T23:59:59Z` : value).toISOString().slice(0, 19).replace(/[-:]/g, "") + "Z"
}

export function recurrenceToRrule(input: z.infer<typeof calendarRecurrenceSchema>): string[] {
  const parts = [`FREQ=${input.frequency.toUpperCase()}`]
  if (input.interval !== undefined) parts.push(`INTERVAL=${input.interval}`)
  if (input.byWeekday) parts.push(`BYDAY=${[...new Set(input.byWeekday)].join(",")}`)
  if (input.count !== undefined) parts.push(`COUNT=${input.count}`)
  if (input.until !== undefined) parts.push(`UNTIL=${utcUntil(input.until)}`)
  return [`RRULE:${parts.join(";")}`]
}

function validUtc(value: string): boolean {
  if (!/^\d{8}T\d{6}Z$/.test(value)) return false
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}Z`
  return z.string().datetime().safeParse(iso).success
}
function integerList(value: string, min: number, max: number, excludeZero = false): boolean {
  return value.split(",").every((part) => /^[+-]?\d{1,3}$/.test(part) && Number(part) >= min && Number(part) <= max && (!excludeZero || Number(part) !== 0))
}
function validRule(value: string): boolean {
  const entries = value.slice(6).split(";").map((part) => part.split("="))
  if (entries.some((entry) => entry.length !== 2) || new Set(entries.map(([key]) => key)).size !== entries.length) return false
  const parts = new Map(entries.map(([key, content]) => [key, content]))
  if (!/^(DAILY|WEEKLY|MONTHLY|YEARLY)$/.test(parts.get("FREQ") ?? "")) return false
  if (parts.has("COUNT") === parts.has("UNTIL")) return false
  const frequency = parts.get("FREQ")
  if (frequency === "WEEKLY" && parts.has("BYMONTHDAY")) return false
  if (frequency !== "MONTHLY" && frequency !== "YEARLY" && /\d/.test(parts.get("BYDAY") ?? "")) return false
  if (parts.has("BYSETPOS") && !["BYDAY", "BYMONTH", "BYMONTHDAY"].some((key) => parts.has(key))) return false
  for (const [key, content] of parts) {
    switch (key) {
      case "FREQ": break
      case "COUNT": if (!/^\d{1,3}$/.test(content) || Number(content) < 1 || Number(content) > 730) return false; break
      case "UNTIL": if (!validUtc(content)) return false; break
      case "INTERVAL": if (!/^\d{1,2}$/.test(content) || Number(content) < 1 || Number(content) > 99) return false; break
      case "BYDAY": if (!content.split(",").every((day) => /^(?:[+-]?(?:[1-9]|[1-4][0-9]|5[0-3]))?(?:MO|TU|WE|TH|FR|SA|SU)$/.test(day))) return false; break
      case "BYMONTH": if (!integerList(content, 1, 12)) return false; break
      case "BYMONTHDAY": if (!integerList(content, -31, 31, true)) return false; break
      case "BYSETPOS": if (!integerList(content, -366, 366, true)) return false; break
      case "WKST": if (!/^(MO|TU|WE|TH|FR|SA|SU)$/.test(content)) return false; break
      default: return false
    }
  }
  return true
}
export const calendarRruleSchema = z.array(z.string().min(1).max(2048).refine((line) => {
  if (/[\r\n\x00-\x1f\x7f]/.test(line)) return false
  if (line.startsWith("RRULE:")) return validRule(line)
  if (!/^(EXDATE|RDATE):/.test(line)) return false
  return line.slice(line.indexOf(":") + 1).split(",").every(validUtc)
}, "Use a bounded RRULE:FREQ=… with COUNT=1-730 or UTC UNTIL, or EXDATE:/RDATE: with basic UTC date-times; no newlines, parameters or unsupported rule parts."))
  .min(1).max(32).refine((lines) => lines.filter((line) => line.startsWith("RRULE:")).length <= 1, "At most one RRULE is allowed.")
  .describe("Advanced recurrence escape hatch, mutually exclusive with recurrence. At most 32 lines of 2048 characters; RRULE:, EXDATE:, RDATE: only. RRULE requires COUNT (1-730) or UTC UNTIL; unbounded series are rejected. Supports FREQ daily/weekly/monthly/yearly, INTERVAL 1-99, BYDAY, BYMONTH, BYMONTHDAY, BYSETPOS and WKST. EXDATE/RDATE and RRULE UNTIL use basic UTC YYYYMMDDTHHmmssZ, matching this API's timed events; date-only values are not supported.")

export const calendarRecurrenceFields = {
  recurrence: calendarRecurrenceSchema.optional(),
  rrule: calendarRruleSchema.optional(),
}
export function validateRecurrenceChoice(input: { recurrence?: unknown; rrule?: string[] }, ctx: z.RefinementCtx) {
  if (input.recurrence !== undefined && input.rrule !== undefined) ctx.addIssue({ code: "custom", path: ["rrule"], message: "Use recurrence or rrule, not both." })
}

// Google may reorder rule parts, weekdays or exception lines in its confirmation.
export function calendarRecurrenceMatches(expected: string[], actual: string[] | null | undefined): boolean {
  const normalize = (lines: string[]) => lines.map((line) => {
    if (line.startsWith("RRULE:")) return "RRULE:" + line.slice(6).split(";").map((part) => {
      const [key, value] = part.split("=")
      return `${key}=${value?.split(",").sort().join(",")}`
    }).filter((part) => part !== "INTERVAL=1").sort().join(";")
    const colon = line.indexOf(":")
    return line.slice(0, colon + 1) + line.slice(colon + 1).split(",").sort().join(",")
  }).sort()
  return JSON.stringify(normalize(expected)) === JSON.stringify(normalize(actual ?? []))
}

export function validateRecurrenceUntil(input: { recurrence?: z.infer<typeof calendarRecurrenceSchema> | null; rrule?: string[] }, start: string, ctx: z.RefinementCtx) {
  if (input.recurrence && !calendarRecurrenceSchema.safeParse(input.recurrence).success) return
  const rules = input.recurrence ? recurrenceToRrule(input.recurrence) : input.rrule
  const until = rules?.find((line) => line.startsWith("RRULE:"))?.match(/(?:^RRULE:|;)UNTIL=(\d{8}T\d{6}Z)(?:;|$)/)?.[1]
  if (until && until < utcUntil(start)) ctx.addIssue({ code: "custom", path: ["recurrence"], message: "until must not precede start." })
}

export const createCalendarEventBodySchema = z.object({
  summary: z.string().trim().min(1).max(1_000).describe("Event title."),
  description: z.string().max(20_000).optional().describe("Optional event description."),
  location: z.string().max(1_000).optional().describe("Optional event location."),
  start: z.string().datetime({ offset: true }).describe("Event start date-time with a UTC offset or Z."),
  end: z.string().datetime({ offset: true }).describe("Event end date-time with a UTC offset or Z."),
  timeZone: calendarTimeZoneSchema.optional().describe("IANA timeZone for start and end; required for recurring meetings. Never guess the user's time zone."),
  attendees: z.array(z.string().email()).max(100).optional().describe("Optional attendee email addresses."),
  createMeetLink: z.boolean().optional().describe("Set true to request a Google Meet link; the response returns meetLink when Google creates it."),
  ...calendarRecurrenceFields,
}).superRefine((input, ctx) => {
  validateRecurrenceChoice(input, ctx)
  if ((input.recurrence !== undefined || input.rrule !== undefined) && !input.timeZone) {
    ctx.addIssue({ code: "custom", path: ["timeZone"], message: "Recurring events require an explicit IANA timeZone for start and end; pass e.g. America/New_York." })
  }
  if (Date.parse(input.end) <= Date.parse(input.start)) ctx.addIssue({ code: "custom", path: ["end"], message: "End must be later than start." })
  if (z.string().datetime({ offset: true }).safeParse(input.start).success) validateRecurrenceUntil(input, input.start, ctx)
}).meta({ ref: "GoogleWorkspaceCreateCalendarEventBody" })

export type CalendarEventCreatePayload = {
  summary: string
  description?: string
  location?: string
  start: { dateTime: string; timeZone?: string }
  end: { dateTime: string; timeZone?: string }
  attendees?: { email: string }[]
  recurrence?: string[]
  conferenceData?: { createRequest: { requestId: string; conferenceSolutionKey: { type: "hangoutsMeet" } } }
}
export function buildCalendarEventPayload(input: z.infer<typeof createCalendarEventBodySchema>): CalendarEventCreatePayload {
  const start: CalendarEventCreatePayload["start"] = { dateTime: input.start }
  const end: CalendarEventCreatePayload["end"] = { dateTime: input.end }
  if (input.timeZone) { start.timeZone = input.timeZone; end.timeZone = input.timeZone }
  const payload: CalendarEventCreatePayload = { summary: input.summary, start, end }
  if (input.description) payload.description = input.description
  if (input.location) payload.location = input.location
  if (input.attendees?.length) payload.attendees = input.attendees.map((email) => ({ email }))
  if (input.recurrence) payload.recurrence = recurrenceToRrule(input.recurrence)
  else if (input.rrule) payload.recurrence = input.rrule
  return payload
}
