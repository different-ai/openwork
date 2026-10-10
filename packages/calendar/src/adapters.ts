import {
  DEN_CALENDAR_MAX_RESULTS,
  type DenCalendarRangeQuery,
  type DenGoogleCalendarEvent,
  type DenMicrosoftCalendarEvent,
} from "./den-contract"
import {
  CALENDAR_PROVIDER_LABEL,
  CalendarConnectionError,
  type CalendarEvent,
  type CalendarProviderAdapter,
  type CalendarProviderId,
  type CalendarRangeRead,
  type CalendarRangeRequest,
} from "./event"
import { addDays, HOUR_MS, MINUTE_MS, parseDateKey, parseGraphDateTime, resolveGraphTimeZone, toUtcIso } from "./time"

/**
 * Where calendar range reads go. `den` is the member's real connections
 * through Den; `mock` is the calendar mock server, which serves the identical
 * routes and payloads (evals/packages/labs/src/calendar-mock.mjs).
 */
export type CalendarTransport = {
  kind: "den" | "mock"
  google(query: DenCalendarRangeQuery, signal?: AbortSignal): Promise<DenGoogleCalendarEvent[]>
  microsoft(query: DenCalendarRangeQuery, signal?: AbortSignal): Promise<DenMicrosoftCalendarEvent[]>
}

/** Smallest window the reader will split to before calling a range incomplete. */
const MIN_WINDOW_MS = HOUR_MS
const MAX_REQUESTS_PER_RANGE = 32

/**
 * Den's calendar routes return at most 100 events and no page token, so a
 * full page may hide more. Split the window in half until every page is
 * partial (both providers return events *overlapping* the window, so events
 * crossing a split appear twice and are de-duplicated by key).
 */
async function readWindowed<T>(input: {
  request: CalendarRangeRequest
  fetchPage: (query: DenCalendarRangeQuery) => Promise<T[]>
  normalize: (raw: T) => CalendarEvent | null
}): Promise<CalendarRangeRead> {
  const byKey = new Map<string, CalendarEvent>()
  let requests = 0
  let complete = true
  const visit = async (start: number, end: number): Promise<void> => {
    if (input.request.signal?.aborted) throw new DOMException("Aborted", "AbortError")
    requests += 1
    const page = await input.fetchPage({ timeMin: toUtcIso(start), timeMax: toUtcIso(end), maxResults: DEN_CALENDAR_MAX_RESULTS })
    if (page.length < DEN_CALENDAR_MAX_RESULTS || end - start <= MIN_WINDOW_MS || requests + 2 > MAX_REQUESTS_PER_RANGE) {
      if (page.length >= DEN_CALENDAR_MAX_RESULTS) complete = false
      for (const raw of page) {
        const event = input.normalize(raw)
        if (event) byKey.set(event.key, event)
      }
      return
    }
    const middle = start + Math.floor((end - start) / 2 / MINUTE_MS) * MINUTE_MS
    await visit(start, middle)
    await visit(middle, end)
  }
  await visit(input.request.start, input.request.end)
  const events = [...byKey.values()].filter((event) => overlaps(event, input.request))
  return { events, complete, requests }
}

function overlaps(event: CalendarEvent, request: CalendarRangeRequest): boolean {
  if (event.timing.kind === "timed") return event.timing.end > request.start && event.timing.start < request.end
  // All-day events are kept; the grid places them by date.
  return true
}

function blankToNull(value: string): string | null {
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

/** Google returns `start`/`end` flattened: an RFC 3339 date-time, or a bare date for all-day events. */
export function normalizeGoogleEvent(raw: DenGoogleCalendarEvent): CalendarEvent | null {
  if (!raw.id) return null
  const status = raw.status === "confirmed" || raw.status === "tentative" || raw.status === "cancelled" ? raw.status : null
  if (status === "cancelled") return null
  const startDate = parseDateKey(raw.start)
  let timing: CalendarEvent["timing"]
  if (startDate) {
    const endDate = parseDateKey(raw.end)
    // The end date is exclusive; a missing or non-advancing end means one day.
    timing = { kind: "all_day", startDate, endDate: endDate && compareKey(endDate) > compareKey(startDate) ? endDate : addDays(startDate, 1) }
  } else {
    const start = Date.parse(raw.start)
    const end = Date.parse(raw.end)
    if (!Number.isFinite(start)) return null
    timing = { kind: "timed", start, end: Number.isFinite(end) && end > start ? end : start + 30 * MINUTE_MS, timeZone: null }
  }
  return {
    key: `google:${raw.id}`,
    provider: "google",
    providerEventId: raw.id,
    // Google omits the summary of events the member can only see as busy.
    title: raw.summary.trim() || "Busy",
    sourceUrl: blankToNull(raw.htmlLink),
    location: blankToNull(raw.location),
    meetingUrl: raw.meetLink ? blankToNull(raw.meetLink) : null,
    timing,
    status,
    attendeeCount: raw.attendees.length,
  }
}

function compareKey(date: { year: number; month: number; day: number }): number {
  return Date.UTC(date.year, date.month - 1, date.day)
}

/**
 * Microsoft returns Graph `{ dateTime, timeZone }` pairs (as start/startTimeZone)
 * and an explicit `isAllDay`; all-day ends are the next day's midnight.
 */
export function normalizeMicrosoftEvent(raw: DenMicrosoftCalendarEvent): CalendarEvent | null {
  if (!raw.id) return null
  let timing: CalendarEvent["timing"]
  if (raw.isAllDay) {
    const startDate = parseDateKey(raw.start.slice(0, 10))
    if (!startDate) return null
    const endDate = parseDateKey(raw.end.slice(0, 10))
    timing = { kind: "all_day", startDate, endDate: endDate && compareKey(endDate) > compareKey(startDate) ? endDate : addDays(startDate, 1) }
  } else {
    const start = parseGraphDateTime(raw.start, raw.startTimeZone)
    const end = parseGraphDateTime(raw.end, raw.endTimeZone || raw.startTimeZone)
    if (start === null) return null
    timing = {
      kind: "timed", start,
      end: end !== null && end > start ? end : start + 30 * MINUTE_MS,
      timeZone: resolveGraphTimeZone(raw.startTimeZone),
    }
  }
  return {
    key: `microsoft:${raw.id}`,
    provider: "microsoft",
    providerEventId: raw.id,
    title: raw.subject.trim() || "(No title)",
    sourceUrl: blankToNull(raw.webLink),
    location: blankToNull(raw.location),
    meetingUrl: raw.onlineMeetingUrl ? blankToNull(raw.onlineMeetingUrl) : null,
    timing,
    status: null,
    attendeeCount: raw.attendees.length,
  }
}

const UPSTREAM_STATUS = /failed: (\d{3})\b/
const THROTTLE_REASONS = /rateLimitExceeded|userRateLimitExceeded|quotaExceeded|TooManyRequests|throttl/i

type DenErrorLike = Error & { status: number; code: string }

/** DenApiError (app/lib/den.ts) by shape, so this module stays free of the Den client. */
function isDenErrorLike(error: unknown): error is DenErrorLike {
  return error instanceof Error
    && "status" in error && typeof error.status === "number"
    && "code" in error && typeof error.code === "string"
}

/** Maps Den's capability-route errors to typed connection errors. */
export function classifyCalendarError(provider: CalendarProviderId, error: unknown): CalendarConnectionError {
  if (error instanceof CalendarConnectionError) return error
  const label = CALENDAR_PROVIDER_LABEL[provider]
  if (!isDenErrorLike(error)) {
    return new CalendarConnectionError(provider, "network", `${label} could not be reached.`)
  }
  if (error.status === 404) return new CalendarConnectionError(provider, "unsupported", `This OpenWork Cloud server cannot read ${label} yet.`)
  if (error.status === 403 && error.code === "policy_blocked") return new CalendarConnectionError(provider, "policy_blocked", error.message)
  if (error.status === 409 && error.code === "needs_connection") {
    const permission = /missing the|disabled|permission/i.test(error.message)
    return new CalendarConnectionError(provider, permission ? "permission_missing" : "not_connected", error.message)
  }
  if (error.status === 429) return new CalendarConnectionError(provider, "throttled", `${label} is busy. Meetings will load again shortly.`)
  if (error.status === 502 && (error.code === "google_api_error" || error.code === "microsoft_graph_error")) {
    const upstream = Number(UPSTREAM_STATUS.exec(error.message)?.[1] ?? 0)
    if (upstream === 429 || THROTTLE_REASONS.test(error.message)) {
      return new CalendarConnectionError(provider, "throttled", `${label} is busy. Meetings will load again shortly.`)
    }
    if (upstream === 401) return new CalendarConnectionError(provider, "auth_expired", `${label} sign-in expired. Reconnect it to see your meetings.`)
    if (upstream === 403) return new CalendarConnectionError(provider, "permission_missing", `${label} did not allow reading your calendar.`)
  }
  return new CalendarConnectionError(provider, "provider_error", error.message || `${label} could not be read.`)
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError"
}

export function createGoogleCalendarAdapter(transport: CalendarTransport): CalendarProviderAdapter {
  return {
    provider: "google",
    async readRange(request) {
      try {
        return await readWindowed({ request, fetchPage: (query) => transport.google(query, request.signal), normalize: normalizeGoogleEvent })
      } catch (error) {
        if (isAbort(error)) throw error
        throw classifyCalendarError("google", error)
      }
    },
  }
}

export function createMicrosoftCalendarAdapter(transport: CalendarTransport): CalendarProviderAdapter {
  return {
    provider: "microsoft",
    async readRange(request) {
      try {
        return await readWindowed({ request, fetchPage: (query) => transport.microsoft(query, request.signal), normalize: normalizeMicrosoftEvent })
      } catch (error) {
        if (isAbort(error)) throw error
        throw classifyCalendarError("microsoft", error)
      }
    },
  }
}

export function createCalendarAdapter(provider: CalendarProviderId, transport: CalendarTransport): CalendarProviderAdapter {
  return provider === "google" ? createGoogleCalendarAdapter(transport) : createMicrosoftCalendarAdapter(transport)
}
