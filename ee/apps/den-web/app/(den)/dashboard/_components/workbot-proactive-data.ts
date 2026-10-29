"use client";

import {
  mergeAgentSourcesPolicy,
  workbotProactiveHealthSchema,
  workbotProactiveViewSchema,
  type WorkbotProactiveHealth,
  type WorkbotProactiveSettingsInput,
  type WorkbotProactiveView,
} from "@openwork/types/den/workbot-proactive";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { getErrorMessage, getRequestError, requestJson } from "../../_lib/den-flow";
import { ORG_SCOPE_HEADER } from "../../_lib/org-scope";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

const proactivePath = "/v1/org/workbot-settings/proactive";

export function workbotProactiveQueryKey(orgId: string): string[] {
  return ["org-workbot-proactive", orgId];
}

/** Manage › Workbot › Your agent: how members' agents work, the template version, and where messages can go. */
export function useWorkbotProactive(orgId: string, enabled = true) {
  return useQuery({
    queryKey: workbotProactiveQueryKey(orgId),
    enabled,
    retry: false,
    queryFn: async ({ signal }): Promise<WorkbotProactiveView> => {
      const { response, payload } = await requestJson(
        proactivePath,
        { method: "GET", headers: { [ORG_SCOPE_HEADER]: orgId }, cache: "no-store", signal },
        15000,
      );
      if (!response.ok) throw new Error(getErrorMessage(payload, `Couldn't load agent settings (${response.status}).`));
      const parsed = workbotProactiveViewSchema.safeParse(payload);
      if (!parsed.success) throw new Error("Agent settings returned an unexpected response.");
      return parsed.data;
    },
  });
}

/** Saves one change at a time. The page shows it at once and puts it back if the save fails. */
export function useSaveWorkbotProactive(orgId: string) {
  const queryClient = useQueryClient();
  const { runReauthableAction } = useOrgDashboard();
  const key = workbotProactiveQueryKey(orgId);

  return useMutation({
    mutationKey: [...key, "save"],
    retry: false,
    mutationFn: async (change: WorkbotProactiveSettingsInput): Promise<WorkbotProactiveView | null> => {
      const result: { saved: WorkbotProactiveView | null } = { saved: null };
      await runReauthableAction("save-workbot-agent", async () => {
        const { response, payload } = await requestJson(
          proactivePath,
          { method: "PUT", headers: { [ORG_SCOPE_HEADER]: orgId }, body: JSON.stringify(change) },
          15000,
        );
        if (!response.ok) throw getRequestError(payload, response, `Couldn't save agent settings (${response.status}).`);
        const parsed = workbotProactiveViewSchema.safeParse(payload);
        result.saved = parsed.success ? parsed.data : null;
      });
      return result.saved;
    },
    onMutate: async (change) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<WorkbotProactiveView>(key);
      if (previous) {
        const { responsibilities, instructions, sources, ...policy } = change;
        queryClient.setQueryData<WorkbotProactiveView>(key, {
          ...previous,
          settings: { ...previous.settings, ...policy, sources: mergeAgentSourcesPolicy(previous.settings.sources, sources) },
          template: {
            ...previous.template,
            responsibilities: { ...previous.template.responsibilities, ...responsibilities },
            instructions: instructions ?? previous.template.instructions,
          },
        });
      }
      return { previous };
    },
    onError: (_error, _change, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
    },
    onSuccess: (saved) => {
      if (saved) queryClient.setQueryData(key, saved);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });
}

/** Manage › Workbot: seven days of agent health per responsibility (counts only). */
export function useWorkbotProactiveHealth(orgId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["org-workbot-proactive-health", orgId],
    enabled,
    retry: false,
    queryFn: async ({ signal }): Promise<WorkbotProactiveHealth> => {
      const { response, payload } = await requestJson(
        `${proactivePath}/health`,
        { method: "GET", headers: { [ORG_SCOPE_HEADER]: orgId }, cache: "no-store", signal },
        15000,
      );
      if (!response.ok) throw new Error(getErrorMessage(payload, `Couldn't load agent health (${response.status}).`));
      const parsed = workbotProactiveHealthSchema.safeParse(payload);
      if (!parsed.success) throw new Error("Agent health returned an unexpected response.");
      return parsed.data;
    },
  });
}

const sourceToolsSchema = z.object({
  tools: z.array(z.object({ name: z.string(), description: z.string().optional(), readOnlyHint: z.boolean().optional(), blocked: z.boolean() })),
});
export type WorkbotSourceTool = z.infer<typeof sourceToolsSchema>["tools"][number];

/** An MCP connection's tools, for choosing which ones members' agents may call. Only while the picker is open. */
export function useWorkbotSourceTools(orgId: string, connectionId: string | null) {
  return useQuery({
    queryKey: ["org-workbot-proactive-source-tools", orgId, connectionId],
    enabled: Boolean(orgId && connectionId),
    retry: false,
    queryFn: async ({ signal }): Promise<WorkbotSourceTool[]> => {
      const { response, payload } = await requestJson(
        `${proactivePath}/connections/${encodeURIComponent(connectionId ?? "")}/tools`,
        { method: "GET", headers: { [ORG_SCOPE_HEADER]: orgId }, cache: "no-store", signal },
        20000,
      );
      if (!response.ok) throw new Error(getErrorMessage(payload, `Couldn't load this connection's tools (${response.status}).`));
      const parsed = sourceToolsSchema.safeParse(payload);
      if (!parsed.success) throw new Error("The connection's tools came back in an unexpected shape.");
      return parsed.data.tools;
    },
  });
}
