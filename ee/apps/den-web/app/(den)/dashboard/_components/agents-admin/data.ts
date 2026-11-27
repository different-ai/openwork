import {
  personalAgentAdminItemSchema,
  personalAgentAdminListSchema,
  personalAgentEventListSchema,
  personalAgentOrgPolicySchema,
  setPersonalAgentAdminBudgetSchema,
  setPersonalAgentAudienceSchema,
  setPersonalAgentOrgPolicySchema,
  transferPersonalAgentSchema,
  type PersonalAgentAccess,
  type PersonalAgentToolPolicy,
  type SetPersonalAgentAudience,
  type SetPersonalAgentOrgPolicy,
} from "@openwork/types/den/personal-agents";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRequestError, requestJson } from "../../../_lib/den-flow";
import { ORG_SCOPE_HEADER } from "../../../_lib/org-scope";

const agentPath = "/v1/org/personal-agents";
const policyPath = "/v1/org/personal-agent-policy";
const agentKeys = (orgId: string) => ["personal-agents-admin", orgId] as const;

export class AgentNotSharedError extends Error {}

async function requestAgentData<T>(orgId: string, path: string, schema: { parse: (payload: unknown) => T }, init: { method?: string; body?: unknown } = {}) {
  const { response, payload } = await requestJson(path, {
    method: init.method,
    headers: { [ORG_SCOPE_HEADER]: orgId },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (response.status === 409 && payload && typeof payload === "object" && "error" in payload && payload.error === "personal_agent_not_shared") {
    throw new AgentNotSharedError();
  }
  if (!response.ok) throw getRequestError(payload, response, "Could not complete this request. Try again.");
  return schema.parse(payload);
}

export function useAdminAgents(orgId: string) {
  return useQuery({
    queryKey: [...agentKeys(orgId), "list"],
    queryFn: () => requestAgentData(orgId, agentPath, personalAgentAdminListSchema),
  });
}

export function useAdminAgentEvents(orgId: string) {
  return useQuery({
    queryKey: [...agentKeys(orgId), "events", 50],
    queryFn: () => requestAgentData(orgId, "/v1/org/personal-agent-events?limit=50", personalAgentEventListSchema),
  });
}

export type AgentEdit = { action: "pause" | "resume" | "archive" }
  | { action: "budget"; monthlyBudgetMicros: number | null }
  | { action: "transfer"; memberId: string }
  | { action: "audience"; audience: SetPersonalAgentAudience };

export function useEditAdminAgent(orgId: string, id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (edit: AgentEdit) => {
      const body = edit.action === "budget" ? setPersonalAgentAdminBudgetSchema.parse({ monthlyBudgetMicros: edit.monthlyBudgetMicros })
        : edit.action === "transfer" ? transferPersonalAgentSchema.parse({ memberId: edit.memberId })
        : edit.action === "audience" ? setPersonalAgentAudienceSchema.parse(edit.audience) : undefined;
      return requestAgentData(orgId, `${agentPath}/${encodeURIComponent(id)}/${edit.action}`, personalAgentAdminItemSchema, {
        method: edit.action === "budget" || edit.action === "audience" ? "PUT" : "POST", body,
      });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: agentKeys(orgId) }),
  });
}

type ToolRuleEdit = { action: "tools"; connectionId: string; toolNames: readonly string[]; rule: PersonalAgentAccess | null };
type ConnectionEdit = { action: "connection"; connectionId: string; blocked: boolean };
export type PolicyEdit = { action: "settings"; settings: Omit<SetPersonalAgentOrgPolicy, "toolPolicy"> } | ToolRuleEdit | ConnectionEdit;

export function editBlockedConnection(policy: PersonalAgentToolPolicy, edit: ConnectionEdit): PersonalAgentToolPolicy {
  const connections = new Map(Object.entries(policy.connections));
  if (edit.blocked) connections.set(edit.connectionId, "block");
  else connections.delete(edit.connectionId);
  return { ...policy, connections: Object.fromEntries(connections) };
}

function editToolRules(policy: PersonalAgentToolPolicy, edit: ToolRuleEdit): PersonalAgentToolPolicy {
  const tools = new Map(Object.entries(policy.tools));
  const entries = new Map(Object.entries(tools.get(edit.connectionId) ?? {}));
  for (const name of edit.toolNames) {
    if (edit.rule === null) entries.delete(name);
    else entries.set(name, edit.rule);
  }
  if (entries.size > 0) tools.set(edit.connectionId, Object.fromEntries(entries));
  else tools.delete(edit.connectionId);
  return { ...policy, tools: Object.fromEntries(tools) };
}

export function useEditAgentPolicy(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (edit: PolicyEdit) => {
      const current = async () => (await requestAgentData(orgId, policyPath, personalAgentOrgPolicySchema)).toolPolicy;
      const body = setPersonalAgentOrgPolicySchema.parse(edit.action === "settings" ? edit.settings
        : { toolPolicy: edit.action === "connection" ? editBlockedConnection(await current(), edit) : editToolRules(await current(), edit) });
      return requestAgentData(orgId, policyPath, personalAgentOrgPolicySchema, { method: "PUT", body });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: agentKeys(orgId) }),
  });
}
