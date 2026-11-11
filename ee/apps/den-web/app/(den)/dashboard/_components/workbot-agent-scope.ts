import {
  AGENT_CORE_SOURCES,
  type AgentBriefPolicyInput,
  type AgentSourcesPolicy,
  type AgentSourcesPolicyInput,
  type WorkbotProactiveSettingsInput,
  type WorkbotProactiveView,
} from "@openwork/types/den/workbot-proactive";

/*
 * Whose policy for members' agents a control reads and saves: Everyone's
 * (Manage › Workbot, and Members › Teams › Everyone › Workbot) or one team's
 * own (the team's Workbot tab). Paths, query keys and words; no requests.
 */

/** Everyone's policy, or one team's. Any `TeamScope` fits. */
export type AgentPolicyScope = { kind: "everyone" } | { kind: "team"; teamId: string };

export const EVERYONE_AGENT_POLICY_PATH = "/v1/org/workbot-settings/proactive";

/** Where a scope's policy is read (`GET`) and saved (`PUT`). */
export function agentPolicyPath(scope: AgentPolicyScope): string {
  return scope.kind === "team"
    ? `/v1/org/workbot-settings/teams/${encodeURIComponent(scope.teamId)}/agent`
    : EVERYONE_AGENT_POLICY_PATH;
}

/** Where one connection's tools are listed under a scope's policy. */
export function agentToolsPath(scope: AgentPolicyScope, connectionId: string): string {
  return `${agentPolicyPath(scope)}/sources/${encodeURIComponent(connectionId)}/tools`;
}

/** A team's key sits under Everyone's, so a change to Everyone's policy refreshes the teams that follow it. */
export function agentPolicyQueryKey(orgId: string, scope: AgentPolicyScope): string[] {
  const everyone = ["org-workbot-proactive", orgId];
  return scope.kind === "team" ? [...everyone, "teams", scope.teamId] : everyone;
}

/** Every connection's tools, under any scope's policy. */
export function agentToolsRootQueryKey(orgId: string): string[] {
  return ["org-workbot-agent-tools", orgId];
}

/** A team's key sits under Everyone's for the same connection, for the same reason as the policy's. */
export function agentToolsQueryKey(orgId: string, connectionId: string, scope: AgentPolicyScope): string[] {
  const everyone = [...agentToolsRootQueryKey(orgId), connectionId];
  return scope.kind === "team" ? [...everyone, "teams", scope.teamId] : everyone;
}

/** The "Last 7 days" table on Manage › Workbot, which counts every member's agent whatever their team. */
export const AGENT_HEALTH_ANCHOR = "agent-health";

/** The label of the switch that turns members' agents on. */
export function agentsSwitchLabel(scope: AgentPolicyScope): string {
  return scope.kind === "team" ? "Agents for this team" : "Agents for everyone";
}

function sameIds(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  if (!left || !right) return left === right;
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function union(left: object | undefined, right: object | undefined): string[] {
  return [...new Set([...Object.keys(left ?? {}), ...Object.keys(right ?? {})])];
}

/** What to send so that Everyone's sources become the team's again: only what differs, null where the team had nothing. */
function restoreSources(team: AgentSourcesPolicy, everyone: AgentSourcesPolicy): AgentSourcesPolicyInput {
  const change: AgentSourcesPolicyInput = { calendar: team.calendar, email: team.email, chat: team.chat };

  const coreConnections: NonNullable<AgentSourcesPolicyInput["coreConnections"]> = {};
  const coreDefaults: NonNullable<AgentSourcesPolicyInput["coreDefaults"]> = {};
  for (const kind of AGENT_CORE_SOURCES) {
    const allowed = team.coreConnections?.[kind];
    if (!sameIds(allowed, everyone.coreConnections?.[kind])) coreConnections[kind] = allowed ?? null;
    const chosen = team.coreDefaults?.[kind];
    if (chosen !== everyone.coreDefaults?.[kind]) coreDefaults[kind] = chosen ?? null;
  }
  if (Object.keys(coreConnections).length) change.coreConnections = coreConnections;
  if (Object.keys(coreDefaults).length) change.coreDefaults = coreDefaults;
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

/** The brief's fields either policy saved, as the team had them. Nothing while the brief is off: the server refuses it. */
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

/**
 * Undo for "Use Everyone's": the change that gives a team its own policy back.
 * A team's first save starts from Everyone's policy, so this is the team's
 * policy (`team`, as it was shown before it was removed) written as a change
 * to Everyone's (`everyone`, as it is now). The template's version count
 * starts again; nothing else is lost.
 */
export function agentPolicyRestoreChange(team: WorkbotProactiveView, everyone: WorkbotProactiveView): WorkbotProactiveSettingsInput {
  const { enabled, leadMinutes, workingDays, startHour, endHour, dailyCap, membersStart, destination, checkGate } = team.settings;
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
    // Only while the server offers the check gate; otherwise it refuses the field.
    ...(team.checkGate && checkGate !== undefined ? { checkGate } : {}),
    sources: restoreSources(team.settings.sources, everyone.settings.sources),
    ...(brief ? { brief } : {}),
    responsibilities: { ...team.template.responsibilities },
    instructions: team.template.instructions,
  };
}
