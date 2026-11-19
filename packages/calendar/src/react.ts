import { useQuery } from "@tanstack/react-query"
import type { AutomationList, AutomationRun } from "@openwork/types/automations"

import { createCalendarAdapter, type CalendarTransport } from "./adapters"
import type { CalendarConnectionError, CalendarProviderId, CalendarRangeRead } from "./event"
import { readRunsInRange, type AutomationRunsSource, type RunsInRange } from "./runs"

/**
 * TanStack Query hooks both apps use for the Calendar's data. Each app passes
 * its own key prefix (organization, member) so caches never cross identities.
 */

const ACTIVE = new Set<AutomationRun["status"]>(["queued", "claimed", "running"])
export const CALENDAR_FAST_POLL_MS = 10_000
export const CALENDAR_SLOW_POLL_MS = 60_000

export function useRunsInRangeQuery(input: {
  keyPrefix: readonly unknown[]
  source: AutomationRunsSource | null
  range: { start: number; end: number }
  automations: readonly AutomationList["items"][number][] | undefined
  enabled: boolean
}) {
  return useQuery<RunsInRange>({
    queryKey: [...input.keyPrefix, "runs-range", input.range.start, input.range.end],
    queryFn: () => readRunsInRange(input.source!, input.range, input.automations ?? []),
    enabled: input.enabled && input.source !== null && input.automations !== undefined,
    staleTime: 15_000,
    refetchInterval: (query) => query.state.data?.runs.some((run) => ACTIVE.has(run.status)) ? CALENDAR_FAST_POLL_MS : CALENDAR_SLOW_POLL_MS,
  })
}

export function useMeetingsQuery(input: {
  keyPrefix: readonly unknown[]
  provider: CalendarProviderId
  transport: CalendarTransport | null
  range: { start: number; end: number }
  enabled: boolean
}) {
  return useQuery<CalendarRangeRead, CalendarConnectionError>({
    queryKey: [...input.keyPrefix, "meetings", input.transport?.kind ?? "none", input.provider, input.range.start, input.range.end],
    queryFn: ({ signal }) => createCalendarAdapter(input.provider, input.transport!).readRange({ ...input.range, signal }),
    enabled: input.enabled && input.transport !== null,
    staleTime: 2 * 60_000,
    refetchInterval: 5 * 60_000,
    refetchOnWindowFocus: true,
    retry: (failureCount, error) => error.retryable && failureCount < 2,
    retryDelay: (attempt) => Math.min(30_000, 2_000 * 2 ** attempt),
  })
}
