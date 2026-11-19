export function panelSessionForWorkbench(input: {
  primarySessionId: string | null;
  primaryWorkspaceId: string;
  split: { workspaceId: string; sessionId: string; draftDestination?: unknown } | null;
  splitPanelOpen: boolean;
  focusedPane: "primary" | "secondary";
}): string | null {
  const { split } = input;
  if (!split || split.draftDestination) return input.primarySessionId;
  if (split.workspaceId !== input.primaryWorkspaceId) return input.primarySessionId;
  if (input.focusedPane !== "secondary" || !input.splitPanelOpen) return input.primarySessionId;
  return split.sessionId;
}

export function panelSessionForFileLink(input: {
  sourceSessionId: string | null;
  panelSessionId: string | null;
  primarySessionId: string | null;
  primaryWorkspaceId: string;
  split: { workspaceId: string; sessionId: string; draftDestination?: unknown } | null;
  splitTakesPanel: boolean;
}): string | null {
  const { sourceSessionId: source, split } = input;
  if (!source || source === input.panelSessionId) return input.panelSessionId;
  if (source === input.primarySessionId) return source;
  if (!split || split.sessionId !== source) return source;
  if (split.workspaceId !== input.primaryWorkspaceId) return source;
  const splitHasOwnPanel = input.splitTakesPanel && !split.draftDestination;
  return splitHasOwnPanel ? source : input.panelSessionId;
}
