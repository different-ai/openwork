import {
  AGENT_RECENT_CHANGES_MAX,
  memberConnectorTogglesSchema,
  type MemberAgentInput,
  type MemberAgentView,
  type MemberConnectorSaved,
} from "@openwork/types/den/workbot-proactive";

export function connectorSwitches(change: MemberAgentInput, view?: MemberAgentView) {
  const parsed = memberConnectorTogglesSchema.safeParse(change);
  if (!parsed.success) return null;
  const connectors = new Set(view?.sources?.filter((source) => source.kind === "other").map((source) => source.id));
  return parsed.data.sources.every((entry) => connectors.has(entry.source)) ? parsed.data : null;
}

export function mergeSavedConnectorSwitches(view: MemberAgentView, saved: MemberConnectorSaved): MemberAgentView {
  const switches = new Map(saved.sources.map((source) => [source.id, source]));
  const added = new Set(saved.changes.map((entry) => entry.id));
  return {
    ...view,
    sources: view.sources?.map((source) => {
      const confirmed = switches.get(source.id);
      return confirmed ? { ...source, ...confirmed } : source;
    }),
    changes: [...saved.changes, ...(view.changes ?? []).filter((entry) => !added.has(entry.id))].slice(0, AGENT_RECENT_CHANGES_MAX),
  };
}
