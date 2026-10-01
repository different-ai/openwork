"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { getErrorMessage, requestJson } from "../../_lib/den-flow";

const stepSchema = z.object({ label: z.string(), status: z.enum(["running", "done", "error"]) });
const turnSchema = z.object({
  id: z.string(),
  text: z.string(),
  sentAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
  status: z.enum(["queued", "working", "done", "failed", "stopped"]),
  reply: z.string(),
  activity: z.string().nullable(),
  steps: z.array(stepSchema),
  files: z.array(z.string()),
  automationIds: z.array(z.string()),
  browser: z.object({ used: z.boolean(), handedOff: z.boolean(), site: z.string().nullable() }),
  error: z.string().nullable(),
});
export type WorkbotTurn = z.infer<typeof turnSchema>;

const scheduleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("once"), timezone: z.string(), at: z.number() }),
  z.object({ kind: z.literal("daily"), timezone: z.string(), hour: z.number(), minute: z.number() }),
  z.object({ kind: z.literal("weekly"), timezone: z.string(), daysOfWeek: z.array(z.number()), hour: z.number(), minute: z.number() }),
]);
export type WorkbotSchedule = z.infer<typeof scheduleSchema>;

const automationSchema = z.object({
  id: z.string(),
  name: z.string(),
  state: z.string(),
  schedule: scheduleSchema,
  nextDueAt: z.number().nullable(),
  runs: z.array(z.object({
    id: z.string(),
    status: z.string(),
    finishedAt: z.number().nullable(),
    resultSummary: z.string().nullable(),
    error: z.string().nullable(),
  })),
});
export type WorkbotAutomation = z.infer<typeof automationSchema>;

const threadSchema = z.discriminatedUnion("available", [
  z.object({ available: z.literal(false), reason: z.enum(["workbot_not_enabled", "workbot_runner_unavailable"]) }),
  z.object({
    available: z.literal(true),
    name: z.string(),
    organizationName: z.string(),
    status: z.enum(["idle", "busy"]),
    turns: z.array(turnSchema),
    automations: z.array(automationSchema),
  }),
]);
export type WorkbotThread = z.infer<typeof threadSchema>;

export const workbotQueryKey = ["workbot", "thread"] as const;

/**
 * Polls quickly only while an answer is in progress (or one was just sent),
 * and slowly otherwise so scheduled results still arrive.
 */
export function useWorkbotThread(input: { awaiting: boolean }) {
  return useQuery({
    queryKey: workbotQueryKey,
    queryFn: async () => {
      const { response, payload } = await requestJson("/v1/workbot", { method: "GET" }, 30_000);
      if (!response.ok) throw new Error(getErrorMessage(payload, "Couldn't load the conversation."));
      return threadSchema.parse(payload);
    },
    refetchInterval: (query) => {
      const data = query.state.data;
      if (input.awaiting || (data?.available && data.status === "busy")) return 1_500;
      return 20_000;
    },
    refetchIntervalInBackground: false,
    retry: 2,
  });
}

export class WorkbotSendError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "WorkbotSendError";
  }
}

export function useSendWorkbotMessage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; text: string }) => {
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const { response, payload } = await requestJson("/v1/workbot/messages", {
        method: "POST",
        body: JSON.stringify({ ...input, timeZone }),
      }, 30_000);
      if (response.status === 429) {
        const limited = typeof payload === "object" && payload !== null && "error" in payload && payload.error === "rate_limited";
        throw new WorkbotSendError(limited ? "You're sending messages quickly. Try again in a minute." : "Too many messages are waiting. Try again when this one is answered.", 429);
      }
      if (!response.ok) throw new WorkbotSendError(getErrorMessage(payload, "That didn't send."), response.status);
    },
    onSettled: async () => queryClient.invalidateQueries({ queryKey: workbotQueryKey }),
  });
}

export function useStopWorkbot() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { response, payload } = await requestJson("/v1/workbot/stop", { method: "POST" }, 15_000);
      if (!response.ok) throw new Error(getErrorMessage(payload, "Couldn't stop."));
    },
    onSettled: async () => queryClient.invalidateQueries({ queryKey: workbotQueryKey }),
  });
}

export function useWorkbotDraft(path: string | null) {
  return useQuery({
    queryKey: ["workbot", "draft", path],
    enabled: Boolean(path),
    queryFn: async () => {
      const { response, text } = await requestJson(`/v1/workbot/files/content?path=${encodeURIComponent(path ?? "")}`, { method: "GET" }, 15_000);
      if (!response.ok) throw new Error("This draft is no longer available.");
      return text;
    },
  });
}
