"use client";

import { workbotSettingsSchema, type WorkbotSettings } from "@openwork/types/den/workbot-settings";
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

export function useSaveWorkbotModel(orgId: string) {
  const queryClient = useQueryClient();
  const { runReauthableAction } = useOrgDashboard();

  return useMutation({
    mutationKey: [...workbotSettingsQueryKey(orgId), "save"],
    retry: false,
    mutationFn: async (model: string | null): Promise<WorkbotSettings | null> => {
      const result: { saved: WorkbotSettings | null } = { saved: null };
      await runReauthableAction("save-workbot-model", async () => {
        const { response, payload } = await requestJson(
          workbotSettingsPath,
          { method: "PUT", headers: { [ORG_SCOPE_HEADER]: orgId }, body: JSON.stringify({ model }) },
          15000,
        );
        if (!response.ok) throw getRequestError(payload, response, `Couldn't save the default model (${response.status}).`);
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
