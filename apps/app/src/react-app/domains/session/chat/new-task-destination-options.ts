import type { NewSessionDestination } from "./new-session-destination";

type Named = { id: string; label: string };

export type DestinationOption = {
  /** Stable Command value for keyboard highlight. */
  value: string;
  kind: "workspace" | "group";
  workspaceId: string;
  groupId?: string;
  label: string;
  selected: boolean;
  disabled: boolean;
};

export const UNAVAILABLE_GROUP_LABEL = "Unavailable group";

/** A side chat stays in its parent's workspace; every other draft may go anywhere. */
export function destinationWorkspaces(destination: NewSessionDestination, workspaces: readonly Named[]): Named[] {
  return workspaces.filter((workspace) => !destination.parent || workspace.id === destination.parent.workspaceId);
}

/** "openwork-lounge / coworker", or just the workspace when there is no group. */
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

/**
 * One list of workspaces with their groups under them; picking a workspace
 * row means no group. A query keeps a matching workspace with all its groups,
 * and otherwise only the matching groups under their workspace.
 */
export function buildDestinationOptions(input: {
  destination: NewSessionDestination;
  workspaces: readonly Named[];
  groupsByWorkspace: Readonly<Record<string, readonly Named[]>>;
  query: string;
  /** The draft holds workspace files, so only its own workspace stays open. */
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
