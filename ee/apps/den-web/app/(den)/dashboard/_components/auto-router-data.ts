"use client";

import {
  autoRouterOptionsSchema,
  autoRouterSettingsSchema,
  type AutoRouterOptions,
  type AutoRouterSettings,
  type AutoRouterWrite,
} from "@openwork/types/den/auto-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getErrorMessage, getRequestError, requestJson } from "../../_lib/den-flow";
import { ORG_SCOPE_HEADER } from "../../_lib/org-scope";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

const settingsPath = "/v1/org/auto-router";
const optionsPath = "/v1/org/auto-router/options";

function autoRouterQueryKey(orgId: string): string[] {
  return ["org-auto-router", orgId];
}

function autoRouterOptionsQueryKey(orgId: string): string[] {
  return ["org-auto-router", orgId, "options"];
}

/** Whether the Auto Router is on, its routes, and whether this person may change them. */
export function useAutoRouterSettings(orgId: string, enabled = true) {
  return useQuery({
    queryKey: autoRouterQueryKey(orgId),
    enabled: enabled && Boolean(orgId),
    retry: false,
    queryFn: async ({ signal }): Promise<AutoRouterSettings> => {
      const { response, payload } = await requestJson(
        settingsPath,
        { method: "GET", headers: { [ORG_SCOPE_HEADER]: orgId }, cache: "no-store", signal },
        15000,
      );
      if (!response.ok) throw new Error(getErrorMessage(payload, `Couldn't load the Auto Router (${response.status}).`));
      const parsed = autoRouterSettingsSchema.safeParse(payload);
      if (!parsed.success) throw new Error("The Auto Router returned an unexpected response.");
      return parsed.data;
    },
  });
}

/** The AI Gateway models a route can use, with the thinking levels each allows. */
export function useAutoRouterOptions(orgId: string, enabled = true) {
  return useQuery({
    queryKey: autoRouterOptionsQueryKey(orgId),
    enabled: enabled && Boolean(orgId),
    retry: false,
    staleTime: 30_000,
    queryFn: async ({ signal }): Promise<AutoRouterOptions> => {
      const { response, payload } = await requestJson(
        optionsPath,
        { method: "GET", headers: { [ORG_SCOPE_HEADER]: orgId }, cache: "no-store", signal },
        20000,
      );
      if (!response.ok) throw new Error(getErrorMessage(payload, `Couldn't load your AI Gateway models (${response.status}).`));
      const parsed = autoRouterOptionsSchema.safeParse(payload);
      if (!parsed.success) throw new Error("The model list returned an unexpected response.");
      return parsed.data;
    },
  });
}

/** Replaces the whole Auto Router configuration. Errors carry the server's message. */
export function useSaveAutoRouter(orgId: string) {
  const queryClient = useQueryClient();
  const { runReauthableAction } = useOrgDashboard();

  return useMutation({
    mutationKey: [...autoRouterQueryKey(orgId), "save"],
    retry: false,
    mutationFn: async (input: AutoRouterWrite): Promise<AutoRouterSettings | null> => {
      const result: { saved: AutoRouterSettings | null } = { saved: null };
      await runReauthableAction("save-auto-router", async () => {
        const { response, payload } = await requestJson(
          settingsPath,
          { method: "PUT", headers: { [ORG_SCOPE_HEADER]: orgId }, body: JSON.stringify(input) },
          20000,
        );
        if (!response.ok) throw getRequestError(payload, response, `Couldn't save the Auto Router (${response.status}).`);
        const parsed = autoRouterSettingsSchema.safeParse(payload);
        result.saved = parsed.success ? parsed.data : null;
      });
      return result.saved;
    },
    onSuccess: (saved) => {
      if (saved) queryClient.setQueryData(autoRouterQueryKey(orgId), saved);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: autoRouterQueryKey(orgId), exact: true }),
  });
}
