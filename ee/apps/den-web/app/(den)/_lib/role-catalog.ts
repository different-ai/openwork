import {
  PERMISSION_KEYS,
  getPermissionDefinition,
  permissionDefaultKeys,
  type PermissionDefaultSetKey,
  type PermissionKey,
} from "@openwork/types/den/permissions";

/**
 * The one catalog of roles in Den web.
 *
 * Every screen that names, lists or offers a role reads it from here: the
 * Roles tab, the role pickers for people and for teams, Create role's
 * starting points, and the labels on people, teams and permission sets. To
 * add a built-in role, add it here; `roleList` and `roleOptions` then carry it
 * to every screen in the same order with the same words, and the compiler
 * asks for anything a screen has to decide about it.
 *
 * A role is one thing, given the same way to a person or to a team:
 *
 *   built-in  Member, Admin, Billing manager, Super admin, Owner. Every
 *             organization has them; they keep their names.
 *   custom    a named permission set the organization made.
 *
 * How a role is stored differs (an organization role, the Admin team switch,
 * or a link to its permission set), and `team-roles.ts` turns a choice into
 * those calls. No screen needs to know which.
 */

/** Kinds of permission set the API returns (ee/apps/den-api/src/routes/org/permissions.ts). */
export type RoleSetKind = "member_default" | "admin_default" | "billing_manager_default" | "super_admin_default" | "team";

/** Who a role picker is choosing for. */
export type RoleHolder = "person" | "team";

/** Built-in roles, in the order every screen lists them. */
export const BUILT_IN_ROLE_IDS = ["member", "admin", "billing-manager", "super-admin", "owner"] as const;

export type BuiltInRoleId = (typeof BUILT_IN_ROLE_IDS)[number];

export type BuiltInRole = {
  label: string;
  /** What the role is for, in one line. The same line on every screen. */
  summary: string;
  /** The permission set that holds the role's permissions. Null for Owner, who holds every permission without a set. */
  setKind: Exclude<RoleSetKind, "team"> | null;
  /** The default set key behind `setKind`, for catalog defaults. */
  defaultSet: PermissionDefaultSetKey | null;
  /** Why the role can never be picked for a person or for a team. Absent when it can. */
  notGivenTo: Partial<Record<RoleHolder, string>>;
};

export const BUILT_IN_ROLES: Record<BuiltInRoleId, BuiltInRole> = {
  member: {
    label: "Member",
    summary: "What everyone can do",
    setKind: "member_default",
    defaultSet: "member",
    notGivenTo: {},
  },
  admin: {
    label: "Admin",
    summary: "Invite people, manage teams, and run connections and models",
    setKind: "admin_default",
    defaultSet: "admin",
    notGivenTo: {},
  },
  "billing-manager": {
    label: "Billing manager",
    summary: "See plan, usage and invoices, and manage payment details",
    setKind: "billing_manager_default",
    defaultSet: "billing-manager",
    notGivenTo: {},
  },
  "super-admin": {
    label: "Super admin",
    summary: "Everything the owner can do, except delete the organization",
    setKind: "super_admin_default",
    defaultSet: "super-admin",
    notGivenTo: {},
  },
  owner: {
    label: "Owner",
    summary: "Can do everything",
    setKind: null,
    defaultSet: null,
    notGivenTo: {
      person: "Changes by transferring ownership.",
      team: "Held by one person, not a team.",
    },
  },
};

/**
 * Why a team can't be given Super admin in an organization whose Super admin
 * permissions aren't a set yet: there is nothing to give the team.
 */
export const SUPER_ADMIN_TEAM_UNAVAILABLE_REASON = "Given to people, not teams.";

/** The built-in role a permission set is, or null for a custom role's set. */
export function builtInRoleForSetKind(kind: RoleSetKind): BuiltInRoleId | null {
  return BUILT_IN_ROLE_IDS.find((id) => BUILT_IN_ROLES[id].setKind === kind) ?? null;
}

/** The catalog default set behind a permission set, or null for a custom role's set. */
export function defaultSetForSetKind(kind: RoleSetKind): PermissionDefaultSetKey | null {
  const id = builtInRoleForSetKind(kind);
  return id ? BUILT_IN_ROLES[id].defaultSet : null;
}

/** Sort rank of a permission set: built-in roles in catalog order, then custom roles. */
export function roleSetKindRank(kind: RoleSetKind): number {
  const id = builtInRoleForSetKind(kind);
  return id ? BUILT_IN_ROLE_IDS.indexOf(id) : BUILT_IN_ROLE_IDS.length;
}

/** Where Create role can start: a built-in role's permissions, or everything. */
export const ROLE_STARTS = ["member", "admin", "billing-manager", "everything"] as const;

export type RoleStart = (typeof ROLE_STARTS)[number];

export function isRoleStart(value: string): value is RoleStart {
  return ROLE_STARTS.some((start) => start === value);
}

export function roleStartLabel(start: RoleStart): string {
  return start === "everything" ? "Everything the owner can do" : BUILT_IN_ROLES[start].label;
}

/** Every permission a starting point turns on, whoever is creating the role. */
export function roleStartAllKeys(start: RoleStart): readonly PermissionKey[] {
  return start === "everything" ? PERMISSION_KEYS : permissionDefaultKeys(start);
}

/** The permissions a new role starts with, limited to what the person creating it holds. */
export function roleStartKeys(start: RoleStart, held: ReadonlySet<string>): PermissionKey[] {
  return roleStartAllKeys(start).filter((key) => held.has(key));
}

/**
 * Labels of the permissions a starting point is meant to have that its
 * creator can't give. Empty for "everything", which means "all you can give".
 */
export function roleStartMissingLabels(start: RoleStart, held: ReadonlySet<string>): string[] {
  if (start === "everything") return [];
  return roleStartAllKeys(start).filter((key) => !held.has(key)).map((key) => getPermissionDefinition(key).label);
}

type TeamReference = { id: string; name: string | null };

/** What the catalog needs from a permission set (PermissionSetSummary). */
export type RoleSetLike = {
  id: string;
  kind: RoleSetKind;
  name: string;
  allowedCount: number;
  team: TeamReference | null;
  teams: readonly TeamReference[];
  /** People given the set directly, without a team. Older servers don't send it. */
  directMemberIds?: readonly string[];
};

/** The teams a set applies to. Older responses only carry `team`. */
export function roleSetTeams(set: Pick<RoleSetLike, "team" | "teams">): TeamReference[] {
  return set.teams.length > 0 ? [...set.teams] : set.team ? [set.team] : [];
}

/** "Sales, Engineering". */
export function roleTeamNames(teams: readonly { name: string | null }[]): string {
  return teams.map((team) => team.name ?? "A deleted team").join(", ");
}

/** "3 permissions". */
export function permissionCountLabel(count: number): string {
  return `${count} ${count === 1 ? "permission" : "permissions"}`;
}

/** Who holds a role, as lists say it: "2 people, Finance", or "Nobody yet". */
export function roleHeldByLabel(people: number, teamNames: readonly string[]): string {
  return [people > 0 ? `${people} ${people === 1 ? "person" : "people"}` : null, ...teamNames].filter(Boolean).join(", ") || "Nobody yet";
}

/** A picker value for a custom role. Built-in roles use their id. */
export type CustomRoleValue = `role:${string}`;

export function customRoleValue(setId: string): CustomRoleValue {
  return `role:${setId}`;
}

/** The permission set a picker value names, or null for a built-in role. */
export function customRoleSetId(value: string): string | null {
  return value.startsWith("role:") ? value.slice("role:".length) || null : null;
}

export function isBuiltInRoleId(value: string): value is BuiltInRoleId {
  return BUILT_IN_ROLE_IDS.some((id) => id === value);
}

export type RoleListEntry =
  | {
      kind: "built_in";
      value: BuiltInRoleId;
      id: BuiltInRoleId;
      label: string;
      summary: string;
      /** The role's permission set, when the organization has one and the person can see it. */
      setId: string | null;
      /** Teams given the role by link (Billing manager, Super admin). Admin teams are a switch on the team. */
      teams: TeamReference[];
      /** People given the role by link (Billing manager). Admins and super admins hold an organization role. */
      directMemberIds: string[];
    }
  | {
      kind: "custom";
      value: CustomRoleValue;
      label: string;
      setId: string;
      allowedCount: number;
      teams: TeamReference[];
      directMemberIds: string[];
    };

/**
 * Every role of an organization, in the one order every screen uses:
 * built-in roles, then custom roles as the API lists them.
 */
export function roleList(input: { sets: readonly RoleSetLike[] }): RoleListEntry[] {
  const builtIn = BUILT_IN_ROLE_IDS.map((id): RoleListEntry => {
    const role = BUILT_IN_ROLES[id];
    const set = role.setKind ? input.sets.find((entry) => entry.kind === role.setKind) : undefined;
    return {
      kind: "built_in",
      value: id,
      id,
      label: role.label,
      summary: role.summary,
      setId: set?.id ?? null,
      teams: set ? roleSetTeams(set) : [],
      directMemberIds: [...(set?.directMemberIds ?? [])],
    };
  });
  const custom = input.sets.filter((set) => set.kind === "team").map((set): RoleListEntry => ({
    kind: "custom",
    value: customRoleValue(set.id),
    label: set.name,
    setId: set.id,
    allowedCount: set.allowedCount,
    teams: roleSetTeams(set),
    directMemberIds: [...(set.directMemberIds ?? [])],
  }));
  return [...builtIn, ...custom];
}

/** The role a picker value names, or null when the organization has no such role. */
export function roleForValue(roles: readonly RoleListEntry[], value: string): RoleListEntry | null {
  return roles.find((role) => role.value === value) ?? null;
}

/**
 * Why a role can't be given to that holder in this organization, or null
 * when it can. Roles that are a permission set given by link need that set:
 * Billing manager for anyone, Super admin for a team.
 */
export function roleUnavailableReason(entry: RoleListEntry, holder: RoleHolder): string | null {
  if (entry.kind === "custom") return null;
  const never = BUILT_IN_ROLES[entry.id].notGivenTo[holder];
  if (never) return never;
  if (entry.id === "super-admin" && holder === "team" && entry.setId === null) return SUPER_ADMIN_TEAM_UNAVAILABLE_REASON;
  if (entry.id === "billing-manager" && entry.setId === null) return "Needs View permissions. Ask the organization owner.";
  return null;
}

/** One row of a role picker. */
export type RoleOption = {
  value: string;
  label: string;
  caption: string | null;
  /** Pickers list built-in roles first, then custom roles under their own heading. */
  group: "built_in" | "custom";
  disabled: boolean;
  lockReason: string | null;
};

/**
 * The rows of a role picker, for a person or for a team: every role the Roles
 * tab shows, in the same order. A role that can't be given to that holder is
 * listed locked with the reason, never left out. `lockReason` adds the
 * caller's own locks (missing permissions, identity-provider teams).
 */
export function roleOptions(input: {
  roles: readonly RoleListEntry[];
  holder: RoleHolder;
  lockReason?: (entry: RoleListEntry) => string | null | undefined;
}): RoleOption[] {
  return input.roles.map((entry) => {
    const lockReason = roleUnavailableReason(entry, input.holder) ?? input.lockReason?.(entry) ?? null;
    return {
      value: entry.value,
      label: entry.label,
      caption: entry.kind === "built_in" ? entry.summary : permissionCountLabel(entry.allowedCount),
      group: entry.kind === "built_in" ? "built_in" : "custom",
      disabled: lockReason !== null,
      lockReason,
    };
  });
}
