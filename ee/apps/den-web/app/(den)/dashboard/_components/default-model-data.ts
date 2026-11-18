"use client";

import {
  defaultModelOptionsSchema,
  defaultModelSettingsSchema,
  type DefaultModelChoice,
  type DefaultModelOptions,
  type DefaultModelSettings,
} from "@openwork/types/den/default-model";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getErrorMessage, getRequestError, requestJson } from "../../_lib/den-flow";
import { ORG_SCOPE_HEADER } from "../../_lib/org-scope";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

const settingsPath = "/v1/org/default-model";
const optionsPath = "/v1/org/default-model/options";

export function defaultModelQueryKey(orgId: string): string[] {
  return ["org-default-model", orgId];
}

function defaultModelOptionsQueryKey(orgId: string): string[] {
  return ["org-default-model", orgId, "options"];
}

/** The organization default and every team's override. */
export function useDefaultModelSettings(orgId: string, enabled = true) {
  return useQuery({
    queryKey: defaultModelQueryKey(orgId),
    enabled: enabled && Boolean(orgId),
    retry: false,
    queryFn: async ({ signal }): Promise<DefaultModelSettings> => {
      const { response, payload } = await requestJson(
        settingsPath,
        { method: "GET", headers: { [ORG_SCOPE_HEADER]: orgId }, cache: "no-store", signal },
        15000,
      );
      if (!response.ok) throw new Error(getErrorMessage(payload, `Couldn't load the default model (${response.status}).`));
      const parsed = defaultModelSettingsSchema.safeParse(payload);
      if (!parsed.success) throw new Error("The default model returned an unexpected response.");
      return parsed.data;
    },
  });
}

/** Every model the organization can choose, read live from its OpenWork Models, AI Gateway and providers. */
export function useDefaultModelOptions(orgId: string, enabled = true) {
  return useQuery({
    queryKey: defaultModelOptionsQueryKey(orgId),
    enabled: enabled && Boolean(orgId),
    retry: false,
    staleTime: 30_000,
    queryFn: async ({ signal }): Promise<DefaultModelOptions> => {
      const { response, payload } = await requestJson(
        optionsPath,
        { method: "GET", headers: { [ORG_SCOPE_HEADER]: orgId }, cache: "no-store", signal },
        20000,
      );
      if (!response.ok) throw new Error(getErrorMessage(payload, `Couldn't load your organization's models (${response.status}).`));
      const parsed = defaultModelOptionsSchema.safeParse(payload);
      if (!parsed.success) throw new Error("The model list returned an unexpected response.");
      return parsed.data;
    },
  });
}

export type SaveDefaultModelInput = { teamId: string | null; model: DefaultModelChoice | null };

/** Sets or clears the organization default (teamId null) or one team's override. */
export function useSaveDefaultModel(orgId: string) {
  const queryClient = useQueryClient();
  const { runReauthableAction } = useOrgDashboard();

  return useMutation({
    mutationKey: [...defaultModelQueryKey(orgId), "save"],
    retry: false,
    mutationFn: async (input: SaveDefaultModelInput): Promise<DefaultModelSettings | null> => {
      const result: { saved: DefaultModelSettings | null } = { saved: null };
      const path = input.teamId ? `${settingsPath}/teams/${encodeURIComponent(input.teamId)}` : `${settingsPath}/everyone`;
      await runReauthableAction("save-default-model", async () => {
        const { response, payload } = await requestJson(
          path,
          { method: "PUT", headers: { [ORG_SCOPE_HEADER]: orgId }, body: JSON.stringify({ model: input.model }) },
          20000,
        );
        if (!response.ok) throw getRequestError(payload, response, `Couldn't save the default model (${response.status}).`);
        const parsed = defaultModelSettingsSchema.safeParse(payload);
        result.saved = parsed.success ? parsed.data : null;
      });
      return result.saved;
    },
    onSuccess: (saved) => {
      if (saved) queryClient.setQueryData(defaultModelQueryKey(orgId), saved);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: defaultModelQueryKey(orgId), exact: true }),
  });
}
