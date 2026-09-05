"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  workflowArtifactSnapshotSchema,
  workflowDetailSchema,
  workflowTestResultSchema,
  type WorkflowCapability,
} from "@openwork/types/workflows";
import { getErrorMessage, requestJson } from "../../_lib/den-flow";

export type WorkflowDraft = {
  name: string;
  description?: string;
  code: string;
  exampleInput?: unknown;
  inputSchema?: unknown;
  outputSchema?: unknown;
  requiredCapabilities: WorkflowCapability[];
};

const keys = {
  detail: (id: string, maxAgeMs: number) => ["workflow", id, "detail", maxAgeMs] as const,
  snapshots: (id: string) => ["workflow", id, "snapshots"] as const,
};

async function checkedRequest(path: string, init: RequestInit, fallback: string) {
  const { response, payload } = await requestJson(path, init, 170_000);
  if (!response.ok) throw new Error(getErrorMessage(payload, `${fallback} (${response.status}).`));
  return payload;
}

export function useWorkflowDetail(configObjectId: string, maxAgeMs: number) {
  return useQuery({
    queryKey: keys.detail(configObjectId, maxAgeMs),
    queryFn: async () => {
      const payload = await checkedRequest(
      `/v1/workflows/${encodeURIComponent(configObjectId)}?maxAgeMs=${maxAgeMs}`,
      { method: "GET" },
      "Failed to load Workflow",
      );
      if (typeof payload !== "object" || payload === null || !("script" in payload)) throw new Error("The Workflow response was invalid.");
      return workflowDetailSchema.parse(payload.script);
    },
    enabled: Boolean(configObjectId),
  });
}

export function useWorkflowSnapshots(configObjectId: string) {
  return useQuery({
    queryKey: keys.snapshots(configObjectId),
    queryFn: async () => {
      const payload = await checkedRequest(
        `/v1/workflows/${encodeURIComponent(configObjectId)}/snapshots?limit=100`,
        { method: "GET" },
        "Failed to load snapshots",
      );
      if (typeof payload !== "object" || payload === null || !("items" in payload) || !Array.isArray(payload.items)) {
        throw new Error("The snapshot response was invalid.");
      }
      return payload.items.map((item) => workflowArtifactSnapshotSchema.parse(item));
    },
    enabled: Boolean(configObjectId),
  });
}

function useLifecycleMutation<TInput, TResult>(input: {
  configObjectId: string;
  mutation: (value: TInput) => Promise<TResult>;
}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: input.mutation,
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: ["workflow", input.configObjectId] });
      await queryClient.invalidateQueries({ queryKey: ["plugins"] });
      await queryClient.invalidateQueries({ queryKey: ["automations"] });
    },
  });
}

export function useTestWorkflow(configObjectId: string) {
  return useLifecycleMutation<WorkflowDraft, ReturnType<typeof workflowTestResultSchema.parse>>({
    configObjectId,
    mutation: async (draft) => workflowTestResultSchema.parse(await checkedRequest(
      "/v1/workflows/test",
      { method: "POST", body: JSON.stringify({ configObjectId, ...draft }) },
      "Workflow test failed",
    )),
  });
}

export function useSaveWorkflowVersion(configObjectId: string) {
  return useLifecycleMutation<{ receiptId: string; draft: WorkflowDraft }, ReturnType<typeof workflowDetailSchema.parse>>({
    configObjectId,
    mutation: async ({ receiptId, draft }) => workflowDetailSchema.parse(await checkedRequest(
      `/v1/workflows/${encodeURIComponent(configObjectId)}/versions`,
      { method: "POST", body: JSON.stringify({ receiptId, ...draft }) },
      "Workflow version could not be saved",
    )),
  });
}

export function useRunWorkflow(configObjectId: string) {
  return useLifecycleMutation<{ pluginId: string; configObjectVersionId: string; input: unknown }, unknown>({
    configObjectId,
    mutation: async (value) => checkedRequest(
      `/v1/workflows/${encodeURIComponent(configObjectId)}/run`,
      { method: "POST", body: JSON.stringify(value) },
      "Workflow refresh failed",
    ),
  });
}

export function useDeleteWorkflowSnapshot(configObjectId: string) {
  return useLifecycleMutation<string, unknown>({
    configObjectId,
    mutation: async (receiptId) => checkedRequest(
      `/v1/workflows/${encodeURIComponent(configObjectId)}/snapshots/${encodeURIComponent(receiptId)}/content`,
      { method: "DELETE" },
      "Snapshot content could not be deleted",
    ),
  });
}

export function useUpdateWorkflowAutomation(configObjectId: string) {
  return useLifecycleMutation<{
    automationId: string;
    pluginId: string;
    configObjectVersionId: string;
    input: unknown;
  }, unknown>({
    configObjectId,
    mutation: async (value) => checkedRequest(
      `/v1/automations/${encodeURIComponent(value.automationId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          action: {
            kind: "saved_script",
            script: {
              pluginId: value.pluginId,
              configObjectId,
              configObjectVersionId: value.configObjectVersionId,
            },
            input: value.input,
          },
          executionTarget: "cloud",
        }),
      },
      "Automation could not be updated",
    ),
  });
}
