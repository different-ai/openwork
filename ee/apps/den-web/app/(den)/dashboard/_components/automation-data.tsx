"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  automationDetailSchema,
  automationListSchema,
  automationRunReceiptSchema,
  automationRunSchema,
} from "@openwork/types/automations";
import { workflowArtifactSnapshotSchema } from "@openwork/types/workflows";
import { getErrorMessage, requestJson } from "../../_lib/den-flow";

const ACTIVE_RUN_STATUSES = ["queued", "claimed", "running"];

async function payload(path: string, init: RequestInit = { method: "GET" }) {
  const result = await requestJson(path, init, 170_000);
  if (!result.response.ok) throw new Error(getErrorMessage(result.payload, `Automation request failed (${result.response.status}).`));
  return result.payload;
}

export function useAutomations({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    enabled,
    queryKey: ["automations", "list"],
    queryFn: async () => automationListSchema.parse(await payload("/v1/automations?limit=100")),
  });
}

export function useAutomation(automationId: string | null) {
  return useQuery({
    queryKey: ["automations", "detail", automationId],
    queryFn: async () => automationDetailSchema.parse(await payload(`/v1/automations/${encodeURIComponent(automationId ?? "")}`)),
    enabled: Boolean(automationId),
  });
}

export function useAutomationRuns(automationId: string | null) {
  return useQuery({
    queryKey: ["automations", "runs", automationId],
    queryFn: async () => {
      const value = await payload(`/v1/automations/${encodeURIComponent(automationId ?? "")}/runs?limit=100`);
      if (typeof value !== "object" || value === null || !("items" in value) || !Array.isArray(value.items)) throw new Error("Automation run history was invalid.");
      return value.items.map((item) => automationRunSchema.parse(item));
    },
    enabled: Boolean(automationId),
    // Fast while a run is in flight; otherwise often enough to pick up scheduled runs.
    // Starting or cancelling a run here refetches at once.
    refetchInterval: (query) => query.state.data?.some((run) => ACTIVE_RUN_STATUSES.includes(run.status)) ? 5_000 : 60_000,
  });
}

export function useAutomationRun(runId: string | null) {
  return useQuery({
    queryKey: ["automations", "run", runId],
    queryFn: async () => automationRunReceiptSchema.parse(await payload(`/v1/automation-runs/${encodeURIComponent(runId ?? "")}`)),
    enabled: Boolean(runId),
    refetchInterval: (query) => {
      const status = query.state.data?.run.status;
      return status && ACTIVE_RUN_STATUSES.includes(status) ? 2_000 : false;
    },
  });
}

export function useAutomationArtifactSnapshot(configObjectId: string | null, receiptId: string | null) {
  return useQuery({
    queryKey: ["workflow", configObjectId, "snapshot", receiptId],
    queryFn: async () => workflowArtifactSnapshotSchema.parse(await payload(`/v1/workflows/${encodeURIComponent(configObjectId ?? "")}/snapshots/${encodeURIComponent(receiptId ?? "")}`)),
    enabled: Boolean(configObjectId && receiptId),
  });
}

function useAutomationMutation<TInput, TResult>(mutationFn: (input: TInput) => Promise<TResult>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSettled: async () => queryClient.invalidateQueries({ queryKey: ["automations"] }),
  });
}

export function useCancelAutomationRun() {
  return useAutomationMutation<string, ReturnType<typeof automationRunSchema.parse>>(
    async (runId) => {
      const value = await payload(`/v1/automation-runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" });
      if (typeof value !== "object" || value === null || !("run" in value)) throw new Error("Automation cancellation response was invalid.");
      return automationRunSchema.parse(value.run);
    },
  );
}
