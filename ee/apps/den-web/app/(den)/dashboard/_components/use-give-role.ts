"use client";

import type { RoleListEntry } from "../../_lib/role-catalog";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { useSetMemberRole, useSetTeamRole } from "./permissions-data";
import { memberRoleSteps, teamRoleSteps, type MemberRoleState, type TeamRoleState } from "./team-roles";

/**
 * Gives a person or a team a role from the organization's one role list.
 * Every screen that changes a role calls this, so a role is given the same
 * way from a person's row, a team's page, a role's page, Add member, Create
 * team and Create role. The steps come from team-roles.ts and run in an order
 * that never leaves anyone with less access part way.
 */
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
