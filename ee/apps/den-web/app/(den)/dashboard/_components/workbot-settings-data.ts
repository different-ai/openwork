"use client";

import { workbotModelTestSchema, workbotSettingsSchema, type WorkbotModelTest, type WorkbotSettings, type WorkbotSettingsInput } from "@openwork/types/den/workbot-settings";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getErrorMessage, getRequestError, requestJson } from "../../_lib/den-flow";
import { ORG_SCOPE_HEADER } from "../../_lib/org-scope";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

const workbotSettingsPath = "/v1/org/workbot-settings";

export function workbotSettingsQueryKey(orgId: string): string[] {
  return ["org-workbot-settings", orgId];
}

/** Manage › Workbot: the organization's default model and the models the headless runner serves. */
export function useWorkbotSettings(orgId: string, enabled = true) {
  return useQuery({
    queryKey: workbotSettingsQueryKey(orgId),
    enabled,
    retry: false,
    queryFn: async ({ signal }): Promise<WorkbotSettings> => {
      const { response, payload } = await requestJson(
        workbotSettingsPath,
        { method: "GET", headers: { [ORG_SCOPE_HEADER]: orgId }, cache: "no-store", signal },
        15000,
      );
      if (response.status === 404) throw new Error("Workbot settings aren't turned on for this organization.");
      if (!response.ok) throw new Error(getErrorMessage(payload, `Couldn't load Workbot settings (${response.status}).`));
      const parsed = workbotSettingsSchema.safeParse(payload);
      if (!parsed.success) throw new Error("Workbot settings returned an unexpected response.");
      return parsed.data;
    },
  });
}

export function useTestWorkbotDefaultModel(orgId: string) {
  const { runReauthableAction } = useOrgDashboard();
  return useMutation({
    mutationKey: [...workbotSettingsQueryKey(orgId), "test-default"],
    retry: false,
    mutationFn: async (): Promise<WorkbotModelTest | null> => {
      const result: { value: WorkbotModelTest | null } = { value: null };
      await runReauthableAction("test-workbot-default-model", async () => {
        const { response, payload } = await requestJson(
          `${workbotSettingsPath}/test-default-model`,
          { method: "POST", headers: { [ORG_SCOPE_HEADER]: orgId }, body: JSON.stringify({}) },
          30000,
        );
        if (response.status === 429) throw new Error("This model was tested recently. Try again in a few minutes.");
        if (!response.ok) throw getRequestError(payload, response, "Couldn't test the default model. Try again.");
        result.value = workbotModelTestSchema.parse(payload);
      });
      return result.value;
    },
  });
}

/** One PUT of Workbot settings; a field left out of the body is unchanged. */
function useSaveWorkbotSettings<Value>(orgId: string, save: { key: string; action: string; body: (value: Value) => WorkbotSettingsInput; what: string }) {
  const queryClient = useQueryClient();
  const { runReauthableAction } = useOrgDashboard();

  return useMutation({
    mutationKey: [...workbotSettingsQueryKey(orgId), save.key],
    retry: false,
    mutationFn: async (value: Value): Promise<WorkbotSettings | null> => {
      const result: { saved: WorkbotSettings | null } = { saved: null };
      await runReauthableAction(save.action, async () => {
        const { response, payload } = await requestJson(
          workbotSettingsPath,
          { method: "PUT", headers: { [ORG_SCOPE_HEADER]: orgId }, body: JSON.stringify(save.body(value)) },
          15000,
        );
        if (!response.ok) throw getRequestError(payload, response, `Couldn't save ${save.what} (${response.status}).`);
        const parsed = workbotSettingsSchema.safeParse(payload);
        result.saved = parsed.success ? parsed.data : null;
      });
      return result.saved;
    },
    onSuccess: (saved) => {
      if (saved) queryClient.setQueryData(workbotSettingsQueryKey(orgId), saved);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: workbotSettingsQueryKey(orgId) }),
  });
}

export function useSaveWorkbotModel(orgId: string) {
  return useSaveWorkbotSettings(orgId, { key: "save", action: "save-workbot-model", body: (model: string | null) => ({ model }), what: "the default model" });
}

/** How many steps Workbot may take on one request: null for the default, 0 for no limit. */
export function useSaveWorkbotStepLimit(orgId: string) {
  return useSaveWorkbotSettings(orgId, { key: "save-step-limit", action: "save-workbot-step-limit", body: (maxSteps: number | null) => ({ maxSteps }), what: "the step limit" });
}
