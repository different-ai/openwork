import {
  type AgentBriefPolicyInput,
  type AgentSourcesPolicy,
  type AgentSourcesPolicyInput,
  type WorkbotProactiveSettingsInput,
  type WorkbotProactiveView,
} from "@openwork/types/den/workbot-proactive";

export type AgentPolicyScope = { kind: "everyone" } | { kind: "team"; teamId: string };

export const EVERYONE_AGENT_POLICY_PATH = "/v1/org/workbot-settings/proactive";

export function agentPolicyPath(scope: AgentPolicyScope): string {
  return scope.kind === "team"
    ? `/v1/org/workbot-settings/teams/${encodeURIComponent(scope.teamId)}/agent`
    : EVERYONE_AGENT_POLICY_PATH;
}

export function agentToolsPath(scope: AgentPolicyScope, connectionId: string): string {
  return `${agentPolicyPath(scope)}/sources/${encodeURIComponent(connectionId)}/tools`;
}

export function agentPolicyQueryKey(orgId: string, scope: AgentPolicyScope): string[] {
  const everyone = ["org-workbot-proactive", orgId];
  return scope.kind === "team" ? [...everyone, "teams", scope.teamId] : everyone;
}

export function agentToolsRootQueryKey(orgId: string): string[] {
  return ["org-workbot-agent-tools", orgId];
}

export function agentToolsQueryKey(orgId: string, connectionId: string, scope: AgentPolicyScope): string[] {
  const everyone = [...agentToolsRootQueryKey(orgId), connectionId];
  return scope.kind === "team" ? [...everyone, "teams", scope.teamId] : everyone;
}

export const AGENT_HEALTH_ANCHOR = "agent-health";

export const AGENTS_SWITCH_LABEL = "Proactive Mode";

function sameIds(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  if (!left || !right) return left === right;
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function union(left: object | undefined, right: object | undefined): string[] {
  return [...new Set([...Object.keys(left ?? {}), ...Object.keys(right ?? {})])];
}

function restoreSources(team: AgentSourcesPolicy, everyone: AgentSourcesPolicy): AgentSourcesPolicyInput {
  const change: AgentSourcesPolicyInput = { calendar: team.calendar };
  if (!sameIds(team.otherConnections, everyone.otherConnections)) change.otherConnections = team.otherConnections ?? null;

  const connections: NonNullable<AgentSourcesPolicyInput["connections"]> = {};
  for (const id of union(team.connections, everyone.connections)) {
    const policy = team.connections[id];
    if (policy !== everyone.connections[id]) connections[id] = policy ?? null;
  }
  if (Object.keys(connections).length) change.connections = connections;

  const toolOverrides: NonNullable<AgentSourcesPolicyInput["toolOverrides"]> = {};
  for (const id of union(team.toolOverrides, everyone.toolOverrides)) {
    const mine = team.toolOverrides?.[id];
    const theirs = everyone.toolOverrides?.[id];
    if (!mine) {
      toolOverrides[id] = null;
      continue;
    }
    const tools: NonNullable<NonNullable<AgentSourcesPolicyInput["toolOverrides"]>[string]> = {};
    for (const name of union(mine, theirs)) {
      const choice = mine[name];
      if (choice !== theirs?.[name]) tools[name] = choice ?? null;
    }
    if (Object.keys(tools).length) toolOverrides[id] = tools;
  }
  if (Object.keys(toolOverrides).length) change.toolOverrides = toolOverrides;

  return change;
}

function restoreBrief(team: WorkbotProactiveView, everyone: WorkbotProactiveView): AgentBriefPolicyInput | null {
  if (!team.brief) return null;
  const mine = team.settings.brief ?? {};
  const theirs = everyone.settings.brief ?? {};
  const brief: AgentBriefPolicyInput = {};
  if (mine.checkEveryHours !== undefined || theirs.checkEveryHours !== undefined) brief.checkEveryHours = team.brief.checkEveryHours;
  if (mine.dailyCap !== undefined || theirs.dailyCap !== undefined) brief.dailyCap = team.brief.dailyCap;
  if (mine.extraChecksPerDay !== undefined || theirs.extraChecksPerDay !== undefined) brief.extraChecksPerDay = team.brief.extraChecksPerDay;
  if (mine.text !== undefined || theirs.text !== undefined) brief.text = team.brief.text;
  return Object.keys(brief).length ? brief : null;
}

export function agentPolicyRestoreChange(team: WorkbotProactiveView, everyone: WorkbotProactiveView): WorkbotProactiveSettingsInput {
  const { enabled, leadMinutes, workingDays, startHour, endHour, dailyCap, membersStart, destination, checkGate, checkGateThreshold, sendCheck, sendCheckThreshold } = team.settings;
  const brief = restoreBrief(team, everyone);
  return {
    enabled,
    leadMinutes,
    workingDays,
    startHour,
    endHour,
    dailyCap,
    membersStart,
    destination,
    ...(team.checkGate && checkGate !== undefined ? { checkGate } : {}),
    ...(team.checkGate && checkGateThreshold !== undefined ? { checkGateThreshold } : {}),
    ...(team.sendCheck && sendCheck !== undefined ? { sendCheck } : {}),
    ...(team.sendCheck && sendCheckThreshold !== undefined ? { sendCheckThreshold } : {}),
    sources: restoreSources(team.settings.sources, everyone.settings.sources),
    ...(brief ? { brief } : {}),
    responsibilities: { ...team.template.responsibilities },
    instructions: team.template.instructions,
  };
}
