import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import type { AutomationList, AutomationRun } from "@openwork/types/automations"

import { DenApiError, type DenClient } from "@/app/lib/den"
import type { DenExternalMcpConnection } from "@/app/lib/den"
import { ACTIVE_RUN_STATUSES, AUTOMATIONS_FAST_POLL_MS, AUTOMATIONS_SLOW_POLL_MS, type AutomationsDenContext } from "@/react-app/domains/automations/use-automations"
import { createCalendarAdapter, type CalendarTransport } from "./calendar-adapters"
import { CalendarConnectionError, type CalendarProviderId, type CalendarRangeRead } from "./calendar-event"
import { runPlacement } from "./automation-calendar"
import { createDenCalendarTransport, createMockCalendarTransport, readCalendarMockUrl } from "./calendar-source"

const RANGE_PAGE_LIMIT = 200
const RANGE_MAX_PAGES = 10
/** Older Dens without the range route: per-Automation history, bounded. */
const FALLBACK_MAX_AUTOMATIONS = 30
const FALLBACK_CONCURRENCY = 4

export type RunsInRange = {
  runs: AutomationRun[]
  /** False when the range had more runs than one read returns. */
  complete: boolean
  /** `range` is the owner-scoped route; `per_automation` is the bounded fallback for older Dens. */
  source: "range" | "per_automation"
}

async function readRunsInRange(
  client: DenClient,
  organizationId: string,
  range: { start: number; end: number },
  automations: readonly AutomationList["items"][number][],
): Promise<RunsInRange> {
  try {
    const runs: AutomationRun[] = []
    let cursor: string | undefined
    for (let page = 0; page < RANGE_MAX_PAGES; page += 1) {
      const result = await client.listAutomationRunsInRange(organizationId, { from: range.start, to: range.end, cursor, limit: RANGE_PAGE_LIMIT })
      runs.push(...result.items)
      if (!result.nextCursor) return { runs, complete: true, source: "range" }
      cursor = result.nextCursor
    }
    return { runs, complete: false, source: "range" }
  } catch (error) {
    if (!(error instanceof DenApiError) || error.status !== 404) throw error
  }
  // N+1 fallback: newest 100 runs per Automation, filtered to the range.
  const selected = automations.filter((item) => item.automation.state !== "archived").slice(0, FALLBACK_MAX_AUTOMATIONS)
  const runs: AutomationRun[] = []
  let complete = selected.length === automations.filter((item) => item.automation.state !== "archived").length
  for (let index = 0; index < selected.length; index += FALLBACK_CONCURRENCY) {
    const batch = await Promise.all(selected.slice(index, index + FALLBACK_CONCURRENCY).map((item) =>
      client.listAutomationRuns(organizationId, item.automation.id, { limit: 100 })))
    for (const page of batch) {
      const inRange = page.items.filter((run) => {
        const at = runPlacement(run)
        return at >= range.start && at < range.end
      })
      runs.push(...inRange)
      // The oldest run on a full page is still inside the range: older ones may be missing.
      const oldest = page.items.at(-1)
      if (page.nextCursor && oldest && runPlacement(oldest) >= range.start) complete = false
    }
  }
  return { runs, complete, source: "per_automation" }
}

export function useAutomationRunsInRange(
  context: AutomationsDenContext,
  range: { start: number; end: number },
  automations: readonly AutomationList["items"][number][] | undefined,
  enabled: boolean,
) {
  return useQuery({
    queryKey: [...context.queryRoot, "runs-range", range.start, range.end],
    queryFn: () => readRunsInRange(context.client!, context.organizationId!, range, automations ?? []),
    enabled: enabled && context.ready && automations !== undefined,
    staleTime: 15_000,
    refetchInterval: (query) => query.state.data?.runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status))
      ? AUTOMATIONS_FAST_POLL_MS
      : AUTOMATIONS_SLOW_POLL_MS,
  })
}

/** Whether the organization turned the Calendar on (`automationCalendar` in `/v1/org` features). */
export function useCalendarFeature(context: AutomationsDenContext) {
  return useQuery({
    queryKey: ["den", "org-features", context.organizationId],
    queryFn: () => context.client!.getOrgFeatures(context.organizationId!),
    enabled: context.ready,
    staleTime: 5 * 60_000,
    select: (features) => features.automationCalendar === true,
  })
}

export function useCalendarTransport(context: AutomationsDenContext): CalendarTransport | null {
  const mockUrl = readCalendarMockUrl()
  return useMemo(() => {
    if (mockUrl) return createMockCalendarTransport(mockUrl)
    return context.client && context.organizationId ? createDenCalendarTransport(context.client, context.organizationId) : null
  }, [context.client, context.organizationId, mockUrl])
}

/**
 * Per provider: whether to read it. `absent` means the organization has no
 * such connection, so the Calendar does not offer it; `not_connected` is a
 * blocked state the member can fix by connecting.
 */
export type CalendarProviderPresence = "available" | "not_connected" | "absent" | "unknown"

const NATIVE_PROVIDER_KEY: Record<CalendarProviderId, string> = { google: "google-workspace", microsoft: "microsoft-365" }

export function calendarProviderPresence(
  provider: CalendarProviderId,
  connections: readonly DenExternalMcpConnection[],
  loaded: boolean,
  transport: CalendarTransport | null,
): { presence: CalendarProviderPresence; connectionId: string | null } {
  // The mock stands in for both providers; its scenarios decide connection state.
  if (transport?.kind === "mock") return { presence: "available", connectionId: null }
  const key = NATIVE_PROVIDER_KEY[provider]
  const matches = connections.filter((connection) => connection.nativeProviderKey === key || connection.id === key)
  const connected = matches.find((connection) => connection.connectedForMe)
  if (connected) return { presence: "available", connectionId: connected.id }
  if (matches[0]) return { presence: "not_connected", connectionId: matches[0].id }
  return { presence: loaded ? "absent" : "unknown", connectionId: null }
}

export function useCalendarMeetings(input: {
  provider: CalendarProviderId
  transport: CalendarTransport | null
  organizationId: string | null
  range: { start: number; end: number }
  enabled: boolean
}) {
  return useQuery<CalendarRangeRead, CalendarConnectionError>({
    queryKey: ["calendar", "meetings", input.transport?.kind ?? "none", input.organizationId, input.provider, input.range.start, input.range.end],
    queryFn: ({ signal }) => createCalendarAdapter(input.provider, input.transport!).readRange({ ...input.range, signal }),
    enabled: input.enabled && input.transport !== null,
    staleTime: 2 * 60_000,
    refetchInterval: 5 * 60_000,
    refetchOnWindowFocus: true,
    retry: (failureCount, error) => error.retryable && failureCount < 2,
    retryDelay: (attempt) => Math.min(30_000, 2_000 * 2 ** attempt),
  })
}
