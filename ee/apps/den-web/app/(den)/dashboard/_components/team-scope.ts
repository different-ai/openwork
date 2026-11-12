/*
 * Who a per-team control is for: Everyone (every member, including people in
 * no team) or one team. Shared by the tabs of Members › Teams › Everyone and
 * of each team's page, with the words they use for where a value comes from.
 */

export type TeamScope = { kind: "everyone" } | { kind: "team"; teamId: string; teamName: string };

export const EVERYONE_SCOPE: TeamScope = { kind: "everyone" };

/** The scope of a screen's `team` prop: null is Everyone's page. */
export function teamScopeOf(team: { id: string; name: string } | null): TeamScope {
  return team ? { kind: "team", teamId: team.id, teamName: team.name } : EVERYONE_SCOPE;
}

export function teamScopeName(scope: TeamScope): string {
  return scope.kind === "team" ? scope.teamName : "Everyone";
}

export type ScopeChipState = { label: string; tone: "neutral" | "info" };

/**
 * The chip beside a setting, on a team's page only: "From Everyone" while the team follows Everyone, "Changed for
 * {team}" once it has its own value. Everyone's values are the default every team starts from, so Everyone's page
 * has no chip: which teams differ is shown on each team's own page.
 */
export function scopeChipState(scope: TeamScope, input: { changed: boolean }): ScopeChipState | null {
  if (scope.kind !== "team") return null;
  return input.changed ? { label: `Changed for ${scope.teamName}`, tone: "info" } : { label: "From Everyone", tone: "neutral" };
}

/** Members on two teams that disagree get Everyone's value. `setting` names what differs ("model", "Workbot setting"). */
export function scopeConflictLine(count: number, setting: string): string {
  return count === 1
    ? `1 member is also on a team with a different ${setting}, so they get Everyone's.`
    : `${count} members are also on a team with a different ${setting}, so they get Everyone's.`;
}
