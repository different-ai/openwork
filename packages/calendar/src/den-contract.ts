import { z } from "zod"

/**
 * Response contracts of Den's native calendar capability routes, mirrored from
 * the generated SDK types (packages/sdk/src/gen/types.gen.ts:
 * GoogleWorkspaceCalendarEvent, Microsoft365CalendarEvent). The desktop app
 * does not depend on @openwork/sdk, so these schemas validate the same shape at
 * the boundary instead of trusting a cast.
 *
 *   GET /v1/capabilities/google-workspace/calendar-events?timeMin&timeMax&maxResults
 *   GET /v1/capabilities/microsoft-365/calendar-events?timeMin&timeMax&maxResults
 *
 * Both accept maxResults 1–100 (default 25) and expose no page token.
 */
export const DEN_CALENDAR_MAX_RESULTS = 100

export const denGoogleCalendarEventSchema = z.object({
  id: z.string(),
  summary: z.string(),
  description: z.string(),
  location: z.string(),
  /** RFC 3339 date-time with offset, or a bare YYYY-MM-DD date for all-day events. */
  start: z.string(),
  /** Exclusive end; a bare date for all-day events. */
  end: z.string(),
  status: z.string(),
  htmlLink: z.string(),
  attendees: z.array(z.string()),
  meetLink: z.string().nullable(),
})
export type DenGoogleCalendarEvent = z.infer<typeof denGoogleCalendarEventSchema>

export const denGoogleCalendarEventsResponseSchema = z.object({
  ok: z.literal(true),
  events: z.array(denGoogleCalendarEventSchema),
})

const denEmailAddressSchema = z.object({ name: z.string(), address: z.string() })

export const denMicrosoftCalendarEventSchema = z.object({
  id: z.string(),
  subject: z.string(),
  preview: z.string(),
  /** Graph wall time without an offset, e.g. 2026-10-05T16:00:00.0000000; read with startTimeZone. */
  start: z.string(),
  startTimeZone: z.string(),
  end: z.string(),
  endTimeZone: z.string(),
  isAllDay: z.boolean(),
  location: z.string(),
  organizer: denEmailAddressSchema.nullable(),
  attendees: z.array(denEmailAddressSchema),
  webLink: z.string(),
  onlineMeetingUrl: z.string().nullable(),
})
export type DenMicrosoftCalendarEvent = z.infer<typeof denMicrosoftCalendarEventSchema>

export const denMicrosoftCalendarEventsResponseSchema = z.object({
  ok: z.literal(true),
  events: z.array(denMicrosoftCalendarEventSchema),
})

export type DenCalendarRangeQuery = {
  /** RFC 3339 instant; send UTC `Z` (Microsoft rejects offsets). */
  timeMin: string
  timeMax: string
  maxResults?: number
}

export function calendarRangeSearch(query: DenCalendarRangeQuery): string {
  const params = new URLSearchParams({ timeMin: query.timeMin, timeMax: query.timeMax })
  if (query.maxResults !== undefined) params.set("maxResults", String(query.maxResults))
  return params.toString()
}

export const DEN_GOOGLE_CALENDAR_EVENTS_PATH = "/v1/capabilities/google-workspace/calendar-events"
export const DEN_MICROSOFT_CALENDAR_EVENTS_PATH = "/v1/capabilities/microsoft-365/calendar-events"
