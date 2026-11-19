import { PERMISSION_KEYS, isPermissionKey, type PermissionKey } from "@openwork/types/den/permissions";
import {
  BUILT_IN_ROLES,
  builtInRoleForSetKind,
  roleOptions,
  type RoleListEntry,
  type RoleOption,
  type RoleSetKind,
} from "../../_lib/role-catalog";

/**
 * Giving roles: how a choice from the organization's one role list
 * (`roleList` in _lib/role-catalog.ts) becomes calls.
 *
 * A person and a team each hold one role, picked from the same list. How it
 * is stored differs, and only this file knows:
 *
 *   person  Member, Admin, Super admin   the organization role (POST /v1/members/:id/role)
 *           Billing manager, custom      a role given directly (PUT /v1/members/:id/permission-set)
 *   team    Admin                        the Admin team switch (PATCH /v1/teams/:id)
 *           Super admin                  the Admin team switch and the Super admin set
 *           Billing manager, custom      the team's role (PUT /v1/teams/:id/permission-set)
 *
 * Every plan is ordered so nobody has less access part way than at either end.
 */

/** Role names and summaries come from the role catalog (_lib/role-catalog.ts), never from a screen. */
export const SUPER_ADMIN_ROLE_LOCK_REASON = "Only the owner or a super admin can make someone a super admin.";
export const SUPER_ADMIN_TEAM_LOCK_REASON = "Only the owner or a super admin can give a team Super admin or take it away.";

/**
 * One vocabulary for every screen: a role is Owner, Admin, Member, another
 * built-in role, or a custom role by its own name. Den's stored names
 * ("Member permissions", "Admin team") never reach the screen.
 */
export type RoleSetLike = {
  kind: RoleSetKind;
  name: string;
  team: { id: string; name: string | null } | null;
};

/** The role a permission set is: a built-in role's label, or the custom role's own name. */
export function roleName(set: Pick<RoleSetLike, "kind" | "name">): string {
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

/** Den's stored name of a built-in set ("Billing manager permissions") as the role it is. */
function setRoleName(setName: string): string {
  const builtIn = Object.values(BUILT_IN_ROLES).find((role) => setName === `${role.label} permissions`);
  return builtIn ? builtIn.label : setName;
}

export function permissionSourceRoleLabel(source: PermissionSourceLike): string {
  switch (source.kind) {
    case "owner":
      return BUILT_IN_ROLES.owner.label;
    // "super_admin" is what servers sent before Super admin became a permission set.
    case "super_admin":
    case "super_admin_default":
      return BUILT_IN_ROLES["super-admin"].label;
    case "member_default":
      return BUILT_IN_ROLES.member.label;
    case "admin_default":
      return source.via === "team" && source.teamName ? `Admin via ${source.teamName}` : BUILT_IN_ROLES.admin.label;
    case "team":
      if (source.setName) return source.teamName ? `${setRoleName(source.setName)} via ${source.teamName}` : setRoleName(source.setName);
      return source.teamName ?? source.label;
    // A role given to the person directly: a custom role or Billing manager.
    case "direct":
      return source.setName ? setRoleName(source.setName) : source.label;
    case "code_default":
      if (source.set === "super-admin") return BUILT_IN_ROLES["super-admin"].label;
      return source.set === "admin" ? BUILT_IN_ROLES.admin.label : BUILT_IN_ROLES.member.label;
    default:
      return source.label;
  }
}

/** Keys from a permission set detail that are currently allowed, in catalog order. */
export function allowedKeys(permissions: readonly { key: string; status: "allow" | "deny" }[]): PermissionKey[] {
  const allowed = new Set(permissions.filter((entry) => entry.status === "allow").map((entry) => entry.key));
  return PERMISSION_KEYS.filter((key) => allowed.has(key) && isPermissionKey(key));
}

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

export type TeamRoleState = {
  /** The team is an Admin team. */
  admin: boolean;
  /** The permission set the team holds (a custom role, Billing manager or Super admin), if any. */
  setId: string | null;
};

function linkedRole(roles: readonly RoleListEntry[], setId: string | null): RoleListEntry | null {
  if (!setId) return null;
  return roles.find((role) => role.setId === setId && (role.kind === "custom" || role.id === "billing-manager" || role.id === "super-admin")) ?? null;
}

function builtIn(roles: readonly RoleListEntry[], id: "member" | "admin"): RoleListEntry {
  const entry = roles.find((role) => role.kind === "built_in" && role.id === id);
  if (!entry) throw new Error(`The role list has no ${id} role.`);
  return entry;
}

/**
 * The one role a team shows. Super admin when it holds that set; otherwise
 * Admin when it is an Admin team (a custom role on top is listed as extras);
 * otherwise its custom role or Billing manager; otherwise Member.
 */
export function teamRoleEntry(state: TeamRoleState, roles: readonly RoleListEntry[]): RoleListEntry {
  const linked = linkedRole(roles, state.setId);
  if (linked?.kind === "built_in" && linked.id === "super-admin") return linked;
  if (state.admin) return builtIn(roles, "admin");
  return linked ?? builtIn(roles, "member");
}

export type TeamRoleStep =
  | { kind: "set-admin"; value: boolean }
  | { kind: "assign"; setId: string | null };

/**
 * The calls that move a team to `next`, ordered so the team never has less
 * access part way than at either end: the Admin switch goes on before a set
 * comes off, and a new set is given before the Admin switch goes off. Giving
 * a team another set is one call (the API replaces it). Empty for a role
 * teams can't have.
 */
export function teamRoleSteps(current: TeamRoleState, next: RoleListEntry): TeamRoleStep[] {
  const steps: TeamRoleStep[] = [];
  if (next.kind === "built_in" && next.id === "owner") return steps;
  if (next.kind === "built_in" && (next.id === "member" || next.id === "admin")) {
    const admin = next.id === "admin";
    if (admin && !current.admin) steps.push({ kind: "set-admin", value: true });
    if (current.setId) steps.push({ kind: "assign", setId: null });
    if (!admin && current.admin) steps.push({ kind: "set-admin", value: false });
    return steps;
  }
  if (!next.setId) return steps;
  // Super admin is an Admin team that also holds the Super admin set.
  const admin = next.kind === "built_in" && next.id === "super-admin";
  if (admin && !current.admin) steps.push({ kind: "set-admin", value: true });
  if (current.setId !== next.setId) steps.push({ kind: "assign", setId: next.setId });
  if (!admin && current.admin) steps.push({ kind: "set-admin", value: false });
  return steps;
}

export type TeamRoleAbilities = {
  /** teams.manage_admin: make a team an Admin team, or turn that off. */
  canManageAdminTeams: boolean;
  /** permissions.manage: give a team a role or take it away. */
  canManagePermissions: boolean;
  /** The owner or a super admin: the only people who give a team Super admin or take it away. */
  hasOwnerAuthority: boolean;
};

/** Why the person can't move the team to `next`, or null when they can. */
export function teamRoleLockReason(current: TeamRoleState, next: RoleListEntry, roles: readonly RoleListEntry[], abilities: TeamRoleAbilities): string | null {
  const now = teamRoleEntry(current, roles);
  const touchesSuperAdmin = [now, next].some((role) => role.kind === "built_in" && role.id === "super-admin");
  if (touchesSuperAdmin && now.value !== next.value && !abilities.hasOwnerAuthority) return SUPER_ADMIN_TEAM_LOCK_REASON;
  for (const step of teamRoleSteps(current, next)) {
    if (step.kind === "set-admin" && !abilities.canManageAdminTeams) return "Needs Manage Admin teams. Ask the owner.";
    if (step.kind === "assign" && !abilities.canManagePermissions) return "Needs Manage permissions. Ask the owner.";
  }
  return null;
}

/**
 * The roles a team can be given, from the organization's one role list, each
 * locked with what the change needs. The team's current role is never locked.
 */
export function teamRoleOptions(input: {
  roles: readonly RoleListEntry[];
  state: TeamRoleState;
  abilities: TeamRoleAbilities;
  /** Why the person can't give a role, by permission set id (it grants permissions they don't hold). */
  lockReasons?: ReadonlyMap<string, string | null>;
}): RoleOption[] {
  const current = teamRoleEntry(input.state, input.roles);
  return roleOptions({
    roles: input.roles,
    holder: "team",
    lockReason: (entry) => {
      if (entry.value === current.value) return null;
      return teamRoleLockReason(input.state, entry, input.roles, input.abilities) ?? (entry.setId ? input.lockReasons?.get(entry.setId) : null);
    },
  });
}

/** What a team holds once it has `role`, e.g. to plan the way back for Undo. */
export function teamRoleStateAfter(role: RoleListEntry): TeamRoleState {
  if (role.kind === "built_in" && (role.id === "member" || role.id === "admin")) return { admin: role.id === "admin", setId: null };
  return { admin: role.kind === "built_in" && role.id === "super-admin", setId: role.setId };
}

/** The role a team gives its members beyond Member, for lists: "Admin", "Billing manager", a custom role's name, or null. */
export function teamRoleLabel(state: TeamRoleState, roles: readonly RoleListEntry[]): string | null {
  const entry = teamRoleEntry(state, roles);
  return entry.kind === "built_in" && entry.id === "member" ? null : entry.label;
}

/**
 * The roles a person holds through their teams, in the order they read:
 * Admin first ("Admin via Sales, Engineering"), then every other role once
 * with its teams ("Billing manager via Finance").
 */
export function teamRoleLabels(input: {
  memberId: string;
  /** The person's own role: the owner already has everything, and an admin needs no "Admin via". */
  ownRole: "owner" | "admin" | "member";
  teams: readonly { id: string; name: string; memberIds: readonly string[]; grantsOrganizationAdmin: boolean }[];
  /** The permission set each team holds, by team id. */
  setIdByTeam: ReadonlyMap<string, string>;
  roles: readonly RoleListEntry[];
}): string[] {
  if (input.ownRole === "owner") return [];
  const byRole = new Map<string, { label: string; admin: boolean; teams: string[] }>();
  for (const team of input.teams) {
    if (!team.memberIds.includes(input.memberId)) continue;
    const entry = teamRoleEntry({ admin: team.grantsOrganizationAdmin, setId: input.setIdByTeam.get(team.id) ?? null }, input.roles);
    if (entry.kind === "built_in" && entry.id === "member") continue;
    const admin = entry.kind === "built_in" && entry.id === "admin";
    if (admin && input.ownRole === "admin") continue;
    const group = byRole.get(entry.value) ?? { label: entry.label, admin, teams: [] };
    group.teams.push(team.name);
    byRole.set(entry.value, group);
  }
  return [...byRole.values()]
    .sort((left, right) => Number(right.admin) - Number(left.admin))
    .map((group) => `${group.label} via ${group.teams.join(", ")}`);
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

export type MemberRoleState = {
  /** The person's own organization role, without what teams add. */
  role: "owner" | "super-admin" | "admin" | "member";
  /** The permission set given to the person directly (a custom role or Billing manager), if any. */
  setId: string | null;
};

function isOrganizationRole(entry: RoleListEntry): entry is Extract<RoleListEntry, { kind: "built_in" }> & { id: "member" | "admin" | "super-admin" } {
  return entry.kind === "built_in" && (entry.id === "member" || entry.id === "admin" || entry.id === "super-admin");
}

/**
 * The one role a person shows: Owner, Super admin or Admin from their
 * organization role; otherwise the role given to them directly; otherwise Member.
 */
export function memberRoleEntry(state: MemberRoleState, roles: readonly RoleListEntry[]): RoleListEntry {
  if (state.role !== "member") {
    const entry = roles.find((role) => role.kind === "built_in" && role.id === state.role);
    if (entry) return entry;
  }
  const linked = roles.find((role) => state.setId !== null && role.setId === state.setId && (role.kind === "custom" || role.id === "billing-manager"));
  return linked ?? builtIn(roles, "member");
}

export type MemberRoleStep =
  | { kind: "set-role"; role: "member" | "admin" | "super-admin" }
  | { kind: "assign"; setId: string | null };

/**
 * The calls that give a person `next`, ordered so they never have less access
 * part way than at either end: a higher organization role or a new set is
 * given before the old one is taken away. Empty for Owner, which moves only
 * by transferring ownership.
 */
export function memberRoleSteps(current: MemberRoleState, next: RoleListEntry): MemberRoleStep[] {
  const steps: MemberRoleStep[] = [];
  if (current.role === "owner") return steps;
  if (isOrganizationRole(next)) {
    if (current.role !== next.id) steps.push({ kind: "set-role", role: next.id });
    if (current.setId) steps.push({ kind: "assign", setId: null });
    return steps;
  }
  if (next.kind === "built_in" && next.id === "owner") return steps;
  if (!next.setId) return steps;
  if (current.setId !== next.setId) steps.push({ kind: "assign", setId: next.setId });
  if (current.role !== "member") steps.push({ kind: "set-role", role: "member" });
  return steps;
}

/**
 * The roles a person can be given, for Add member and for the role on their
 * row, from the organization's one role list. Each is locked with what the
 * change needs; the person's current role is never locked.
 */
export function memberRoleOptions(input: {
  roles: readonly RoleListEntry[];
  /** The person's current role; left out for a new invitation. */
  current?: RoleListEntry | null;
  /** Why the person can't change roles at all (members.update), or null. */
  changeLockReason?: string | null;
  /** Why the person can't give a role, by permission set id (it grants permissions they don't hold). */
  lockReasons?: ReadonlyMap<string, string | null>;
  /** Why the person can't make someone an admin: Admin has permissions they don't hold. */
  adminLockReason?: string | null;
  /** Why the person can't give the super-admin role: only the owner and super-admins can. */
  superAdminLockReason?: string | null;
}): RoleOption[] {
  return roleOptions({
    roles: input.roles,
    holder: "person",
    lockReason: (entry) => {
      if (input.current && entry.value === input.current.value) return null;
      if (input.changeLockReason) return input.changeLockReason;
      if (entry.kind === "built_in" && entry.id === "admin") return input.adminLockReason;
      if (entry.kind === "built_in" && entry.id === "super-admin") return input.superAdminLockReason ?? input.adminLockReason;
      return entry.setId ? input.lockReasons?.get(entry.setId) : null;
    },
  });
}

/** What a person holds once they have `role`, e.g. to plan the way back for Undo. */
export function memberRoleStateAfter(role: RoleListEntry): MemberRoleState {
  if (isOrganizationRole(role)) return { role: role.id, setId: null };
  return { role: "member", setId: role.setId };
}
