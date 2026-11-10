/** Words for the explainers on a team's page and Everyone's page, shown with `teamSettingsSidebar` on. */

export const TEAM_ROLE_HELP = "What people in this team can do in the organization, on top of what every member can. Member adds nothing, Admin makes everyone in the team an admin, and a custom role adds the permissions you choose.";

/** Under the role, when it adds no permission: says so, instead of leaving the page with one row. */
export function teamRoleAddsNothingLine(kind: "member" | "admin" | "custom", teamName: string): string {
  if (kind === "custom") return `This role adds nothing beyond what every member can do. Open the role to add permissions for ${teamName}.`;
  return `People in ${teamName} can do what every member can. Change the role to let them do more.`;
}

/** The heading over the rows of the Agents and Browser sections. */
export function agentPermissionsHeading(area: "all" | "agents" | "browser"): string {
  return area === "browser" ? "Websites" : "Agent permissions";
}
