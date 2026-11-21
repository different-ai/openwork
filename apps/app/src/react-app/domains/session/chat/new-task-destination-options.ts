import type { NewSessionDestination } from "./new-session-destination";

type Named = { id: string; label: string };

export type DestinationOption = {
  value: string;
  kind: "workspace" | "group";
  workspaceId: string;
  groupId?: string;
  label: string;
  selected: boolean;
  disabled: boolean;
};

export const UNAVAILABLE_GROUP_LABEL = "Unavailable group";

export function destinationWorkspaces(destination: NewSessionDestination, workspaces: readonly Named[]): Named[] {
  return workspaces.filter((workspace) => !destination.parent || workspace.id === destination.parent.workspaceId);
}

export function destinationLabel(
  destination: NewSessionDestination,
  workspaces: readonly Named[],
  groupsByWorkspace: Readonly<Record<string, readonly Named[]>>,
): string {
  const workspace = workspaces.find((candidate) => candidate.id === destination.workspaceId)?.label ?? "Workspace";
  if (!destination.groupId) return workspace;
  const group = groupsByWorkspace[destination.workspaceId]?.find((candidate) => candidate.id === destination.groupId)?.label;
  return `${workspace} / ${group ?? UNAVAILABLE_GROUP_LABEL}`;
}

export function buildDestinationOptions(input: {
  destination: NewSessionDestination;
  workspaces: readonly Named[];
  groupsByWorkspace: Readonly<Record<string, readonly Named[]>>;
  query: string;
  workspaceChangeBlocked: boolean;
}): DestinationOption[] {
  const query = input.query.trim().toLowerCase();
  const matches = (label: string) => label.toLowerCase().includes(query);
  return destinationWorkspaces(input.destination, input.workspaces).flatMap((workspace) => {
    const groups = input.groupsByWorkspace[workspace.id] ?? [];
    const workspaceMatches = !query || matches(workspace.label);
    const shownGroups = workspaceMatches ? groups : groups.filter((group) => matches(group.label));
    if (!workspaceMatches && shownGroups.length === 0) return [];
    const current = workspace.id === input.destination.workspaceId;
    const disabled = input.workspaceChangeBlocked && !current;
    const rows: DestinationOption[] = [{
      value: JSON.stringify([workspace.id, null]),
      kind: "workspace",
      workspaceId: workspace.id,
      label: workspace.label,
      selected: current && !input.destination.groupId,
      disabled,
    }];
    for (const group of shownGroups) {
      rows.push({
        value: JSON.stringify([workspace.id, group.id]),
        kind: "group",
        workspaceId: workspace.id,
        groupId: group.id,
        label: group.label,
        selected: current && input.destination.groupId === group.id,
        disabled,
      });
    }
    return rows;
  });
}
