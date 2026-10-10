import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import { useMeetingsQuery, useRunsInRangeQuery } from "@openwork/calendar/react"
import type { AutomationList } from "@openwork/types/automations"

import type { AutomationRunsSource, CalendarProviderId, CalendarTransport } from "@openwork/calendar"
import type { DenClient, DenExternalMcpConnection } from "@/app/lib/den"
import type { AutomationsDenContext } from "@/react-app/domains/automations/use-automations"
import { createDenCalendarTransport, createMockCalendarTransport, readCalendarMockUrl } from "./calendar-source"

/** Den's run routes as the shared Calendar's runs source. */
export function denRunsSource(client: DenClient, organizationId: string): AutomationRunsSource {
  return {
    listRunsInRange: (input) => client.listAutomationRunsInRange(organizationId, input),
    listRuns: (automationId, input) => client.listAutomationRuns(organizationId, automationId, input),
  }
}

export function useAutomationRunsInRange(
  context: AutomationsDenContext,
  range: { start: number; end: number },
  automations: readonly AutomationList["items"][number][] | undefined,
  enabled: boolean,
) {
  const source = useMemo(
    () => context.client && context.organizationId ? denRunsSource(context.client, context.organizationId) : null,
    [context.client, context.organizationId],
  )
  return useRunsInRangeQuery({ keyPrefix: context.queryRoot, source, range, automations, enabled: enabled && context.ready })
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
  return useMeetingsQuery({ keyPrefix: ["calendar", input.organizationId], provider: input.provider, transport: input.transport, range: input.range, enabled: input.enabled })
}
