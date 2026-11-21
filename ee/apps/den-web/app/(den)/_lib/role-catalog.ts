import {
  PERMISSION_KEYS,
  getPermissionDefinition,
  permissionDefaultKeys,
  type PermissionDefaultSetKey,
  type PermissionKey,
} from "@openwork/types/den/permissions";

export type RoleSetKind = "member_default" | "admin_default" | "billing_manager_default" | "super_admin_default" | "team";

export type RoleHolder = "person" | "team";

export const BUILT_IN_ROLE_IDS = ["member", "admin", "billing-manager", "super-admin", "owner"] as const;

export type BuiltInRoleId = (typeof BUILT_IN_ROLE_IDS)[number];

export type BuiltInRole = {
  label: string;
  summary: string;
  setKind: Exclude<RoleSetKind, "team"> | null;
  defaultSet: PermissionDefaultSetKey | null;
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

export const SUPER_ADMIN_TEAM_UNAVAILABLE_REASON = "Given to people, not teams.";

export function builtInRoleForSetKind(kind: RoleSetKind): BuiltInRoleId | null {
  return BUILT_IN_ROLE_IDS.find((id) => BUILT_IN_ROLES[id].setKind === kind) ?? null;
}

export function defaultSetForSetKind(kind: RoleSetKind): PermissionDefaultSetKey | null {
  const id = builtInRoleForSetKind(kind);
  return id ? BUILT_IN_ROLES[id].defaultSet : null;
}

export function roleSetKindRank(kind: RoleSetKind): number {
  const id = builtInRoleForSetKind(kind);
  return id ? BUILT_IN_ROLE_IDS.indexOf(id) : BUILT_IN_ROLE_IDS.length;
}

export const ROLE_STARTS = ["member", "admin", "billing-manager", "everything"] as const;

export type RoleStart = (typeof ROLE_STARTS)[number];

export function isRoleStart(value: string): value is RoleStart {
  return ROLE_STARTS.some((start) => start === value);
}

export function roleStartLabel(start: RoleStart): string {
  return start === "everything" ? "Everything the owner can do" : BUILT_IN_ROLES[start].label;
}

export function roleStartAllKeys(start: RoleStart): readonly PermissionKey[] {
  return start === "everything" ? PERMISSION_KEYS : permissionDefaultKeys(start);
}

export function roleStartKeys(start: RoleStart, held: ReadonlySet<string>): PermissionKey[] {
  return roleStartAllKeys(start).filter((key) => held.has(key));
}

export function roleStartMissingLabels(start: RoleStart, held: ReadonlySet<string>): string[] {
  if (start === "everything") return [];
  return roleStartAllKeys(start).filter((key) => !held.has(key)).map((key) => getPermissionDefinition(key).label);
}

type TeamReference = { id: string; name: string | null };

export type RoleSetLike = {
  id: string;
  kind: RoleSetKind;
  name: string;
  allowedCount: number;
  team: TeamReference | null;
  teams: readonly TeamReference[];
  directMemberIds?: readonly string[];
};

export function roleSetTeams(set: Pick<RoleSetLike, "team" | "teams">): TeamReference[] {
  return set.teams.length > 0 ? [...set.teams] : set.team ? [set.team] : [];
}

export function roleTeamNames(teams: readonly { name: string | null }[]): string {
  return teams.map((team) => team.name ?? "A deleted team").join(", ");
}

export function permissionCountLabel(count: number): string {
  return `${count} ${count === 1 ? "permission" : "permissions"}`;
}

export function roleHeldByLabel(people: number, teamNames: readonly string[]): string {
  return [people > 0 ? `${people} ${people === 1 ? "person" : "people"}` : null, ...teamNames].filter(Boolean).join(", ") || "Nobody yet";
}

export type CustomRoleValue = `role:${string}`;

export function customRoleValue(setId: string): CustomRoleValue {
  return `role:${setId}`;
}

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
      setId: string | null;
      teams: TeamReference[];
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

export function roleForValue(roles: readonly RoleListEntry[], value: string): RoleListEntry | null {
  return roles.find((role) => role.value === value) ?? null;
}

export function roleUnavailableReason(entry: RoleListEntry, holder: RoleHolder): string | null {
  if (entry.kind === "custom") return null;
  const never = BUILT_IN_ROLES[entry.id].notGivenTo[holder];
  if (never) return never;
  if (entry.id === "super-admin" && holder === "team" && entry.setId === null) return SUPER_ADMIN_TEAM_UNAVAILABLE_REASON;
  if (entry.id === "billing-manager" && entry.setId === null) return "Needs View permissions. Ask the organization owner.";
  return null;
}

export type RoleOption = {
  value: string;
  label: string;
  caption: string | null;
  group: "built_in" | "custom";
  disabled: boolean;
  lockReason: string | null;
};

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
