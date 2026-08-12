"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  automationDetailSchema,
  automationListSchema,
  automationRunReceiptSchema,
  automationRunSchema,
} from "@openwork/types/automations";
import type { CreateAutomationDefinition } from "@openwork/types/automations";
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
  });
}

export function useAutomationRun(runId: string | null) {
  return useQuery({
    queryKey: ["automations", "run", runId],
    queryFn: async () => automationRunReceiptSchema.parse(await payload(`/v1/automation-runs/${encodeURIComponent(runId ?? "")}`)),
    enabled: Boolean(runId),
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
    mutationFn: async (automationId: string) => payload(`/v1/automations/${encodeURIComponent(automationId)}/run`, { method: "POST" }),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ["automations"] }),
  });
}

export function useCreateCloudAutomation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (definition: CreateAutomationDefinition) => automationDetailSchema.parse(await payload("/v1/automations", {
      method: "POST",
      body: JSON.stringify(definition),
    })),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ["automations"] }),
  });
}
