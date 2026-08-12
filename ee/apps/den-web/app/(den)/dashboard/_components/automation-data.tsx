"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  automationDetailSchema,
  automationListSchema,
  automationRunReceiptSchema,
  automationRunSchema,
} from "@openwork/types/automations";
import type { CreateCloudAutomation, UpdateAutomation } from "@openwork/types/automations";
import { savedScriptArtifactSnapshotSchema } from "@openwork/types/dynamic-artifacts";
import { getErrorMessage, requestJson } from "../../_lib/den-flow";

async function payload(path: string, init: RequestInit = { method: "GET" }) {
  const result = await requestJson(path, init, 170_000);
  if (!result.response.ok) throw new Error(getErrorMessage(result.payload, `Automation request failed (${result.response.status}).`));
  return result.payload;
}

export function useAutomations() {
  return useQuery({ queryKey: ["automations", "list"], queryFn: async () => automationListSchema.parse(await payload("/v1/automations?limit=100")) });
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
    refetchInterval: 5_000,
  });
}

export function useAutomationRun(runId: string | null) {
  return useQuery({
    queryKey: ["automations", "run", runId],
    queryFn: async () => automationRunReceiptSchema.parse(await payload(`/v1/automation-runs/${encodeURIComponent(runId ?? "")}`)),
    enabled: Boolean(runId),
    refetchInterval: (query) => {
      const status = query.state.data?.run.status;
      return status && ["queued", "claimed", "running"].includes(status) ? 2_000 : false;
    },
  });
}

export function useAutomationArtifactSnapshot(configObjectId: string | null, receiptId: string | null) {
  return useQuery({
    queryKey: ["saved-script", configObjectId, "snapshot", receiptId],
    queryFn: async () => savedScriptArtifactSnapshotSchema.parse(await payload(`/v1/codemode-scripts/${encodeURIComponent(configObjectId ?? "")}/snapshots/${encodeURIComponent(receiptId ?? "")}`)),
    enabled: Boolean(configObjectId && receiptId),
  });
}

export function useRunAutomationNow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (automationId: string) => {
      const value = await payload(`/v1/automations/${encodeURIComponent(automationId)}/run`, { method: "POST" });
      if (typeof value !== "object" || value === null || !("run" in value)) throw new Error("Automation run response was invalid.");
      return automationRunSchema.parse(value.run);
    },
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ["automations"] }),
  });
}

export function useCreateCloudAutomation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (definition: CreateCloudAutomation) => automationDetailSchema.parse(await payload("/v1/cloud-automations", {
      method: "POST",
      body: JSON.stringify(definition),
    })),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ["automations"] }),
  });
}

function useAutomationMutation<TInput, TResult>(mutationFn: (input: TInput) => Promise<TResult>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSettled: async () => queryClient.invalidateQueries({ queryKey: ["automations"] }),
  });
}

export function useUpdateAutomation() {
  return useAutomationMutation<{ automationId: string; changes: UpdateAutomation }, ReturnType<typeof automationDetailSchema.parse>>(
    async ({ automationId, changes }) => automationDetailSchema.parse(await payload(
      `/v1/automations/${encodeURIComponent(automationId)}`,
      { method: "PATCH", body: JSON.stringify(changes) },
    )),
  );
}

export function useSetAutomationState() {
  return useAutomationMutation<{ automationId: string; action: "activate" | "deactivate" }, ReturnType<typeof automationDetailSchema.parse>>(
    async ({ automationId, action }) => automationDetailSchema.parse(await payload(
      `/v1/automations/${encodeURIComponent(automationId)}/${action}`,
      { method: "POST" },
    )),
  );
}

export function useArchiveAutomation() {
  return useAutomationMutation<string, ReturnType<typeof automationDetailSchema.parse>>(
    async (automationId) => automationDetailSchema.parse(await payload(
      `/v1/automations/${encodeURIComponent(automationId)}`,
      { method: "DELETE" },
    )),
  );
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
