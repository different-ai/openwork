import { BUILT_IN_ROLES } from "../../../../../../_lib/role-catalog";

/** Sample data only: no API calls (DESIGN.md I7). Permission names as the permission list shows them. */

export const rolesExampleRole = { name: "Team lead", teams: "On Engineering and Sales", base: "Member, plus 3 permissions" };

export const rolesExamplePermissions: readonly string[] = [
  "Invite people",
  "Share with everyone",
  "View usage analytics",
];

/** Names and summaries as the Roles tab shows them (the role catalog). */
export const rolesExampleBuiltIn: ReadonlyArray<{ name: string; detail: string }> = (["owner", "admin", "member"] as const).map((id) => ({
  name: BUILT_IN_ROLES[id].label,
  detail: BUILT_IN_ROLES[id].summary,
}));
