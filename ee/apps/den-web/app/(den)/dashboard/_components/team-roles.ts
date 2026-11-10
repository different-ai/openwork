import { PERMISSION_KEYS, isPermissionKey, type PermissionKey } from "@openwork/types/den/permissions";
import {
  BUILT_IN_ROLES,
  builtInRoleForSetKind,
  customRoleSetId,
  customRoleValue,
  roleOptions,
  type RoleListEntry,
  type RoleOption,
  type RoleSetKind,
} from "../../_lib/role-catalog";

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

/** Role names and summaries come from the role catalog (_lib/role-catalog.ts), never from a screen. */
export const TEAM_ROLE_LABELS: Record<TeamRole, string> = {
  member: BUILT_IN_ROLES.member.label,
  admin: BUILT_IN_ROLES.admin.label,
  custom: "Custom",
};

export const SUPER_ADMIN_ROLE_LOCK_REASON = "Only the owner or a super admin can make someone a super admin.";

export const TEAM_ROLE_DESCRIPTIONS: Record<TeamRole, string> = {
  member: BUILT_IN_ROLES.member.summary,
  admin: `${BUILT_IN_ROLES.admin.summary}, like every admin`,
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

export type TeamRoleStep =
  | { kind: "set-admin"; value: boolean }
  | { kind: "create-custom"; keys: PermissionKey[] }
  | { kind: "remove-custom"; setId: string };

/**
 * The calls that move a team from its current role to `next`, in an order
 * that never leaves the team with less access mid-way than at either end:
 * a new custom set is created before the Admin flag comes off, and the Admin
 * flag goes on before a custom set is removed.
 */
export function teamRoleSteps(current: TeamRoleState, next: TeamRole, adminKeys: readonly PermissionKey[]): TeamRoleStep[] {
  const steps: TeamRoleStep[] = [];
  if (next === "admin") {
    if (!current.admin) steps.push({ kind: "set-admin", value: true });
    if (current.customSetId) steps.push({ kind: "remove-custom", setId: current.customSetId });
    return steps;
  }
  if (next === "custom") {
    if (!current.customSetId) steps.push({ kind: "create-custom", keys: current.admin ? [...adminKeys] : [] });
    if (current.admin) steps.push({ kind: "set-admin", value: false });
    return steps;
  }
  if (current.admin) steps.push({ kind: "set-admin", value: false });
  if (current.customSetId) steps.push({ kind: "remove-custom", setId: current.customSetId });
  return steps;
}

/**
 * One vocabulary for every screen while teamRoles is on: a role is Owner,
 * Admin, Member, or a custom role named after its team. Den's stored names
 * ("Member permissions", "Engineering Permissions", "Admin team") never reach
 * the screen.
 */
export type RoleSetLike = {
  kind: RoleSetKind;
  name: string;
  team: { id: string; name: string | null } | null;
};

/**
 * The role a permission set is: Member, Admin, or a custom role. A custom
 * role is named after its team, or by its own name when roles are shared
 * between teams (sharedRoles).
 */
export function roleName(set: RoleSetLike): string {
  const builtIn = builtInRoleForSetKind(set.kind);
  return builtIn ? BUILT_IN_ROLES[builtIn].label : set.name;
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

export function permissionSourceRoleLabel(source: PermissionSourceLike): string {
  switch (source.kind) {
    case "owner":
      return BUILT_IN_ROLES.owner.label;
    // "super_admin" is what servers sent before Super admin became a permission set.
    case "super_admin":
    case "super_admin_default":
      return BUILT_IN_ROLES["super-admin"].label;
    case "member_default":
      return TEAM_ROLE_LABELS.member;
    case "admin_default":
      return source.via === "team" && source.teamName ? `Admin via ${source.teamName}` : TEAM_ROLE_LABELS.admin;
    case "team":
      if (source.setName) return source.teamName ? `${source.setName} via ${source.teamName}` : source.setName;
      return source.teamName ?? source.label;
    case "code_default":
      if (source.set === "super-admin") return BUILT_IN_ROLES["super-admin"].label;
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
  /** each custom role's own name by team, shown instead of the team's name. */
  customRoleNameByTeam?: ReadonlyMap<string, string>;
}): string[] {
  if (input.ownRole === "owner") return [];
  const mine = input.teams.filter((team) => team.memberIds.includes(input.memberId));
  const adminTeams = input.ownRole === "admin" ? [] : mine.filter((team) => team.grantsOrganizationAdmin).map((team) => team.name);
  const custom = mine
    .filter((team) => !team.grantsOrganizationAdmin && input.customTeamIds.has(team.id))
    .map((team) => input.customRoleNameByTeam?.get(team.id) ?? team.name);
  return [...(adminTeams.length > 0 ? [`Admin via ${adminTeams.join(", ")}`] : []), ...new Set(custom)];
}

/** Invite and role pickers: a built-in role, or a custom role by its team. */
export type RoleChoiceValue = "member" | "admin" | "super-admin" | `team:${string}` | `role:${string}`;

export function customRoleChoice(teamId: string): RoleChoiceValue {
  return `team:${teamId}`;
}

export function parseRoleChoice(value: string): { role: "member" | "admin" | "super-admin"; teamId: string | null } {
  if (value.startsWith("team:")) return { role: "member", teamId: value.slice("team:".length) || null };
  return { role: value === "super-admin" ? "super-admin" : value === "admin" ? "admin" : "member", teamId: null };
}

/** One row of the Invite and Edit role pickers. */
export type MemberRoleOption = RoleOption;

/**
 * The roles a person can be given directly, for both Invite and Edit role,
 * from the organization's one role list (`roleList`).
 *
 * Built-in roles first, then each custom role once by name, including roles
 * with no teams. The caller resolves a custom role's team before saving;
 * custom roles always keep the person's organization role Member.
 */
export function memberRoleOptions(input: {
  roles: readonly RoleListEntry[];
  canManageTeams: boolean;
  /** List roles a person can't be given (Owner) with a lock and the reason. */
  showUnavailable?: boolean;
  /** Why the person can't give a custom role, by permission set id. */
  lockReasons?: ReadonlyMap<string, string | null>;
  adminLockReason?: string | null;
  /** Why the person can't give the super-admin role: only the owner and super-admins can. */
  superAdminLockReason?: string | null;
}): MemberRoleOption[] {
  return roleOptions({
    roles: input.roles,
    holder: "person",
    showUnavailable: input.showUnavailable ?? false,
    lockReason: (entry) => {
      if (entry.kind === "custom") return !input.canManageTeams ? "Needs Manage teams. Ask the organization owner." : input.lockReasons?.get(entry.setId);
      if (entry.id === "admin") return input.adminLockReason;
      if (entry.id === "super-admin") return input.superAdminLockReason ?? input.adminLockReason;
      return null;
    },
  });
}

export type TeamRoleAbilities = {
  /** teams.manage_admin: make a team an Admin team, or turn that off. */
  canManageAdminTeams: boolean;
  /** permissions.manage: create, change and remove team permission sets. */
  canManagePermissions: boolean;
};

/** Why the person can't move the team to `next`, or null when they can. */
export function teamRoleLockReason(current: TeamRoleState, next: TeamRole, abilities: TeamRoleAbilities): string | null {
  const steps = teamRoleSteps(current, next, []);
  for (const step of steps) {
    if (step.kind === "set-admin" && !abilities.canManageAdminTeams) {
      return "Needs the “Manage Admin teams” permission. Ask the organization owner.";
    }
    if (step.kind !== "set-admin") {
      if (!abilities.canManagePermissions) return "Needs the “Manage permissions” permission. Ask the organization owner.";
    }
  }
  return null;
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

export type SharedTeamRoleStep =
  | { kind: "set-admin"; value: boolean }
  | { kind: "assign"; setId: string | null };

/** The role a team shows: Admin first, then its custom role, else Member. */
export function sharedTeamRole(state: SharedTeamRoleState): SharedTeamRole {
  if (state.admin) return { kind: "admin" };
  return state.setId ? { kind: "custom", setId: state.setId } : { kind: "member" };
}

export function sameSharedTeamRole(left: SharedTeamRole, right: SharedTeamRole): boolean {
  if (left.kind === "custom" && right.kind === "custom") return left.setId === right.setId;
  return left.kind === right.kind;
}

/**
 * The calls that move a team to `next`, ordered so the team never has less
 * access part way than at either end: the Admin flag goes on before the custom
 * role comes off, and a new custom role is given before the Admin flag goes off.
 * Giving a team another custom role is one call (the API replaces it).
 */
export function sharedTeamRoleSteps(current: SharedTeamRoleState, next: SharedTeamRole): SharedTeamRoleStep[] {
  const steps: SharedTeamRoleStep[] = [];
  if (next.kind === "admin") {
    if (!current.admin) steps.push({ kind: "set-admin", value: true });
    if (current.setId) steps.push({ kind: "assign", setId: null });
    return steps;
  }
  if (next.kind === "custom") {
    if (current.setId !== next.setId) steps.push({ kind: "assign", setId: next.setId });
    if (current.admin) steps.push({ kind: "set-admin", value: false });
    return steps;
  }
  if (current.admin) steps.push({ kind: "set-admin", value: false });
  if (current.setId) steps.push({ kind: "assign", setId: null });
  return steps;
}

/** Why the person can't move the team to `next` (sharedRoles), or null when they can. */
export function sharedTeamRoleLockReason(current: SharedTeamRoleState, next: SharedTeamRole, abilities: TeamRoleAbilities): string | null {
  for (const step of sharedTeamRoleSteps(current, next)) {
    if (step.kind === "set-admin" && !abilities.canManageAdminTeams) {
      return "Needs Manage Admin teams. Ask the owner.";
    }
    if (step.kind === "assign" && !abilities.canManagePermissions) {
      return "Needs Manage permissions. Ask the owner.";
    }
  }
  return null;
}

/** The picker value of a team's role: the built-in role's id, or the custom role's value. */
export function sharedTeamRoleValue(role: SharedTeamRole): string {
  return role.kind === "custom" ? customRoleValue(role.setId) : role.kind;
}

/** The team role a picker value names, or null for a role teams can't have. */
export function sharedTeamRoleFromValue(value: string): SharedTeamRole | null {
  const setId = customRoleSetId(value);
  if (setId) return { kind: "custom", setId };
  return value === "member" || value === "admin" ? { kind: value } : null;
}

/**
 * The roles a team can be given, from the organization's one role list
 * (`roleList`), each locked with the permission the change needs. The team's
 * current role is never locked.
 */
export function teamRoleOptions(input: {
  roles: readonly RoleListEntry[];
  state: SharedTeamRoleState;
  abilities: TeamRoleAbilities;
  /** List roles a team can't have (Super admin, Owner) with a lock and the reason. */
  showUnavailable?: boolean;
}): RoleOption[] {
  const current = sharedTeamRole(input.state);
  return roleOptions({
    roles: input.roles,
    holder: "team",
    showUnavailable: input.showUnavailable ?? false,
    lockReason: (entry) => {
      const role = sharedTeamRoleFromValue(entry.value);
      if (!role) return "Teams can't have this role.";
      return sameSharedTeamRole(role, current) ? null : sharedTeamRoleLockReason(input.state, role, input.abilities);
    },
  });
}
