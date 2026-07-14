import type { ExternalMcpAccessSummary, ExternalMcpConnection, ExternalMcpRequiredBy } from "./mcp-connections-data";

export function effectiveMcpAccess(
  directAccess: ExternalMcpAccessSummary | null,
  inheritedAccess: ExternalMcpAccessSummary | null,
): ExternalMcpAccessSummary | null {
  if (!directAccess && !inheritedAccess) return null;
  const sources = [directAccess, inheritedAccess].filter((source): source is ExternalMcpAccessSummary => source !== null);
  return {
    orgWide: sources.some((source) => source.orgWide),
    memberIds: [...new Set(sources.flatMap((source) => source.memberIds))],
    teamIds: [...new Set(sources.flatMap((source) => source.teamIds))],
  };
}

function readableList(values: string[]): string {
  if (values.length <= 1) return values[0] ?? "";
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values[values.length - 1]}`;
}

export function formatInheritedMcpAccess(
  access: ExternalMcpAccessSummary | null,
  teams: Array<{ id: string; name: string }>,
  members: Array<{ id: string; name: string }>,
): string | null {
  if (!access) return null;
  if (access.orgWide) return "everyone in the organization";

  const teamNames = new Map(teams.map((team) => [team.id, team.name]));
  const memberNames = new Map(members.map((member) => [member.id, member.name]));
  const labels = access.teamIds.flatMap((teamId) => {
    const name = teamNames.get(teamId);
    return name ? [`${name} team`] : [];
  });
  labels.push(...access.memberIds.flatMap((memberId) => {
    const name = memberNames.get(memberId);
    return name ? [name] : [];
  }));

  const knownTeams = access.teamIds.filter((teamId) => teamNames.has(teamId)).length;
  const unknownTeams = access.teamIds.length - knownTeams;
  const knownMembers = access.memberIds.filter((memberId) => memberNames.has(memberId)).length;
  const unknownMembers = access.memberIds.length - knownMembers;
  if (unknownTeams > 0) labels.push(`${unknownTeams} other ${unknownTeams === 1 ? "team" : "teams"}`);
  if (unknownMembers > 0) labels.push(`${unknownMembers} other ${unknownMembers === 1 ? "person" : "people"}`);
  return labels.length > 0 ? readableList(labels) : null;
}

export function formatRequiredBy(requiredBy: ExternalMcpRequiredBy[]): string | null {
  const names = [...new Set(requiredBy.map((entry) => entry.name.trim()).filter(Boolean))];
  if (names.length === 0) return null;
  if (names.length === 1) return `Required by ${names[0]}`;
  if (names.length === 2) return `Required by ${names[0]} and ${names[1]}`;
  return `Required by ${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

export function trustedConnectionFocusId(connections: ExternalMcpConnection[], requestedConnectionId: string | null): string | null {
  if (!requestedConnectionId) return null;
  return connections.some((connection) => connection.id === requestedConnectionId) ? requestedConnectionId : null;
}

export function sortConnectionsForFocus(connections: ExternalMcpConnection[], focusConnectionId: string | null): ExternalMcpConnection[] {
  if (!focusConnectionId) return connections;
  return [...connections].sort((left, right) => {
    if (left.id === focusConnectionId) return -1;
    if (right.id === focusConnectionId) return 1;
    return 0;
  });
}
