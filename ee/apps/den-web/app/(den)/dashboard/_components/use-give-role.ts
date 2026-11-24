"use client";

import type { RoleListEntry } from "../../_lib/role-catalog";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { useSetMemberRole, useSetTeamRole } from "./permissions-data";
import { memberRoleSteps, teamRoleSteps, type MemberRoleState, type TeamRoleState } from "./team-roles";

export function useGiveRole(orgId: string | null) {
  const { updateMemberRole, updateTeam } = useOrgDashboard();
  const setTeamRole = useSetTeamRole(orgId ?? "");
  const setMemberRole = useSetMemberRole(orgId ?? "");

  async function givePerson(memberId: string, current: MemberRoleState, next: RoleListEntry) {
    for (const step of memberRoleSteps(current, next)) {
      if (step.kind === "set-role") await updateMemberRole(memberId, step.role);
      else await setMemberRole.mutateAsync({ memberId, permissionSetId: step.setId });
    }
  }

  async function giveTeam(teamId: string, current: TeamRoleState, next: RoleListEntry) {
    for (const step of teamRoleSteps(current, next)) {
      if (step.kind === "set-admin") await updateTeam(teamId, { grantsOrganizationAdmin: step.value });
      else await setTeamRole.mutateAsync({ teamId, permissionSetId: step.setId });
    }
  }

  return { givePerson, giveTeam };
}
