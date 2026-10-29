"use client";

import { orgPromptSettingsSchema, type OrgPromptSettings } from "@openwork/types/den/prompts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getErrorMessage, getRequestError, requestJson } from "../../_lib/den-flow";
import { ORG_SCOPE_HEADER } from "../../_lib/org-scope";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

const settingsPath = "/v1/org/prompts";

export function promptsQueryKey(orgId: string): string[] {
  return ["org-prompts", orgId];
}

function scopePath(teamId: string | null): string {
  return teamId ? `${settingsPath}/teams/${encodeURIComponent(teamId)}` : `${settingsPath}/everyone`;
}

function parseSettings(payload: unknown): OrgPromptSettings | null {
  const parsed = orgPromptSettingsSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

/** The prompt for everyone and each team's own prompt. */
export function usePromptSettings(orgId: string, enabled = true) {
  return useQuery({
    queryKey: promptsQueryKey(orgId),
    enabled: enabled && Boolean(orgId),
    retry: false,
    queryFn: async ({ signal }): Promise<OrgPromptSettings> => {
      const { response, payload } = await requestJson(
        settingsPath,
        { method: "GET", headers: { [ORG_SCOPE_HEADER]: orgId }, cache: "no-store", signal },
        15000,
      );
      if (!response.ok) throw new Error(getErrorMessage(payload, `Couldn't load prompts (${response.status}).`));
      const settings = parseSettings(payload);
      if (!settings) throw new Error("Prompts returned an unexpected response.");
      return settings;
    },
  });
}

export type SavePromptInput = { teamId: string | null; content: string };

/** Sets the prompt for everyone (teamId null) or one team; the first save creates it. */
export function useSavePrompt(orgId: string) {
  const queryClient = useQueryClient();
  const { runReauthableAction } = useOrgDashboard();

  return useMutation({
    mutationKey: [...promptsQueryKey(orgId), "save"],
    retry: false,
    mutationFn: async (input: SavePromptInput): Promise<OrgPromptSettings | null> => {
      const result: { saved: OrgPromptSettings | null } = { saved: null };
      await runReauthableAction("save-prompt", async () => {
        const { response, payload } = await requestJson(
          scopePath(input.teamId),
          { method: "PUT", headers: { [ORG_SCOPE_HEADER]: orgId }, body: JSON.stringify({ content: input.content }) },
          20000,
        );
        if (!response.ok) throw getRequestError(payload, response, `Couldn't save the prompt (${response.status}).`);
        result.saved = parseSettings(payload);
      });
      return result.saved;
    },
    onSuccess: (saved) => {
      if (saved) queryClient.setQueryData(promptsQueryKey(orgId), saved);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: promptsQueryKey(orgId), exact: true }),
  });
}

/** Removes the prompt for everyone (teamId null) or one team. */
export function useRemovePrompt(orgId: string) {
  const queryClient = useQueryClient();
  const { runReauthableAction } = useOrgDashboard();

  return useMutation({
    mutationKey: [...promptsQueryKey(orgId), "remove"],
    retry: false,
    mutationFn: async (teamId: string | null): Promise<OrgPromptSettings | null> => {
      const result: { saved: OrgPromptSettings | null } = { saved: null };
      await runReauthableAction("remove-prompt", async () => {
        const { response, payload } = await requestJson(
          scopePath(teamId),
          { method: "DELETE", headers: { [ORG_SCOPE_HEADER]: orgId } },
          20000,
        );
        if (!response.ok) throw getRequestError(payload, response, `Couldn't remove the prompt (${response.status}).`);
        result.saved = parseSettings(payload);
      });
      return result.saved;
    },
    onSuccess: (saved) => {
      if (saved) queryClient.setQueryData(promptsQueryKey(orgId), saved);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: promptsQueryKey(orgId), exact: true }),
  });
}
