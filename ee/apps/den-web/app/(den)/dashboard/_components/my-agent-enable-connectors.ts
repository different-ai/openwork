import { AGENT_SOURCE_CHANGES_MAX, type AgentSourcePolicy, type MemberAgentSource } from "@openwork/types/den/workbot-proactive";

export function connectorBatches(sources: readonly MemberAgentSource[], on: boolean) {
  const changes = sources
    .filter((source) => source.policy === "members" && source.on !== on
      && (!on || (source.kind === "other" && source.readTools !== 0 && source.connections.some((connection) => connection.state === "connected"))))
    .map((source) => ({ source: source.id, on }));
  const batches = [];
  for (let start = 0; start < changes.length; start += AGENT_SOURCE_CHANGES_MAX) {
    batches.push({ sources: changes.slice(start, start + AGENT_SOURCE_CHANGES_MAX) });
  }
  return batches;
}

export function connectorPolicyChanges(choices: readonly { id: string; policy: AgentSourcePolicy }[], policy: "everyone" | "off") {
  return Object.fromEntries(choices.filter((option) => option.policy !== "off" && option.policy !== policy)
    .map((option) => [option.id, policy]));
}
