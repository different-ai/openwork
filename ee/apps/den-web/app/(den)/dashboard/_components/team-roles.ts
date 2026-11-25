import { PERMISSION_KEYS, isPermissionKey, type PermissionKey } from "@openwork/types/den/permissions";
import {
  BUILT_IN_ROLES,
  builtInRoleForSetKind,
  roleOptions,
  type RoleListEntry,
  type RoleOption,
  type RoleSetKind,
} from "../../_lib/role-catalog";

export const SUPER_ADMIN_ROLE_LOCK_REASON = "Only the owner or a super admin can make someone a super admin.";
export const SUPER_ADMIN_TEAM_LOCK_REASON = "Only the owner or a super admin can give a team Super admin or take it away.";

export type RoleSetLike = {
  kind: RoleSetKind;
  name: string;
  team: { id: string; name: string | null } | null;
};

export function roleName(set: Pick<RoleSetLike, "kind" | "name">): string {
  const builtIn = builtInRoleForSetKind(set.kind);
  return builtIn ? BUILT_IN_ROLES[builtIn].label : set.name;
}

export function roleKindLabel(set: Pick<RoleSetLike, "kind">): string {
  return set.kind === "team" ? "Custom role" : "Built-in role";
}

export type PermissionSourceLike = {
  kind: string;
  label: string;
  via?: string;
  teamName?: string;
  setName?: string;
  set?: string;
};

function setRoleName(setName: string): string {
  const builtIn = Object.values(BUILT_IN_ROLES).find((role) => setName === `${role.label} permissions`);
  return builtIn ? builtIn.label : setName;
}

export function permissionSourceRoleLabel(source: PermissionSourceLike): string {
  switch (source.kind) {
    case "owner":
      return BUILT_IN_ROLES.owner.label;
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
    case "direct":
      return source.setName ? setRoleName(source.setName) : source.label;
    case "code_default":
      if (source.set === "super-admin") return BUILT_IN_ROLES["super-admin"].label;
      return source.set === "admin" ? BUILT_IN_ROLES.admin.label : BUILT_IN_ROLES.member.label;
    default:
      return source.label;
  }
}

export function allowedKeys(permissions: readonly { key: string; status: "allow" | "deny" }[]): PermissionKey[] {
  const allowed = new Set(permissions.filter((entry) => entry.status === "allow").map((entry) => entry.key));
  return PERMISSION_KEYS.filter((key) => allowed.has(key) && isPermissionKey(key));
}

export type TeamRoleState = {
  admin: boolean;
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

export function teamRoleEntry(state: TeamRoleState, roles: readonly RoleListEntry[]): RoleListEntry {
  const linked = linkedRole(roles, state.setId);
  if (linked?.kind === "built_in" && linked.id === "super-admin") return linked;
  if (state.admin) return builtIn(roles, "admin");
  return linked ?? builtIn(roles, "member");
}

export type TeamRoleStep =
  | { kind: "set-admin"; value: boolean }
  | { kind: "assign"; setId: string | null };

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
  const admin = next.kind === "built_in" && next.id === "super-admin";
  if (admin && !current.admin) steps.push({ kind: "set-admin", value: true });
  if (current.setId !== next.setId) steps.push({ kind: "assign", setId: next.setId });
  if (!admin && current.admin) steps.push({ kind: "set-admin", value: false });
  return steps;
}

export type TeamRoleAbilities = {
  canManageAdminTeams: boolean;
  canManagePermissions: boolean;
  hasOwnerAuthority: boolean;
};

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

export function teamRoleOptions(input: {
  roles: readonly RoleListEntry[];
  state: TeamRoleState;
  abilities: TeamRoleAbilities;
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

export function teamRoleStateAfter(role: RoleListEntry): TeamRoleState {
  if (role.kind === "built_in" && (role.id === "member" || role.id === "admin")) return { admin: role.id === "admin", setId: null };
  return { admin: role.kind === "built_in" && role.id === "super-admin", setId: role.setId };
}

export function teamRoleLabel(state: TeamRoleState, roles: readonly RoleListEntry[]): string | null {
  const entry = teamRoleEntry(state, roles);
  return entry.kind === "built_in" && entry.id === "member" ? null : entry.label;
}

export function teamRoleLabels(input: {
  memberId: string;
  ownRole: "owner" | "admin" | "member";
  teams: readonly { id: string; name: string; memberIds: readonly string[]; grantsOrganizationAdmin: boolean }[];
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

export type MemberRoleState = {
  role: "owner" | "super-admin" | "admin" | "member";
  setId: string | null;
};

function isOrganizationRole(entry: RoleListEntry): entry is Extract<RoleListEntry, { kind: "built_in" }> & { id: "member" | "admin" | "super-admin" } {
  return entry.kind === "built_in" && (entry.id === "member" || entry.id === "admin" || entry.id === "super-admin");
}

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

export function memberRoleOptions(input: {
  roles: readonly RoleListEntry[];
  current?: RoleListEntry | null;
  changeLockReason?: string | null;
  lockReasons?: ReadonlyMap<string, string | null>;
  adminLockReason?: string | null;
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

export function memberRoleStateAfter(role: RoleListEntry): MemberRoleState {
  if (isOrganizationRole(role)) return { role: role.id, setId: null };
  return { role: "member", setId: role.setId };
}
