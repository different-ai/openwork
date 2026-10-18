"use client";

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
  type AutomationList,
  type AutomationModel,
  type AutomationSchedule,
} from "@openwork/types/automations";
import { automationModelOptions } from "@openwork/types/automation-models";
import { z } from "zod";
import { workbotSettingsSchema } from "@openwork/types/den/workbot-settings";
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
  listRuns: (automationId, input) => {
    const params = new URLSearchParams({ limit: String(input.limit) });
    if (input.cursor) params.set("cursor", input.cursor);
    return calendarJson(runPageSchema, `/v1/automations/${encodeURIComponent(automationId)}/runs?${params}`);
  },
};

export const workbotCalendarTransport: CalendarTransport = {
  kind: "den",
  google: async (query) => (await calendarJson(denGoogleCalendarEventsResponseSchema, `${DEN_GOOGLE_CALENDAR_EVENTS_PATH}?${calendarRangeSearch(query)}`)).events,
  microsoft: async (query) => (await calendarJson(denMicrosoftCalendarEventsResponseSchema, `${DEN_MICROSOFT_CALENDAR_EVENTS_PATH}?${calendarRangeSearch(query)}`)).events,
};

export const calendarKey = ["workbot", "calendar"] as const;

/** Calendar caches, including denial barriers, belong to one host and authenticated member. */
export function calendarMemberKey() {
  const host = workbotHost();
  return [...calendarKey, host.homeHref, host.identity?.organizationId ?? null, host.identity?.principalId ?? null];
}

type WorkbotAutomationPage = AutomationList & { accessDenied?: boolean };

export function useWorkbotAutomations() {
  const queryClient = useQueryClient();
  const memberKey = calendarMemberKey();
  const query = useInfiniteQuery({
    queryKey: [...memberKey, "automations"],
    initialPageParam: "",
    queryFn: async ({ pageParam, signal }): Promise<WorkbotAutomationPage> => {
      const params = new URLSearchParams({ limit: "100" });
      if (pageParam) params.set("cursor", pageParam);
      try {
        const page = await calendarJson(automationListSchema, `/v1/automations?${params}`, { signal });
        if (page.nextCursor === pageParam) throw new Error("The automation list did not advance. Try again.");
        return page;
      } catch (error) {
        // A denial remains part of the cached inventory until a fresh authorized read replaces it.
        // A later network error must not reveal the pre-denial names or instructions again.
        if (error instanceof WorkbotCalendarError && (error.status === 401 || error.status === 403)) {
          queryClient.removeQueries({ queryKey: memberKey, predicate: (entry) => entry.queryKey.length !== memberKey.length + 1 || entry.queryKey[memberKey.length] !== "automations" });
          return { items: [], nextCursor: null, accessDenied: true };
        }
        throw error;
      }
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: 60_000,
  });
  const accessDenied = query.data?.pages.some((page) => page.accessDenied === true) ?? false;
  const data = useMemo(() => query.data && !accessDenied ? {
    items: [...new Map(query.data.pages.flatMap((page) => page.items).map((item) => [item.automation.id, item])).values()],
    nextCursor: query.data.pages.at(-1)?.nextCursor ?? null,
  } : undefined, [accessDenied, query.data]);
  return { ...query, data, accessDenied };
}

export function useAutomationRuns(automationId: string | null) {
  const query = useInfiniteQuery({
    queryKey: [...calendarMemberKey(), "runs", automationId],
    initialPageParam: "",
    queryFn: async ({ pageParam, signal }) => {
      const params = new URLSearchParams({ limit: "20" });
      if (pageParam) params.set("cursor", pageParam);
      const page = await calendarJson(runPageSchema, `/v1/automations/${encodeURIComponent(automationId ?? "")}/runs?${params}`, { signal });
      if (page.nextCursor === pageParam) throw new Error("The run history did not advance. Try again.");
      return page;
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: automationId !== null,
  });
  const data = useMemo(() => query.data ? {
    items: [...new Map(query.data.pages.flatMap((page) => page.items).map((run) => [run.id, run])).values()],
    nextCursor: query.data.pages.at(-1)?.nextCursor ?? null,
  } : undefined, [query.data]);
  return { ...query, data };
}

export function useWorkbotAutomation(automationId: string | null) {
  return useQuery({
    queryKey: [...calendarMemberKey(), "automation", automationId],
    queryFn: ({ signal }) => calendarJson(automationDetailSchema, `/v1/automations/${encodeURIComponent(automationId ?? "")}`, { signal }),
    enabled: automationId !== null,
    refetchInterval: 60_000,
  });
}

export function useRunReceipt(runId: string | null) {
  return useQuery({
    queryKey: [...calendarMemberKey(), "receipt", runId],
    queryFn: () => calendarJson(automationRunReceiptSchema, `/v1/automation-runs/${encodeURIComponent(runId ?? "")}`),
    enabled: runId !== null,
  });
}

const anyJson = z.unknown();

/** What Workbot's Calendar may change on an Automation; never where it runs. */
export type AutomationChanges = { name?: string; schedule?: AutomationSchedule; instructions?: string; model?: AutomationModel };

export type CalendarAction =
  | { kind: "pause"; automationId: string }
  | { kind: "resume"; automationId: string }
  | { kind: "run"; automationId: string }
  | { kind: "edit"; automationId: string; changes: AutomationChanges };

/** Pause / Resume / Run now / Edit, through Den's own Automation routes; every Calendar query refreshes after. */
export function useCalendarAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (action: CalendarAction) => {
      const base = `/v1/automations/${encodeURIComponent(action.automationId)}`;
      if (action.kind === "edit") {
        await calendarJson(anyJson, base, { method: "PATCH", body: JSON.stringify(action.changes) });
        return;
      }
      const verb = action.kind === "pause" ? "deactivate" : action.kind === "resume" ? "activate" : "run";
      await calendarJson(anyJson, `${base}/${verb}`, { method: "POST", body: "{}" });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: calendarKey }),
  });
}

/** Creates a Cloud Automation from the Calendar: Workbot has no desktop, so it always runs in the cloud. */
export function useCreateAutomation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; instructions: string; schedule: AutomationSchedule; model: AutomationModel }) => calendarJson(automationDetailSchema, "/v1/cloud-automations", {
      method: "POST",
      body: JSON.stringify({
        name: input.name,
        schedule: input.schedule,
        action: { kind: "agent", instructions: input.instructions, model: input.model },
      }),
    }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: calendarKey }),
  });
}

export function useCalendarSources() {
  return useMemo(() => ({ runs: workbotRunsSource, transport: workbotCalendarTransport }), []);
}

const providerNamesSchema = z.object({
  llmProviders: z.array(z.object({
    id: z.string(),
    source: z.string(),
    providerId: z.string(),
    name: z.string(),
    models: z.array(z.object({ id: z.string(), name: z.string() })),
  })),
});

/**
 * The models a cloud Automation can use: the organization's cloud default (when its cloud runs Automations
 * headless) and the providers this member may use, the same list the desktop editor offers for the cloud.
 */
export function useAutomationModels(options: { includeCloudDefault: boolean }) {
  const query = useQuery({
    queryKey: [...calendarMemberKey(), "models"],
    queryFn: () => calendarJson(providerNamesSchema, "/v1/llm-providers"),
    staleTime: 5 * 60_000,
  });
  const host = workbotHost();
  const identity = host.identity;
  const settings = useQuery({
    queryKey: [...calendarMemberKey(), "organization-default-model"],
    queryFn: () => calendarJson(workbotSettingsSchema, "/v1/org/workbot-settings"),
    enabled: options.includeCloudDefault && identity !== undefined,
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
    refetchInterval: 60_000,
  });
  const authorizedSettings = identity && !settings.isError && !settings.isFetching ? settings.data : undefined;
  const models = useMemo(() => {
    const available = automationModelOptions(query.data?.llmProviders ?? [], { includeFreeStarter: false, includeCloudDefault: options.includeCloudDefault });
    const resolvedId = authorizedSettings?.modelAvailable ? authorizedSettings.model ?? authorizedSettings.defaultModel : authorizedSettings?.defaultModel;
    const resolvedName = authorizedSettings?.models.find((model) => model.id === resolvedId)?.name;
    return available.map((option) => option.accessKind === "cloud_default"
      ? { ...option, modelName: resolvedName ? `Organization default (${resolvedName})` : "Organization default" }
      : option);
  }, [options.includeCloudDefault, query.data, authorizedSettings]);
  return { models, isLoading: query.isLoading, error: query.error };
}

/** The cloud default model as an Automation stores it. */
export const CLOUD_DEFAULT_MODEL: AutomationModel = { providerId: AUTOMATION_CLOUD_DEFAULT_MODEL.providerId, modelId: AUTOMATION_CLOUD_DEFAULT_MODEL.modelId, variant: null };
