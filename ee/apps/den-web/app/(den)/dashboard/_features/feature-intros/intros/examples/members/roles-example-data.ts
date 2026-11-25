import { BUILT_IN_ROLES } from "../../../../../../_lib/role-catalog";

export const rolesExampleRole = { name: "Team lead", teams: "On Engineering and Sales", base: "Member, plus 3 permissions" };

export const rolesExamplePermissions: readonly string[] = [
  "Invite people",
  "Share with everyone",
  "View usage analytics",
];

export const rolesExampleBuiltIn: ReadonlyArray<{ name: string; detail: string }> = (["owner", "admin", "member"] as const).map((id) => ({
  name: BUILT_IN_ROLES[id].label,
  detail: BUILT_IN_ROLES[id].summary,
}));
