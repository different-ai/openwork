import type {
  EnvironmentVariableAssignmentOption,
  EnvironmentVariableValueMode,
  EnvironmentVariableValueSource,
} from "@openwork/types/den/environment-variables"

/**
 * Pure rules for organization environment variables, kept free of database
 * imports so they can be unit tested.
 */

export type EnvironmentVariableAccessEntry = {
  id: string
  orgMembershipId: string | null
  teamId: string | null
  value: string | null
}

export type AccessTarget = { type: "everyone" } | { type: "team"; teamId: string } | { type: "member"; orgMembershipId: string }

export function accessTarget(entry: Pick<EnvironmentVariableAccessEntry, "orgMembershipId" | "teamId">): AccessTarget {
  if (entry.orgMembershipId) return { type: "member", orgMembershipId: entry.orgMembershipId }
  if (entry.teamId) return { type: "team", teamId: entry.teamId }
  return { type: "everyone" }
}

/** A stable key for an assignment's target, to match writes against stored rows. */
export function accessTargetKey(target: AccessTarget): string {
  if (target.type === "member") return `member:${target.orgMembershipId}`
  if (target.type === "team") return `team:${target.teamId}`
  return "everyone"
}

type Member = { id: string; teams: ReadonlyArray<{ id: string; name: string }> }

/** The assignments that reach a member: everyone, one of their teams, or them directly. */
export function memberAssignments<T extends Pick<EnvironmentVariableAccessEntry, "orgMembershipId" | "teamId">>(
  access: readonly T[],
  member: Member,
): T[] {
  const teamIds = new Set(member.teams.map((team) => team.id))
  return access.filter((entry) =>
    (entry.orgMembershipId === null && entry.teamId === null)
    || entry.orgMembershipId === member.id
    || (entry.teamId !== null && teamIds.has(entry.teamId)))
}

export function memberReceivesEnvironmentVariable(
  access: ReadonlyArray<Pick<EnvironmentVariableAccessEntry, "orgMembershipId" | "teamId">>,
  member: Member,
): boolean {
  return memberAssignments(access, member).length > 0
}

export type ResolvedValue = {
  value: string | null
  source: EnvironmentVariableValueSource | null
  assignments: EnvironmentVariableAssignmentOption[]
  selectedAccessId: string | null
}

/**
 * One member's effective value.
 *
 * - admin: the value of an assignment that reaches the member. The member may
 *   choose one; otherwise the most specific wins: directly to them, then their
 *   teams by name, then everyone.
 * - per_member: only the member's own value, never an assignment's, so a
 *   personal secret is never guessed.
 */
export function resolveEnvironmentVariableValue(input: {
  valueMode: EnvironmentVariableValueMode
  access: readonly EnvironmentVariableAccessEntry[]
  member: Member
  organizationName: string
  ownValue: string | null
  selectedAccessId: string | null
}): ResolvedValue {
  if (input.valueMode === "per_member") {
    return { value: input.ownValue, source: input.ownValue ? "own" : null, assignments: [], selectedAccessId: null }
  }
  const teamNames = new Map(input.member.teams.map((team) => [team.id, team.name]))
  const options = memberAssignments(input.access, input.member)
    .filter((entry): entry is EnvironmentVariableAccessEntry & { value: string } => Boolean(entry.value))
    .map((entry) => {
      const target = accessTarget(entry)
      const kind = target.type === "member" ? "direct" as const : target.type
      const label = target.type === "member" ? "Directly to you"
        : target.type === "team" ? teamNames.get(target.teamId) ?? "Your team"
          : `Everyone in ${input.organizationName}`
      return { entry, option: { accessId: entry.id, kind, label } }
    })
  const rank = { direct: 0, team: 1, everyone: 2 }
  options.sort((a, b) => rank[a.option.kind] - rank[b.option.kind]
    || a.option.label.localeCompare(b.option.label) || a.option.accessId.localeCompare(b.option.accessId))
  const chosen = options.find((candidate) => candidate.option.accessId === input.selectedAccessId) ?? options[0]
  return {
    value: chosen?.entry.value ?? null,
    source: chosen?.option.kind ?? null,
    assignments: options.map((candidate) => candidate.option),
    selectedAccessId: chosen?.option.accessId ?? null,
  }
}

/**
 * How a write changes a stored value: undefined keeps it, null clears it, a
 * string replaces it. Empty strings clear too, so a blank field never stores "".
 */
export function nextStoredValue(current: string | null, change: string | null | undefined): string | null {
  if (change === undefined) return current
  return change ? change : null
}
