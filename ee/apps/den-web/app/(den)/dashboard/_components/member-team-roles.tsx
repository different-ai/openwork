import { getOrgAccessFlags, type DenOrgMember, type DenOrgTeam } from "../../_lib/den-org";
import type { RoleListEntry } from "../../_lib/role-catalog";
import { teamRoleLabels } from "./team-roles";

export function MemberTeamRoles({ member, teams, setIdByTeam, roles, exceptTeamId }: {
  member: DenOrgMember;
  teams: readonly DenOrgTeam[];
  setIdByTeam: ReadonlyMap<string, string>;
  roles: readonly RoleListEntry[];
  exceptTeamId?: string;
}) {
  const ownRole = member.isOwner ? "owner" : getOrgAccessFlags(member.role, false).isAdmin ? "admin" : "member";
  const otherTeams = exceptTeamId ? teams.filter((team) => team.id !== exceptTeamId) : teams;
  const labels = teamRoleLabels({ memberId: member.id, ownRole, teams: otherTeams, setIdByTeam, roles });
  if (labels.length === 0) return null;
  return <span className="mt-1 block text-[12px] text-gray-500" data-testid="member-team-roles">{labels.join(", ")}</span>;
}
