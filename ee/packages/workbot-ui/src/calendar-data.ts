"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import {
  denGoogleCalendarEventsResponseSchema,
  denMicrosoftCalendarEventsResponseSchema,
  DEN_GOOGLE_CALENDAR_EVENTS_PATH,
  DEN_MICROSOFT_CALENDAR_EVENTS_PATH,
  calendarRangeSearch,
  type AutomationRunsSource,
  type CalendarTransport,
} from "@openwork/calendar";
import {
  AUTOMATION_CLOUD_DEFAULT_MODEL,
  automationDetailSchema,
  automationListSchema,
  automationRunRangeSchema,
  automationRunReceiptSchema,
  automationRunSchema,
  type AutomationSchedule,
} from "@openwork/types/automations";
import { z } from "zod";
import { workbotHost } from "./host";

/**
 * Workbot's Calendar data: the person's Automations, runs and meetings, all through Workbot's server
 * (`/v1/workbot/calendar/...`), which forwards Den's own routes. The shapes are Den's, so the shared
 * @openwork/calendar adapters and reconciliation work unchanged.
 */

const PREFIX = "/v1/workbot/calendar";

/** A failed Calendar request, shaped like Den's errors so the shared adapters can classify it. */
export class WorkbotCalendarError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "WorkbotCalendarError";
    this.status = status;
    this.code = code;
  }
}

async function calendarJson<T>(schema: z.ZodType<T>, path: string, init: RequestInit = {}): Promise<T> {
  const { response, payload } = await workbotHost().requestJson(`${PREFIX}${path}`, init);
  if (!response.ok) {
    const body = typeof payload === "object" && payload !== null ? payload : {};
    const code = "error" in body && typeof body.error === "string" ? body.error : "request_failed";
    const message = "message" in body && typeof body.message === "string" ? body.message : `Request failed with ${response.status}.`;
    throw new WorkbotCalendarError(response.status, code, message);
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new WorkbotCalendarError(502, "invalid_payload", "The calendar answered with something unexpected.");
  return parsed.data;
}

const runPageSchema = z.object({ items: z.array(automationRunSchema), nextCursor: z.string().nullable() });

export const workbotRunsSource: AutomationRunsSource = {
  listRunsInRange: (input) => {
    const params = new URLSearchParams({ from: String(input.from), to: String(input.to) });
    if (input.cursor) params.set("cursor", input.cursor);
    if (input.limit) params.set("limit", String(input.limit));
    return calendarJson(automationRunRangeSchema, `/v1/automation-runs?${params.toString()}`);
  },
  listRuns: (automationId, input) => calendarJson(runPageSchema, `/v1/automations/${encodeURIComponent(automationId)}/runs?limit=${input.limit}`),
};

export const workbotCalendarTransport: CalendarTransport = {
  kind: "den",
  google: async (query) => (await calendarJson(denGoogleCalendarEventsResponseSchema, `${DEN_GOOGLE_CALENDAR_EVENTS_PATH}?${calendarRangeSearch(query)}`)).events,
  microsoft: async (query) => (await calendarJson(denMicrosoftCalendarEventsResponseSchema, `${DEN_MICROSOFT_CALENDAR_EVENTS_PATH}?${calendarRangeSearch(query)}`)).events,
};

export const calendarKey = ["workbot", "calendar"] as const;

export function useWorkbotAutomations() {
  return useQuery({
    queryKey: [...calendarKey, "automations"],
    queryFn: () => calendarJson(automationListSchema, "/v1/automations?limit=100"),
    refetchInterval: 60_000,
  });
}

export function useAutomationRuns(automationId: string | null) {
  return useQuery({
    queryKey: [...calendarKey, "runs", automationId],
    queryFn: () => calendarJson(runPageSchema, `/v1/automations/${encodeURIComponent(automationId ?? "")}/runs?limit=10`),
    enabled: automationId !== null,
  });
}

export function useRunReceipt(runId: string | null) {
  return useQuery({
    queryKey: [...calendarKey, "receipt", runId],
    queryFn: () => calendarJson(automationRunReceiptSchema, `/v1/automation-runs/${encodeURIComponent(runId ?? "")}`),
    enabled: runId !== null,
  });
}

const anyJson = z.unknown();

export type CalendarAction =
  | { kind: "pause"; automationId: string }
  | { kind: "resume"; automationId: string }
  | { kind: "run"; automationId: string }
  | { kind: "schedule"; automationId: string; schedule: AutomationSchedule };

/** Pause / Resume / Run now / Edit schedule, through Den's own Automation routes; every Calendar query refreshes after. */
export function useCalendarAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (action: CalendarAction) => {
      const base = `/v1/automations/${encodeURIComponent(action.automationId)}`;
      if (action.kind === "schedule") {
        await calendarJson(anyJson, base, { method: "PATCH", body: JSON.stringify({ schedule: action.schedule }) });
        return;
      }
      const verb = action.kind === "pause" ? "deactivate" : action.kind === "resume" ? "activate" : "run";
      await calendarJson(anyJson, `${base}/${verb}`, { method: "POST", body: "{}" });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: calendarKey }),
  });
}

/**
 * Creates a Cloud Automation from the Calendar: Workbot has no desktop, so it always runs in the cloud on the
 * organization's cloud default model, the way Workbot's own scheduling does.
 */
export function useCreateAutomation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; instructions: string; schedule: AutomationSchedule }) => calendarJson(automationDetailSchema, "/v1/cloud-automations", {
      method: "POST",
      body: JSON.stringify({
        name: input.name,
        schedule: input.schedule,
        action: { kind: "agent", instructions: input.instructions, model: { providerId: AUTOMATION_CLOUD_DEFAULT_MODEL.providerId, modelId: AUTOMATION_CLOUD_DEFAULT_MODEL.modelId, variant: null } },
      }),
    }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: calendarKey }),
  });
}

export function useCalendarSources() {
  return useMemo(() => ({ runs: workbotRunsSource, transport: workbotCalendarTransport }), []);
}
