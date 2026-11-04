"use client";

import {
  agentConnectionToolsViewSchema,
  mergeAgentSourcesPolicy,
  type AgentConnectionToolsView,
  type AgentSourcesPolicyInput,
  workbotProactiveHealthSchema,
  workbotProactiveViewSchema,
  type WorkbotProactiveHealth,
  type WorkbotProactiveSettingsInput,
  type WorkbotProactiveView,
} from "@openwork/types/den/workbot-proactive";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getErrorMessage, getRequestError, requestJson } from "../../_lib/den-flow";
import { ORG_SCOPE_HEADER } from "../../_lib/org-scope";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

const proactivePath = "/v1/org/workbot-settings/proactive";

export function workbotProactiveQueryKey(orgId: string): string[] {
  return ["org-workbot-proactive", orgId];
}

export function agentConnectionToolsQueryKey(orgId: string, connectionId: string): string[] {
  return ["org-workbot-agent-tools", orgId, connectionId];
}

/** `workbotAgentBrief`: one connection's tools and whether members' agents may call each ("Tools agents may use"). */
export function useAgentConnectionTools(orgId: string, connectionId: string, enabled = true) {
  return useQuery({
    queryKey: agentConnectionToolsQueryKey(orgId, connectionId),
    enabled,
    retry: false,
    staleTime: 60_000,
    queryFn: async ({ signal }): Promise<AgentConnectionToolsView> => {
      const { response, payload } = await requestJson(
        `${proactivePath}/sources/${encodeURIComponent(connectionId)}/tools`,
        { method: "GET", headers: { [ORG_SCOPE_HEADER]: orgId }, cache: "no-store", signal },
        20000,
      );
      if (!response.ok) throw new Error(getErrorMessage(payload, `Couldn't load its tools (${response.status}).`));
      const parsed = agentConnectionToolsViewSchema.safeParse(payload);
      if (!parsed.success) throw new Error("Its tools came back in an unexpected shape.");
      return parsed.data;
    },
  });
}

/** A tool choice shown at once: the switch moves, the count follows; a locked tool never changes. */
export function withToolOverrides(view: AgentConnectionToolsView, overrides: NonNullable<AgentSourcesPolicyInput["toolOverrides"]>[string]): AgentConnectionToolsView {
  const tools = view.tools.map((tool) => {
    if (overrides === null) return tool.override ? { ...tool, override: null } : tool;
    const value = overrides[tool.name];
    if (value === undefined || tool.locked) return tool;
    if (value === null) return { ...tool, override: null };
    return { ...tool, override: value, allowed: value === "allow", reason: value === "allow" ? "admin_allowed" as const : "admin_denied" as const };
  });
  return { ...view, tools, readTools: tools.filter((tool) => tool.allowed).length };
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
      for (const [connectionId, overrides] of Object.entries(change.sources?.toolOverrides ?? {})) {
        const toolsKey = agentConnectionToolsQueryKey(orgId, connectionId);
        const tools = queryClient.getQueryData<AgentConnectionToolsView>(toolsKey);
        if (tools) queryClient.setQueryData(toolsKey, withToolOverrides(tools, overrides));
      }
      const previous = queryClient.getQueryData<WorkbotProactiveView>(key);
      if (previous) {
        const { responsibilities, instructions, sources, brief, ...policy } = change;
        queryClient.setQueryData<WorkbotProactiveView>(key, {
          ...previous,
          settings: { ...previous.settings, ...policy, sources: mergeAgentSourcesPolicy(previous.settings.sources, sources) },
          ...(previous.brief && brief ? { brief: { ...previous.brief, ...brief, carriedOver: previous.brief.carriedOver.filter((field) => brief[field] === undefined) } } : {}),
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
    onSettled: (_saved, _error, change) => {
      // Tool choices: the server says again what each tool is now (a choice back to automatic needs its decision).
      for (const connectionId of Object.keys(change.sources?.toolOverrides ?? {})) void queryClient.invalidateQueries({ queryKey: agentConnectionToolsQueryKey(orgId, connectionId) });
      return queryClient.invalidateQueries({ queryKey: key });
    },
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
