import {
  calendarRangeSearch,
  denGoogleCalendarEventsResponseSchema,
  denMicrosoftCalendarEventsResponseSchema,
  DEN_GOOGLE_CALENDAR_EVENTS_PATH,
  DEN_MICROSOFT_CALENDAR_EVENTS_PATH,
  type AutomationRunsSource,
  type CalendarTransport,
} from "@openwork/calendar"
import {
  AUTOMATION_CLOUD_DEFAULT_MODEL,
  automationDetailSchema,
  automationListSchema,
  automationRunRangeSchema,
  automationRunReceiptSchema,
  automationRunSchema,
  type AutomationModel,
  type AutomationSchedule,
} from "@openwork/types/automations"
import { automationModelOptions } from "@openwork/types/automation-models"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useMemo } from "react"
import { z } from "zod"
import { useWorkbotTransport, type WorkbotTransport } from "./hooks"

/**
 * Workbot's Calendar data: the person's Automations, runs and meetings, all through Workbot's server
 * (`/v1/workbot/calendar/...`), which forwards Den's own routes. The shapes are Den's, so the shared @openwork/calendar
 * adapters and reconciliation work unchanged on every client.
 */
const PREFIX = "/v1/workbot/calendar"

/** A failed Calendar request, shaped like Den's errors so the shared adapters can classify it. */
export class WorkbotCalendarError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = "WorkbotCalendarError"
  }
}

async function calendarJson<T>(transport: WorkbotTransport, schema: z.ZodType<T>, path: string, init: { method?: "GET" | "POST" | "PATCH"; body?: unknown } = {}): Promise<T> {
  const { status, ok, payload } = await transport.request(`${PREFIX}${path}`, init)
  if (!ok) {
    const body = typeof payload === "object" && payload !== null ? payload : {}
    const code = "error" in body && typeof body.error === "string" ? body.error : "request_failed"
    const message = "message" in body && typeof body.message === "string" ? body.message : `Request failed with ${status}.`
    throw new WorkbotCalendarError(status, code, message)
  }
  const parsed = schema.safeParse(payload)
  if (!parsed.success) throw new WorkbotCalendarError(502, "invalid_payload", "The calendar answered with something unexpected.")
  return parsed.data
}

const runPageSchema = z.object({ items: z.array(automationRunSchema), nextCursor: z.string().nullable() })

export const calendarKey = ["workbot", "calendar"] as const

/** Where the Calendar's runs and meetings come from, for @openwork/calendar's hooks. */
export function useCalendarSources(): { runs: AutomationRunsSource; transport: CalendarTransport } {
  const transport = useWorkbotTransport()
  return useMemo(() => ({
    runs: {
      listRunsInRange: (input) => {
        const params = new URLSearchParams({ from: String(input.from), to: String(input.to) })
        if (input.cursor) params.set("cursor", input.cursor)
        if (input.limit) params.set("limit", String(input.limit))
        return calendarJson(transport, automationRunRangeSchema, `/v1/automation-runs?${params.toString()}`)
      },
      listRuns: (automationId, input) => calendarJson(transport, runPageSchema, `/v1/automations/${encodeURIComponent(automationId)}/runs?limit=${input.limit}`),
    },
    transport: {
      kind: "den",
      google: async (query) => (await calendarJson(transport, denGoogleCalendarEventsResponseSchema, `${DEN_GOOGLE_CALENDAR_EVENTS_PATH}?${calendarRangeSearch(query)}`)).events,
      microsoft: async (query) => (await calendarJson(transport, denMicrosoftCalendarEventsResponseSchema, `${DEN_MICROSOFT_CALENDAR_EVENTS_PATH}?${calendarRangeSearch(query)}`)).events,
    },
  }), [transport])
}

export function useWorkbotAutomations() {
  const transport = useWorkbotTransport()
  return useQuery({
    queryKey: [...calendarKey, "automations"],
    queryFn: () => calendarJson(transport, automationListSchema, "/v1/automations?limit=100"),
    refetchInterval: 60_000,
  })
}

export function useAutomationRuns(automationId: string | null) {
  const transport = useWorkbotTransport()
  return useQuery({
    queryKey: [...calendarKey, "runs", automationId],
    queryFn: () => calendarJson(transport, runPageSchema, `/v1/automations/${encodeURIComponent(automationId ?? "")}/runs?limit=10`),
    enabled: automationId !== null,
  })
}

export function useRunReceipt(runId: string | null) {
  const transport = useWorkbotTransport()
  return useQuery({
    queryKey: [...calendarKey, "receipt", runId],
    queryFn: () => calendarJson(transport, automationRunReceiptSchema, `/v1/automation-runs/${encodeURIComponent(runId ?? "")}`),
    enabled: runId !== null,
  })
}

/** What Workbot's Calendar may change on an Automation; never where it runs. */
export type AutomationChanges = { name?: string; schedule?: AutomationSchedule; instructions?: string; model?: AutomationModel }

export type CalendarAction =
  | { kind: "pause"; automationId: string }
  | { kind: "resume"; automationId: string }
  | { kind: "run"; automationId: string }
  | { kind: "edit"; automationId: string; changes: AutomationChanges }

/** Pause / Resume / Run now / Edit, through Den's own Automation routes; every Calendar query refreshes after. */
export function useCalendarAction() {
  const transport = useWorkbotTransport()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (action: CalendarAction) => {
      const base = `/v1/automations/${encodeURIComponent(action.automationId)}`
      if (action.kind === "edit") {
        await calendarJson(transport, z.unknown(), base, { method: "PATCH", body: action.changes })
        return
      }
      const verb = action.kind === "pause" ? "deactivate" : action.kind === "resume" ? "activate" : "run"
      await calendarJson(transport, z.unknown(), `${base}/${verb}`, { method: "POST", body: {} })
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: calendarKey }),
  })
}

/** Creates a Cloud Automation from the Calendar: Workbot has no desktop, so it always runs in the cloud. */
export function useCreateAutomation() {
  const transport = useWorkbotTransport()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { name: string; instructions: string; schedule: AutomationSchedule; model: AutomationModel }) =>
      calendarJson(transport, automationDetailSchema, "/v1/cloud-automations", {
        method: "POST",
        body: { name: input.name, schedule: input.schedule, action: { kind: "agent", instructions: input.instructions, model: input.model } },
      }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: calendarKey }),
  })
}

const providerNamesSchema = z.object({
  llmProviders: z.array(z.object({
    id: z.string(),
    source: z.string(),
    providerId: z.string(),
    name: z.string(),
    models: z.array(z.object({ id: z.string(), name: z.string() })),
  })),
})

/**
 * The models a cloud Automation can use: the organization's cloud default (when its cloud runs Automations headless)
 * and the providers this member may use, the same list the desktop editor offers for the cloud.
 */
export function useAutomationModels(options: { includeCloudDefault: boolean }) {
  const transport = useWorkbotTransport()
  const query = useQuery({
    queryKey: [...calendarKey, "models"],
    queryFn: () => calendarJson(transport, providerNamesSchema, "/v1/llm-providers"),
    staleTime: 5 * 60_000,
  })
  const models = useMemo(
    () => automationModelOptions(query.data?.llmProviders ?? [], { includeFreeStarter: false, includeCloudDefault: options.includeCloudDefault }),
    [options.includeCloudDefault, query.data],
  )
  return { models, isLoading: query.isLoading, error: query.error }
}

/** The cloud default model as an Automation stores it. */
export const CLOUD_DEFAULT_MODEL: AutomationModel = { providerId: AUTOMATION_CLOUD_DEFAULT_MODEL.providerId, modelId: AUTOMATION_CLOUD_DEFAULT_MODEL.modelId, variant: null }
