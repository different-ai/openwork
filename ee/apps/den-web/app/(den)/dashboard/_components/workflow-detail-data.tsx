"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  generatedArtifactViewSchema,
  workflowDetailSchema,
  type GeneratedArtifactView,
  type WorkflowDetail,
} from "@openwork/types/workflows";
import { getErrorMessage, requestJson } from "../../_lib/den-flow";

type WorkflowSummary = {
  type: "workflow"; id: string; plugin: { id: string; name: string } | null; name: string; description: string | null;
  role: "viewer" | "editor" | "manager"; state: "ready" | "needs_signin" | "needs_admin_setup";
  resultState: "never_run" | "fresh" | "stale" | "needs_attention"; latestSuccessfulAt: string | null;
  viewState: "default" | "custom_active" | "build_failed" | "retired"; activeViewTitle: string | null;
  automationCount: number; source: { kind: "created" | "installed_template" };
};
export type WorkflowLibraryDetail = { workflow: WorkflowSummary; script: WorkflowDetail; views: GeneratedArtifactView[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseWorkflowDetail(value: unknown): WorkflowLibraryDetail {
  if (!isRecord(value) || !isRecord(value.workflow) || !Array.isArray(value.views)) throw new Error("Workflow response was incomplete.");
  const workflow = value.workflow;
  const role = workflow.role === "viewer" || workflow.role === "editor" || workflow.role === "manager" ? workflow.role : null;
  const state = workflow.state === "ready" || workflow.state === "needs_signin" || workflow.state === "needs_admin_setup" ? workflow.state : null;
  const resultState = workflow.resultState === "never_run" || workflow.resultState === "fresh" || workflow.resultState === "stale" || workflow.resultState === "needs_attention" ? workflow.resultState : null;
  const viewState = workflow.viewState === "default" || workflow.viewState === "custom_active" || workflow.viewState === "build_failed" || workflow.viewState === "retired" ? workflow.viewState : null;
  const sourceKind = isRecord(workflow.source) && (workflow.source.kind === "created" || workflow.source.kind === "installed_template") ? workflow.source.kind : null;
  const plugin = isRecord(workflow.plugin) && typeof workflow.plugin.id === "string" && typeof workflow.plugin.name === "string" ? { id: workflow.plugin.id, name: workflow.plugin.name } : null;
  if (workflow.type !== "workflow" || typeof workflow.id !== "string" || (workflow.plugin !== null && !plugin) || typeof workflow.name !== "string" || !role || !state || !resultState || !viewState || !sourceKind || typeof workflow.automationCount !== "number") {
    throw new Error("Workflow response was incomplete.");
  }
  return {
    workflow: {
      type: "workflow", id: workflow.id, plugin, name: workflow.name,
      description: typeof workflow.description === "string" ? workflow.description : null,
      role, state, resultState,
      latestSuccessfulAt: typeof workflow.latestSuccessfulAt === "string" ? workflow.latestSuccessfulAt : null,
      viewState, activeViewTitle: typeof workflow.activeViewTitle === "string" ? workflow.activeViewTitle : null,
      automationCount: workflow.automationCount, source: { kind: sourceKind },
    },
    script: workflowDetailSchema.parse(value.script),
    views: value.views.map((view) => generatedArtifactViewSchema.parse(view)),
  };
}

async function mutationJson(path: string, method: "POST" | "PUT") {
  const { response, payload } = await requestJson(path, { method }, 15_000);
  if (!response.ok) throw new Error(getErrorMessage(payload, `Workflow action failed (${response.status}).`));
  return payload;
}

export function useWorkflowLibraryDetail(workflowId: string) {
  return useQuery({
    queryKey: ["workflow", workflowId],
    queryFn: async () => {
      const { response, payload } = await requestJson(`/v1/workflows/${encodeURIComponent(workflowId)}`, { method: "GET" }, 15_000);
      if (!response.ok) throw new Error(getErrorMessage(payload, `Failed to load Workflow (${response.status}).`));
      return parseWorkflowDetail(payload);
    },
  });
}

export function useActivateArtifactView(workflowId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ viewId, revisionId }: { viewId: string; revisionId: string }) => generatedArtifactViewSchema.parse(await mutationJson(
      `/v1/artifact-views/${encodeURIComponent(viewId)}/revisions/${encodeURIComponent(revisionId)}/activate`,
      "POST",
    )),
    onSuccess: async () => client.invalidateQueries({ queryKey: ["workflow", workflowId] }),
  });
}

export function useRetireArtifactView(workflowId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (viewId: string) => generatedArtifactViewSchema.parse(await mutationJson(
      `/v1/artifact-views/${encodeURIComponent(viewId)}/retire`,
      "POST",
    )),
    onSuccess: async () => client.invalidateQueries({ queryKey: ["workflow", workflowId] }),
  });
}
