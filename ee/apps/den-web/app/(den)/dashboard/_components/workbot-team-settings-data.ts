"use client";

import {
  workbotTeamSettingsViewSchema,
  type WorkbotEveryoneSettingsWrite,
  type WorkbotTeamSettingsView,
  type WorkbotTeamSettingsWrite,
} from "@openwork/types/den/workbot-team-settings";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { getErrorMessage, getRequestError, requestJson } from "../../_lib/den-flow";
import { ORG_SCOPE_HEADER } from "../../_lib/org-scope";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { agentPolicyQueryKey, agentToolsRootQueryKey } from "./workbot-agent-scope";
import { workbotReadinessQueryKey } from "./workbot-readiness-data";
import { workbotSettingsQueryKey } from "./workbot-settings-data";

const teamSettingsPath = "/v1/org/workbot-settings/teams";
const everyoneSettingsPath = "/v1/org/workbot-settings/everyone";

/** Under Everyone's Workbot settings, so saving Everyone's model refreshes what teams follow. */
export function workbotTeamSettingsQueryKey(orgId: string): string[] {
  return [...workbotSettingsQueryKey(orgId), "teams"];
}

/** Everyone's Workbot settings (on or off, model, name, and whether members' agents are on while they are available) and what each team changed (the `workbotTeamSettings` feature). */
export function useWorkbotTeamSettings(orgId: string, enabled = true) {
  return useQuery({
    queryKey: workbotTeamSettingsQueryKey(orgId),
    enabled: enabled && Boolean(orgId),
    retry: false,
    queryFn: async ({ signal }): Promise<WorkbotTeamSettingsView> => {
      const { response, payload } = await requestJson(
        teamSettingsPath,
        { method: "GET", headers: { [ORG_SCOPE_HEADER]: orgId }, cache: "no-store", signal },
        15000,
      );
      if (response.status === 404) throw new Error("Workbot settings for teams aren't turned on for this organization.");
      if (!response.ok) throw new Error(getErrorMessage(payload, `Couldn't load Workbot settings for teams (${response.status}).`));
      const parsed = workbotTeamSettingsViewSchema.safeParse(payload);
      if (!parsed.success) throw new Error("Workbot settings for teams returned an unexpected response.");
      return parsed.data;
    },
  });
}

/** After a save: show the answer at once, then read it again. The viewer's own Workbot entry may have changed too. */
function settleSave(queryClient: QueryClient, orgId: string) {
  return {
    onSuccess: (saved: WorkbotTeamSettingsView | null) => {
      if (saved) queryClient.setQueryData(workbotTeamSettingsQueryKey(orgId), saved);
    },
    onSettled: () => Promise.all([
      queryClient.invalidateQueries({ queryKey: workbotTeamSettingsQueryKey(orgId), exact: true }),
      queryClient.invalidateQueries({ queryKey: workbotReadinessQueryKey(orgId), exact: true }),
    ]),
  };
}

export type SaveWorkbotTeamSettingsInput = { teamId: string; change: WorkbotTeamSettingsWrite };

/** Changes one team's Workbot settings; a setting left out of the change is kept. */
export function useSaveWorkbotTeamSettings(orgId: string) {
  const queryClient = useQueryClient();
  const { runReauthableAction } = useOrgDashboard();
  const settle = settleSave(queryClient, orgId);

  return useMutation({
    mutationKey: [...workbotTeamSettingsQueryKey(orgId), "save"],
    retry: false,
    mutationFn: async (input: SaveWorkbotTeamSettingsInput): Promise<WorkbotTeamSettingsView | null> => {
      const result: { saved: WorkbotTeamSettingsView | null } = { saved: null };
      await runReauthableAction("save-workbot-team-settings", async () => {
        const { response, payload } = await requestJson(
          `${teamSettingsPath}/${encodeURIComponent(input.teamId)}`,
          { method: "PUT", headers: { [ORG_SCOPE_HEADER]: orgId }, body: JSON.stringify(input.change) },
          20000,
        );
        if (!response.ok) throw getRequestError(payload, response, `Couldn't save this team's Workbot settings (${response.status}).`);
        const parsed = workbotTeamSettingsViewSchema.safeParse(payload);
        result.saved = parsed.success ? parsed.data : null;
      });
      return result.saved;
    },
    onSuccess: settle.onSuccess,
    onSettled: (_saved, _error, input) => Promise.all([
      settle.onSettled(),
      // Back to Everyone's policy for members' agents: read the team's policy and its tools again before the save settles.
      ...(input.change.agent ? [
        queryClient.invalidateQueries({ queryKey: agentPolicyQueryKey(orgId, { kind: "team", teamId: input.teamId }) }),
        queryClient.invalidateQueries({ queryKey: agentToolsRootQueryKey(orgId) }),
      ] : []),
    ]),
  });
}

/** Turns Workbot on or off for Everyone. Everyone's model is saved with Manage › Workbot's own hook. */
export function useSaveWorkbotEveryoneSettings(orgId: string) {
  const queryClient = useQueryClient();
  const { runReauthableAction } = useOrgDashboard();

  return useMutation({
    mutationKey: [...workbotTeamSettingsQueryKey(orgId), "save-everyone"],
    retry: false,
    mutationFn: async (change: WorkbotEveryoneSettingsWrite): Promise<WorkbotTeamSettingsView | null> => {
      const result: { saved: WorkbotTeamSettingsView | null } = { saved: null };
      await runReauthableAction("save-workbot-everyone-settings", async () => {
        const { response, payload } = await requestJson(
          everyoneSettingsPath,
          { method: "PUT", headers: { [ORG_SCOPE_HEADER]: orgId }, body: JSON.stringify(change) },
          20000,
        );
        if (!response.ok) throw getRequestError(payload, response, `Couldn't save Workbot's settings (${response.status}).`);
        const parsed = workbotTeamSettingsViewSchema.safeParse(payload);
        result.saved = parsed.success ? parsed.data : null;
      });
      return result.saved;
    },
    ...settleSave(queryClient, orgId),
  });
}
