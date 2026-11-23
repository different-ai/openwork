import { AGENT_SOURCE_CHANGES_MAX, type MemberAgentSource } from "@openwork/types/den/workbot-proactive";

export function enableConnectorBatches(sources: readonly MemberAgentSource[]) {
  const changes = sources
    .filter((source) => source.kind === "other" && source.policy === "members" && !source.on && source.readTools !== 0
      && source.connections.some((connection) => connection.state === "connected"))
    .map((source) => ({ source: source.id, on: true }));
  const batches = [];
  for (let start = 0; start < changes.length; start += AGENT_SOURCE_CHANGES_MAX) {
    batches.push({ sources: changes.slice(start, start + AGENT_SOURCE_CHANGES_MAX) });
  }
  return batches;
}
