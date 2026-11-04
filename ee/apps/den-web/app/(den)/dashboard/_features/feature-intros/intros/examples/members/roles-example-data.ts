/** Sample data only: no API calls (DESIGN.md I7). Permission names as the permission list shows them. */

export const rolesExampleRole = { name: "Team lead", teams: "On Engineering and Sales", base: "Member, plus 3 permissions" };

export const rolesExamplePermissions: readonly string[] = [
  "Invite people",
  "Share with everyone",
  "View usage analytics",
];

export const rolesExampleBuiltIn: ReadonlyArray<{ name: string; detail: string }> = [
  { name: "Owner", detail: "Can do everything" },
  { name: "Admin", detail: "Invite people, manage teams, and run connections and models" },
  { name: "Member", detail: "What everyone can do" },
];
