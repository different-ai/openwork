import { PERMISSION_KEYS, isPermissionKey, permissionDefaultKeys, type PermissionKey } from "@openwork/types/den/permissions";

/**
 * Team roles: the one-role-per-team view of what already exists in Den.
 *
 *   Member  the team adds nothing (no Admin flag, no team permission set)
 *   Admin   the team is an Admin team (team.grantsOrganizationAdmin)
 *   Custom  the team's one permission set (POST /v1/permissions/sets)
 *
 * Nothing here is stored as a "role"; changing one is the same team and
 * permission set calls the older screens make.
 */
export type TeamRole = "member" | "admin" | "custom";

export type TeamRoleState = {
  /** The team is an Admin team. */
  admin: boolean;
  /** The team's active permission set, if any. */
  customSetId: string | null;
};

/** The role a team shows. An Admin team that also has a set shows as Admin, with the set's extras listed. */
export function teamRole(state: TeamRoleState): TeamRole {
  if (state.admin) return "admin";
  return state.customSetId ? "custom" : "member";
}

export const TEAM_ROLE_LABELS: Record<TeamRole, string> = {
  member: "Member",
  admin: "Admin",
  custom: "Custom",
};

/** What the built-in Admin role is for, in one line. */
export const ADMIN_ROLE_SUMMARY = "Invite people, manage teams, and run connections and models";

export const TEAM_ROLE_DESCRIPTIONS: Record<TeamRole, string> = {
  member: "Nothing beyond what everyone can do",
  admin: `${ADMIN_ROLE_SUMMARY}, like every admin`,
  custom: "Choose exactly what people in this team can do",
};

/**
 * What every member can do whatever their role. These are not permissions
 * (nothing turns them off); they describe how Den already behaves: grants on
 * plugins, skills and connections, creator access to what people make, and
 * provider access assignments.
 */
export const EVERYONE_CAN: readonly string[] = [
  "Use skills, plugins and connections shared with them",
  "Make their own skills and plugins",
  "Share what they made with people and teams",
  "Use the models and providers given to them",
];

export type RoleStart = "member" | "admin" | "everything";

export const ROLE_START_LABELS: Record<RoleStart, string> = {
  member: "Member",
  admin: "Admin",
  everything: "Everything the owner can do",
};

export const ROLE_START_DESCRIPTIONS: Record<RoleStart, string> = {
  member: TEAM_ROLE_DESCRIPTIONS.member,
  admin: ADMIN_ROLE_SUMMARY,
  everything: "Every permission you can give",
};

/** The permissions a new role starts with, limited to what the person creating it holds. */
export function roleStartKeys(start: RoleStart, held: ReadonlySet<string>): PermissionKey[] {
  const keys = start === "everything" ? [...PERMISSION_KEYS] : permissionDefaultKeys(start);
  return keys.filter((key) => held.has(key));
}

/**
 * One vocabulary for every screen while teamRoles is on: a role is Owner,
 * Admin, Member, or a custom role named after its team. Den's stored names
 * ("Member permissions", "Engineering Permissions", "Admin team") never reach
 * the screen.
 */
export type RoleSetLike = {
  kind: "member_default" | "admin_default" | "team";
  name: string;
  team: { id: string; name: string | null } | null;
};

/**
 * The role a permission set is: Member, Admin, or a custom role. A custom
 * role is named after its team, or by its own name when roles are shared
 * between teams (sharedRoles).
 */
export function roleName(set: RoleSetLike, options: { shared?: boolean } = {}): string {
  if (set.kind === "member_default") return TEAM_ROLE_LABELS.member;
  if (set.kind === "admin_default") return TEAM_ROLE_LABELS.admin;
  if (options.shared) return set.name;
  return set.team?.name ?? set.name;
}

/** "Built-in role" or "Custom role", for captions next to a role's name. */
export function roleKindLabel(set: Pick<RoleSetLike, "kind">): string {
  return set.kind === "team" ? "Custom role" : "Built-in role";
}

/** Where a person's permission comes from, in role words. */
export type PermissionSourceLike = {
  kind: string;
  label: string;
  via?: string;
  teamName?: string;
  setName?: string;
  set?: string;
};

export function permissionSourceRoleLabel(source: PermissionSourceLike, options: { shared?: boolean } = {}): string {
  switch (source.kind) {
    case "owner":
      return "Owner";
    case "member_default":
      return TEAM_ROLE_LABELS.member;
    case "admin_default":
      return source.via === "team" && source.teamName ? `Admin via ${source.teamName}` : TEAM_ROLE_LABELS.admin;
    case "team":
      if (options.shared && source.setName) return source.teamName ? `${source.setName} via ${source.teamName}` : source.setName;
      return source.teamName ?? source.label;
    case "code_default":
      return source.set === "admin" ? TEAM_ROLE_LABELS.admin : TEAM_ROLE_LABELS.member;
    default:
      return source.label;
  }
}

/**
 * The roles a person holds through their teams, in the order they read:
 * Admin first ("Admin via Sales"), then each custom role by its team's name.
 */
export function teamRoleLabels(input: {
  memberId: string;
  /** The person's own role: the owner already has everything, and an admin needs no "Admin via". */
  ownRole: "owner" | "admin" | "member";
  teams: readonly { id: string; name: string; memberIds: readonly string[]; grantsOrganizationAdmin: boolean }[];
  customTeamIds: ReadonlySet<string>;
  /** sharedRoles: each custom role's own name by team, shown instead of the team's name. */
  customRoleNameByTeam?: ReadonlyMap<string, string>;
}): string[] {
  if (input.ownRole === "owner") return [];
  const mine = input.teams.filter((team) => team.memberIds.includes(input.memberId));
  const adminTeams = input.ownRole === "admin" ? [] : mine.filter((team) => team.grantsOrganizationAdmin).map((team) => team.name);
  const custom = mine
    .filter((team) => input.customTeamIds.has(team.id))
    .map((team) => input.customRoleNameByTeam?.get(team.id) ?? team.name);
  return [...(adminTeams.length > 0 ? [`Admin via ${adminTeams.join(", ")}`] : []), ...new Set(custom)];
}

/** Invite and role pickers: a built-in role, or a custom role by its team. */
export type RoleChoiceValue = "member" | "admin" | `team:${string}` | `role:${string}`;

export function customRoleChoice(teamId: string): RoleChoiceValue {
  return `team:${teamId}`;
}

export function parseRoleChoice(value: string): { role: "member" | "admin"; teamId: string | null } {
  if (value.startsWith("team:")) return { role: "member", teamId: value.slice("team:".length) || null };
  return { role: value === "admin" ? "admin" : "member", teamId: null };
}

export type MemberRoleOption = {
  value: RoleChoiceValue;
  label: string;
  /** "Custom role" next to a custom role's name, null for built-in roles. */
  caption: string | null;
  disabled: boolean;
  lockReason?: string | null;
};

/**
 * The roles a person can be given directly, for both Invite and Edit role.
 *
 * Member and Admin always. With teamRoles each custom role is listed by its
 * team. With sharedRoles it is listed once by permission-set name, including
 * roles with no teams. The caller resolves its team choice before saving;
 * custom roles always keep the person's organization role Member.
 */
export function memberRoleOptions(input: {
  sharedRoles: boolean;
  customRoleTeams: readonly { id: string; name: string; managedByScim?: boolean }[];
  canManageTeams: boolean;
  customRoles?: readonly { id: string; name: string; teams: readonly { id: string; name: string | null }[] }[];
  lockReasons?: ReadonlyMap<string, string | null>;
  adminLockReason?: string | null;
}): MemberRoleOption[] {
  const builtIn: MemberRoleOption[] = [
    { value: "member", label: TEAM_ROLE_LABELS.member, caption: null, disabled: false },
    { value: "admin", label: TEAM_ROLE_LABELS.admin, caption: null, disabled: Boolean(input.adminLockReason), lockReason: input.adminLockReason },
  ];
  if (input.sharedRoles) return [...builtIn, ...(input.customRoles ?? []).map((role): MemberRoleOption => {
    const lockReason = !input.canManageTeams ? "Needs Manage teams. Ask the organization owner." : input.lockReasons?.get(role.id) ?? null;
    return { value: `role:${role.id}`, label: role.name, caption: role.teams.length ? `On ${role.teams.map((team) => team.name ?? "A deleted team").join(", ")}` : "No teams yet", disabled: lockReason !== null, lockReason };
  })];
  return [
    ...builtIn,
    ...input.customRoleTeams.map((team): MemberRoleOption => ({
      value: customRoleChoice(team.id),
      label: team.name,
      caption: "Custom role",
      disabled: !input.canManageTeams || team.managedByScim === true,
    })),
  ];
}

/** Resolve domain associations before combining permission and team projections. */
export function permissionSetTeams(set: { teams: readonly { id: string; name: string | null }[]; team: { id: string; name: string | null } | null }) {
  return set.teams.length > 0 ? set.teams : set.team ? [set.team] : [];
}

/** Keys from a permission set detail that are currently allowed, in catalog order. */
export function allowedKeys(permissions: readonly { key: string; status: "allow" | "deny" }[]): PermissionKey[] {
  const allowed = new Set(permissions.filter((entry) => entry.status === "allow").map((entry) => entry.key));
  return PERMISSION_KEYS.filter((key) => allowed.has(key) && isPermissionKey(key));
}

/**
 * sharedRoles: a team's role is Member, Admin, or one of the organization's
 * custom roles (permission sets) by id.
 */
export type SharedTeamRole = { kind: "member" } | { kind: "admin" } | { kind: "custom"; setId: string };

export type SharedTeamRoleState = {
  admin: boolean;
  /** The custom role the team has now, if any. */
  setId: string | null;
};

/** The role a team shows: Admin first, then its custom role, else Member. */
export function sharedTeamRole(state: SharedTeamRoleState): SharedTeamRole {
  if (state.admin) return { kind: "admin" };
  return state.setId ? { kind: "custom", setId: state.setId } : { kind: "member" };
}

export function sameSharedTeamRole(left: SharedTeamRole, right: SharedTeamRole): boolean {
  if (left.kind === "custom" && right.kind === "custom") return left.setId === right.setId;
  return left.kind === right.kind;
}

