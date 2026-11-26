import type {
  PersonalAgentAccess,
  PersonalAgentDetail,
  PersonalAgentRequest,
  PersonalAgentRequestDecision,
  PersonalAgentToolCatalog,
  PersonalAgentToolPolicy,
} from "@openwork/types/den/personal-agents";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { t } from "@/i18n";

import type { AgentScope, AgentsRuntime } from "./agents-runtime";
import { agentListKey, agentRequestsKey, agentsQueryRoot } from "./use-agents";

type ToolChoice = { connectionId: string; toolName: string; access: PersonalAgentAccess };
type ConnectionChoice = { connectionId: string; enabled: boolean };
type SettingsChange = { tool: ToolChoice } | { connection: ConnectionChoice } | { monthlyBudgetMicros: number | null };

export function nextAgentConnectionPolicy(policy: PersonalAgentToolPolicy, { connectionId, enabled }: ConnectionChoice): PersonalAgentToolPolicy {
  return {
    ...policy,
    connections: { ...policy.connections, [connectionId]: enabled ? "allow" : "block" },
  };
}

export function nextAgentToolPolicy(policy: PersonalAgentToolPolicy, { connectionId, toolName, access }: ToolChoice): PersonalAgentToolPolicy {
  return {
    ...policy,
    tools: {
      ...policy.tools,
      [connectionId]: { ...policy.tools[connectionId], [toolName]: access },
    },
  };
}

export function agentToolsKey(scope: AgentScope, agentId: string) {
  return [...agentsQueryRoot(scope), "tools", agentId] as const;
}

export function useAgentToolsQuery(runtime: AgentsRuntime, agentId: string, enabled = true) {
  const { client, organizationId } = runtime;
  return useQuery({
    queryKey: agentToolsKey(runtime, agentId),
    queryFn: () => client.getPersonalAgentTools(organizationId, agentId),
    enabled,
  });
}

export function useShareAgentLogin(runtime: AgentsRuntime, agentId: string) {
  const { client, organizationId } = runtime;
  const queryClient = useQueryClient();
  const key = agentToolsKey(runtime, agentId);
  return useMutation({
    mutationFn: ({ connectionId, shared }: { connectionId: string; shared: boolean }) => client.setPersonalAgentSharedLogin(organizationId, agentId, connectionId, shared),
    onSuccess: async (catalog) => {
      await queryClient.cancelQueries({ queryKey: key });
      queryClient.setQueryData(key, catalog);
    },
    onError: () => toast.error(t("agents.permissions_save_failed")),
  });
}

export function useSaveAgentSettings(runtime: AgentsRuntime, agent: PersonalAgentDetail) {
  const { client, organizationId } = runtime;
  const queryClient = useQueryClient();
  const agentId = agent.agent.id;
  const toolsKey = agentToolsKey(runtime, agentId);
  const listKey = agentListKey(runtime);
  return useMutation({
    mutationKey: [...toolsKey, "save"],
    mutationFn: (change: SettingsChange) => {
      if ("monthlyBudgetMicros" in change) return client.updatePersonalAgent(organizationId, agentId, change);
      const latestAgent = queryClient.getQueryData<PersonalAgentDetail[]>(listKey)?.find((item) => item.agent.id === agentId);
      const policy = (latestAgent ?? agent).revision.toolPolicy;
      return client.updatePersonalAgent(organizationId, agentId, {
        toolPolicy: "connection" in change
          ? nextAgentConnectionPolicy(policy, change.connection)
          : nextAgentToolPolicy(policy, change.tool),
      });
    },
    onMutate: async (change) => {
      if (!("tool" in change) || agent.role !== "owner") return;
      const { connectionId, toolName, access } = change.tool;
      await queryClient.cancelQueries({ queryKey: toolsKey });
      const previous = queryClient.getQueryData<PersonalAgentToolCatalog>(toolsKey);
      queryClient.setQueryData<PersonalAgentToolCatalog>(toolsKey, (catalog) => catalog && ({
        connections: catalog.connections.map((connection) => connection.connectionId !== connectionId ? connection : {
          ...connection,
          tools: connection.tools.map((tool) => tool.name === toolName ? { ...tool, access, chosen: access } : tool),
        }),
      }));
      return previous;
    },
    onSuccess: (updated, _change, previous) => {
      if ("request" in updated) {
        if (previous) queryClient.setQueryData(toolsKey, previous);
        return;
      }
      queryClient.setQueryData<PersonalAgentDetail[]>(listKey, (items) => items?.map((item) => item.agent.id === agentId ? updated : item));
    },
    onError: (_error, _change, previous) => {
      if (previous) queryClient.setQueryData(toolsKey, previous);
      toast.error(t("agents.permissions_save_failed"));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: agentsQueryRoot(runtime) }),
  });
}

type ToolDecision = Exclude<PersonalAgentRequestDecision, "approve">;

export function useDecideAgentToolRequest(runtime: AgentsRuntime, agentId: string, requestId: string, onDecision?: (request: PersonalAgentRequest, choice: ToolDecision) => void) {
  const { client, organizationId } = runtime;
  const queryClient = useQueryClient();
  const requestsKey = agentRequestsKey(runtime, agentId);
  return useMutation({
    mutationKey: [...requestsKey, "decide-tool", requestId],
    mutationFn: (decision: ToolDecision) => client.decidePersonalAgentRequest(organizationId, agentId, requestId, decision),
    onSuccess: async (updated, choice) => {
      await queryClient.cancelQueries({ queryKey: requestsKey });
      queryClient.setQueryData<PersonalAgentRequest[]>(requestsKey, (items) => items?.map((item) => item.id === updated.id ? updated : item));
      onDecision?.(updated, choice);
    },
    onError: () => toast.error(t("agents.permission_ask_save_failed")),
    onSettled: () => { void queryClient.invalidateQueries({ queryKey: agentsQueryRoot(runtime) }); },
  });
}
