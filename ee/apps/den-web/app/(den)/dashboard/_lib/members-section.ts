export type MembersSectionRedirectInput = {
  section: "members" | "teams" | "roles";
  tab: string | null;
  editTeam: string | null;
  search: string;
};

export function membersSectionRedirect(
  input: MembersSectionRedirectInput,
  routes: { teams: string; roles: string },
): string | null {
  if (input.section !== "members") return null;
  const target = input.editTeam || input.tab === "teams" ? routes.teams : input.tab === "roles" ? routes.roles : null;
  if (!target) return null;
  const params = new URLSearchParams(input.search);
  params.delete("tab");
  const rest = params.toString();
  return rest ? `${target}?${rest}` : target;
}
