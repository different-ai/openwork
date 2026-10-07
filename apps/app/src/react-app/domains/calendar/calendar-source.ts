import { DenApiError, type DenClient } from "@/app/lib/den"
import {
  calendarRangeSearch,
  type CalendarTransport,
  DEN_GOOGLE_CALENDAR_EVENTS_PATH,
  DEN_MICROSOFT_CALENDAR_EVENTS_PATH,
  type DenCalendarRangeQuery,
  denGoogleCalendarEventsResponseSchema,
  denMicrosoftCalendarEventsResponseSchema,
} from "@openwork/calendar"

/**
 * Meetings come from the member's real connections through Den unless a
 * calendar mock is configured. The mock serves Den's exact routes and
 * payloads, so switching back needs no code change:
 *
 * - build/dev time: `VITE_OPENWORK_CALENDAR_MOCK_URL=http://127.0.0.1:3991`
 * - at runtime (devtools or CDP): `localStorage.setItem("openwork.calendar.mockUrl", "http://127.0.0.1:3991")`,
 *   and `localStorage.setItem("openwork.calendar.mockUrl", "off")` to force real
 *   connections even when the env var is set.
 *
 * Automations always come from Den; only meetings are mocked.
 */
export const CALENDAR_MOCK_URL_STORAGE_KEY = "openwork.calendar.mockUrl"

function validMockUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? ""
  if (!trimmed) return null
  try {
    const url = new URL(trimmed)
    if (url.protocol !== "http:" && url.protocol !== "https:") return null
    return url.toString().replace(/\/+$/, "")
  } catch {
    return null
  }
}

export function readCalendarMockUrl(): string | null {
  let stored: string | null = null
  try {
    stored = typeof window !== "undefined" ? window.localStorage.getItem(CALENDAR_MOCK_URL_STORAGE_KEY) : null
  } catch {
    stored = null
  }
  if (stored?.trim() === "off") return null
  return validMockUrl(stored) ?? validMockUrl(String(import.meta.env.VITE_OPENWORK_CALENDAR_MOCK_URL ?? ""))
}

export function createDenCalendarTransport(client: DenClient, organizationId: string): CalendarTransport {
  return {
    kind: "den",
    google: (query) => client.listGoogleCalendarEvents(organizationId, query),
    microsoft: (query) => client.listMicrosoftCalendarEvents(organizationId, query),
  }
}

async function mockRequest(baseUrl: string, path: string, query: DenCalendarRangeQuery, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(`${baseUrl}${path}?${calendarRangeSearch(query)}`, { headers: { Accept: "application/json" }, signal })
  const payload: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const body = typeof payload === "object" && payload !== null ? payload : {}
    const code = "error" in body && typeof body.error === "string" ? body.error : "request_failed"
    const message = "message" in body && typeof body.message === "string" ? body.message : `Request failed with ${response.status}.`
    throw new DenApiError(response.status, code, message)
  }
  return payload
}

export function createMockCalendarTransport(baseUrl: string): CalendarTransport {
  return {
    kind: "mock",
    async google(query, signal) {
      const parsed = denGoogleCalendarEventsResponseSchema.safeParse(await mockRequest(baseUrl, DEN_GOOGLE_CALENDAR_EVENTS_PATH, query, signal))
      if (!parsed.success) throw new DenApiError(502, "invalid_calendar_payload", "The calendar mock returned an unexpected Google response.")
      return parsed.data.events
    },
    async microsoft(query, signal) {
      const parsed = denMicrosoftCalendarEventsResponseSchema.safeParse(await mockRequest(baseUrl, DEN_MICROSOFT_CALENDAR_EVENTS_PATH, query, signal))
      if (!parsed.success) throw new DenApiError(502, "invalid_calendar_payload", "The calendar mock returned an unexpected Outlook response.")
      return parsed.data.events
    },
  }
}
