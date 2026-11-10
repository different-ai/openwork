import {
  BILLING_MANAGER_PERMISSION_KEYS,
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
 * add a built-in or ready-made role, add it here; `roleList` and
 * `roleOptions` then carry it to every screen in the same order with the same
 * words, and the compiler asks for anything a screen has to decide about it.
 *
 * Three kinds of role:
 *
 *   built-in    Member, Admin, Super admin, Owner. Always exist.
 *   custom      a named permission set the organization made (kind "team"),
 *               given to people through teams.
 *   ready-made  a custom role we suggest, with its name and permissions
 *               filled in (Billing manager). It becomes a custom role when
 *               someone creates it.
 */

/** Kinds of permission set the API returns (ee/apps/den-api/src/routes/org/permissions.ts). */
export type RoleSetKind = "member_default" | "admin_default" | "super_admin_default" | "team";

/** Who a role picker is choosing for. */
export type RoleHolder = "person" | "team";

/** Built-in roles, in the order every screen lists them. */
export const BUILT_IN_ROLE_IDS = ["member", "admin", "super-admin", "owner"] as const;

export type BuiltInRoleId = (typeof BUILT_IN_ROLE_IDS)[number];

export type BuiltInRole = {
  label: string;
  /** What the role is for, in one line. The same line on every screen. */
  summary: string;
  /** The permission set that holds the role's permissions. Null for Owner, who holds every permission without a set. */
  setKind: Exclude<RoleSetKind, "team"> | null;
  /** The default set key behind `setKind`, for catalog defaults. */
  defaultSet: PermissionDefaultSetKey | null;
  /** Why the role can't be picked for a person or for a team. Absent when it can. */
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
  "super-admin": {
    label: "Super admin",
    summary: "Everything the owner can do, except delete the organization",
    setKind: "super_admin_default",
    defaultSet: "super-admin",
    notGivenTo: { team: "Given to people, not teams." },
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

/** Ready-made roles, in the order they are offered. */
export const READY_MADE_ROLE_IDS = ["billing"] as const;

export type ReadyMadeRoleId = (typeof READY_MADE_ROLE_IDS)[number];

export type ReadyMadeRole = {
  /** The name the custom role gets. */
  label: string;
  summary: string;
  /** The permissions it starts with, before limiting to what its creator holds. */
  keys: readonly PermissionKey[];
};

export const READY_MADE_ROLES: Record<ReadyMadeRoleId, ReadyMadeRole> = {
  billing: {
    label: "Billing manager",
    summary: "See plan, usage and invoices, and manage payment details",
    keys: BILLING_MANAGER_PERMISSION_KEYS,
  },
};

export function isReadyMadeRoleId(value: string): value is ReadyMadeRoleId {
  return READY_MADE_ROLE_IDS.some((id) => id === value);
}

/** Where Create role can start: a built-in role's permissions, a ready-made role, or everything. */
export const ROLE_STARTS = ["member", "admin", ...READY_MADE_ROLE_IDS, "everything"] as const;

export type RoleStart = (typeof ROLE_STARTS)[number];

export function isRoleStart(value: string): value is RoleStart {
  return ROLE_STARTS.some((start) => start === value);
}

export function roleStartLabel(start: RoleStart): string {
  if (start === "everything") return "Everything the owner can do";
  return isReadyMadeRoleId(start) ? READY_MADE_ROLES[start].label : BUILT_IN_ROLES[start].label;
}

/** Every permission a starting point turns on, whoever is creating the role. */
export function roleStartAllKeys(start: RoleStart): readonly PermissionKey[] {
  if (start === "everything") return PERMISSION_KEYS;
  if (isReadyMadeRoleId(start)) return READY_MADE_ROLES[start].keys;
  return permissionDefaultKeys(start);
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
};

/** The teams a set applies to. Older responses only carry `team`. */
export function roleSetTeams(set: Pick<RoleSetLike, "team" | "teams">): TeamReference[] {
  return set.teams.length > 0 ? [...set.teams] : set.team ? [set.team] : [];
}

/** "Sales, Engineering". */
export function roleTeamNames(teams: readonly { name: string | null }[]): string {
  return teams.map((team) => team.name ?? "A deleted team").join(", ");
}

/** "On Sales, Engineering", or "No teams yet". */
export function roleTeamsCaption(teams: readonly { name: string | null }[]): string {
  return teams.length > 0 ? `On ${roleTeamNames(teams)}` : "No teams yet";
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
    }
  | {
      kind: "custom";
      value: CustomRoleValue;
      label: string;
      setId: string;
      allowedCount: number;
      teams: TeamReference[];
    }
  | {
      kind: "ready_made";
      value: `ready:${ReadyMadeRoleId}`;
      id: ReadyMadeRoleId;
      label: string;
      summary: string;
    };

function sameRoleName(left: string, right: string): boolean {
  return left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase();
}

/**
 * Every role of an organization, in the one order every screen uses:
 * built-in roles, then custom roles as the API lists them, then (with
 * `readyMade`) the ready-made roles nobody has created yet. A ready-made role
 * counts as created once a custom role has its name.
 */
export function roleList(input: { sets: readonly RoleSetLike[]; readyMade: boolean }): RoleListEntry[] {
  const builtIn = BUILT_IN_ROLE_IDS.map((id): RoleListEntry => {
    const role = BUILT_IN_ROLES[id];
    const set = role.setKind ? input.sets.find((entry) => entry.kind === role.setKind) : undefined;
    return { kind: "built_in", value: id, id, label: role.label, summary: role.summary, setId: set?.id ?? null };
  });
  const customSets = input.sets.filter((set) => set.kind === "team");
  const custom = customSets.map((set): RoleListEntry => ({
    kind: "custom",
    value: customRoleValue(set.id),
    label: set.name,
    setId: set.id,
    allowedCount: set.allowedCount,
    teams: roleSetTeams(set),
  }));
  const readyMade = input.readyMade
    ? READY_MADE_ROLE_IDS
      .filter((id) => !customSets.some((set) => sameRoleName(set.name, READY_MADE_ROLES[id].label)))
      .map((id): RoleListEntry => ({ kind: "ready_made", value: `ready:${id}`, id, label: READY_MADE_ROLES[id].label, summary: READY_MADE_ROLES[id].summary }))
    : [];
  return [...builtIn, ...custom, ...readyMade];
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
 * The rows of a role picker, for a person or for a team, from the same list
 * the Roles tab shows.
 *
 * A built-in role that can't be given to that holder (Super admin to a team,
 * Owner to anyone) is listed locked with the reason when `showUnavailable`
 * is set, and left out otherwise. Ready-made roles aren't listed: they can be
 * given once they are created. `lockReason` adds the caller's own locks (missing
 * permissions, identity-provider teams).
 */
export function roleOptions(input: {
  roles: readonly RoleListEntry[];
  holder: RoleHolder;
  showUnavailable: boolean;
  lockReason?: (entry: Exclude<RoleListEntry, { kind: "ready_made" }>) => string | null | undefined;
}): RoleOption[] {
  const options: RoleOption[] = [];
  for (const entry of input.roles) {
    if (entry.kind === "ready_made") continue;
    if (entry.kind === "built_in") {
      const unavailable = BUILT_IN_ROLES[entry.id].notGivenTo[input.holder] ?? null;
      if (unavailable !== null && !input.showUnavailable) continue;
      const lockReason = unavailable ?? input.lockReason?.(entry) ?? null;
      options.push({ value: entry.value, label: entry.label, caption: entry.summary, group: "built_in", disabled: lockReason !== null, lockReason });
      continue;
    }
    const lockReason = input.lockReason?.(entry) ?? null;
    options.push({ value: entry.value, label: entry.label, caption: roleTeamsCaption(entry.teams), group: "custom", disabled: lockReason !== null, lockReason });
  }
  return options;
}
