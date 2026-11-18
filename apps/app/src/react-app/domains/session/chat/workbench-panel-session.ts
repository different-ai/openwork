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
