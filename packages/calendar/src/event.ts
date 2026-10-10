import type { LocalDate } from "./time"

/** Calendar providers a member can overlay. Each has its own adapter. */
export type CalendarProviderId = "google" | "microsoft"

export const CALENDAR_PROVIDER_LABEL: Record<CalendarProviderId, string> = {
  google: "Google Calendar",
  microsoft: "Outlook",
}

/** Timed events are absolute instants; all-day events are dates with an exclusive end. */
export type CalendarEventTiming =
  | { kind: "timed"; start: number; end: number; timeZone: string | null }
  | { kind: "all_day"; startDate: LocalDate; endDate: LocalDate }

/**
 * One meeting from a member's connected calendar, normalized across providers.
 * Recurring series arrive already expanded into instances by both providers.
 */
export type CalendarEvent = {
  /** Stable across refetches: `${provider}:${providerEventId}`. */
  key: string
  provider: CalendarProviderId
  providerEventId: string
  title: string
  sourceUrl: string | null
  location: string | null
  meetingUrl: string | null
  timing: CalendarEventTiming
  /** Only when the provider supplies it. */
  status: "confirmed" | "tentative" | "cancelled" | null
  attendeeCount: number
}

/**
 * Why a provider's meetings could not be read. `not_connected` and
 * `permission_missing` are blocked states the member (or an admin) can fix,
 * not failures (DESIGN.md C5).
 */
export type CalendarConnectionErrorKind =
  | "not_connected"
  | "permission_missing"
  | "policy_blocked"
  | "auth_expired"
  | "throttled"
  | "provider_error"
  | "unsupported"
  | "network"

export class CalendarConnectionError extends Error {
  readonly provider: CalendarProviderId
  readonly kind: CalendarConnectionErrorKind
  readonly retryable: boolean

  constructor(provider: CalendarProviderId, kind: CalendarConnectionErrorKind, message: string) {
    super(message)
    this.name = "CalendarConnectionError"
    this.provider = provider
    this.kind = kind
    this.retryable = kind === "throttled" || kind === "provider_error" || kind === "network"
  }
}

export type CalendarRangeRead = {
  events: CalendarEvent[]
  /**
   * False when a window still returned the page maximum after splitting to the
   * smallest window, i.e. some meetings may be missing.
   */
  complete: boolean
  /** Upstream requests made to read the range. */
  requests: number
}

export type CalendarRangeRequest = {
  /** Inclusive start instant. */
  start: number
  /** Exclusive end instant. */
  end: number
  signal?: AbortSignal
}

/** Reads one provider's meetings for a UTC window. */
export interface CalendarProviderAdapter {
  readonly provider: CalendarProviderId
  readRange(request: CalendarRangeRequest): Promise<CalendarRangeRead>
}
