export type TeamScope = { kind: "everyone" } | { kind: "team"; teamId: string; teamName: string };

export const EVERYONE_SCOPE: TeamScope = { kind: "everyone" };

export function teamScopeOf(team: { id: string; name: string } | null): TeamScope {
  return team ? { kind: "team", teamId: team.id, teamName: team.name } : EVERYONE_SCOPE;
}

export function teamScopeName(scope: TeamScope): string {
  return scope.kind === "team" ? scope.teamName : "Everyone";
}

export type ScopeChipState = { label: string; tone: "neutral" | "info" };

export function scopeChipState(scope: TeamScope, input: { changed: boolean }): ScopeChipState | null {
  if (scope.kind !== "team") return null;
  return input.changed ? { label: `Changed for ${scope.teamName}`, tone: "info" } : { label: "From Everyone", tone: "neutral" };
}

export function scopeConflictLine(count: number, setting: string): string {
  return count === 1
    ? `1 member is also on a team with a different ${setting}, so they get Everyone's.`
    : `${count} members are also on a team with a different ${setting}, so they get Everyone's.`;
}
