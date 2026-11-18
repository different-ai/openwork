"use client";

import { useState } from "react";
import { DenNotice } from "../../_components/ui/notice";
import { permissionLockReason } from "../../_lib/den-org";
import type { RoleListEntry } from "../../_lib/role-catalog";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { useDenToast } from "./den-toast";
import { ItemPanel, ItemRowsSkeleton } from "./item-list";
import { useOrganizationRoles, type PermissionSetDetail } from "./permissions-data";
import type { PermissionsAccess } from "./permissions-ui";
import { RoleHolders } from "./role-holders";
import {
  SUPER_ADMIN_ROLE_LOCK_REASON,
  memberRoleEntry,
  memberRoleStateAfter,
  teamRoleEntry,
  teamRoleLockReason,
  teamRoleStateAfter,
  type MemberRoleState,
  type TeamRoleState,
} from "./team-roles";
import { useGiveRole } from "./use-give-role";

type ReadyAccess = Extract<PermissionsAccess, { state: "ready" }>;

const GRANT_LOCK_REASON = "This role grants permissions you don't have. Ask the organization owner.";
const OWN_ROLE_LOCK_REASON = "You can't change your own role.";

/**
 * A role's own page: the people and teams that have it, with Add person and
 * Add team. Giving it here is the same change as picking it on a person's row
 * or a team's page (useGiveRole), so it replaces the role they had; Remove
 * takes them back to Member. Every change offers Undo.
 */
export function RoleWhoHasIt({ ready, set }: { ready: ReadyAccess; set: PermissionSetDetail }) {
  const toast = useDenToast();
  const { orgContext } = useOrgDashboard();
  const organizationRoles = useOrganizationRoles(ready.orgId, true);
  const { roles, memberRoleState, teamRoleState } = organizationRoles;
  const { givePerson, giveTeam } = useGiveRole(ready.orgId);
  const [error, setError] = useState<string | null>(null);
  const role = roles.find((entry) => entry.setId === set.id) ?? null;
  const member = roles.find((entry) => entry.kind === "built_in" && entry.id === "member") ?? null;

  if (organizationRoles.error) {
    return <DenNotice tone="error" message={organizationRoles.error instanceof Error ? organizationRoles.error.message : "Couldn't load who has this role."} />;
  }
  if (!orgContext || !role || !member || organizationRoles.loading) {
    return <ItemPanel><ItemRowsSkeleton label="Loading who has this role" rows={2} /></ItemPanel>;
  }

  const people = orgContext.members;
  const teams = orgContext.teams;
  const holdsAll = set.permissions.every((entry) => entry.status !== "allow" || ready.held.has(entry.key));
  const isSuperAdmin = role.kind === "built_in" && role.id === "super-admin";
  const hasOwnerAuthority = ready.access.isOwner || ready.access.isSuperAdmin;
  // Giving a role is a role change, and grants what the role allows: the same rules as everywhere else.
  const peopleLockReason = !ready.access.canManageRoles
    ? permissionLockReason("members.update")
    : isSuperAdmin && !hasOwnerAuthority ? SUPER_ADMIN_ROLE_LOCK_REASON : holdsAll ? null : GRANT_LOCK_REASON;
  const abilities = { canManageAdminTeams: ready.access.canManageAdminTeams, canManagePermissions: ready.access.canManagePermissions, hasOwnerAuthority };
  const teamsLockReason = teamRoleLockReason({ admin: false, setId: null }, role, roles, abilities) ?? (holdsAll ? null : GRANT_LOCK_REASON);

  async function change(title: string, run: () => Promise<void>, undo: () => Promise<void>) {
    setError(null);
    try {
      await run();
      toast({ title, action: { label: "Undo", onClick: () => { void undo().catch((cause) => setError(cause instanceof Error ? cause.message : "Couldn't undo the change.")); } } });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't change who has this role.");
    }
  }

  /** Give several people or teams `next`, and plan the way back for Undo. */
  async function givePeople(ids: readonly string[], next: RoleListEntry) {
    const moves = people.filter((person) => ids.includes(person.id)).map((person) => {
      const state: MemberRoleState = memberRoleState(person);
      return { person, state, previous: memberRoleEntry(state, roles) };
    });
    if (moves.length === 0) return;
    const names = moves.map((move) => move.person.user.name || move.person.user.email).join(", ");
    await change(
      `${names} ${moves.length === 1 ? "is" : "are"} now ${next.label}`,
      async () => { for (const move of moves) await givePerson(move.person.id, move.state, next); },
      async () => { for (const move of moves) await givePerson(move.person.id, memberRoleStateAfter(next), move.previous); },
    );
  }
  async function giveTeams(ids: readonly string[], next: RoleListEntry) {
    const moves = teams.filter((team) => ids.includes(team.id)).map((team) => {
      const state: TeamRoleState = teamRoleState(team);
      return { team, state, previous: teamRoleEntry(state, roles) };
    });
    if (moves.length === 0) return;
    await change(
      `${moves.map((move) => move.team.name).join(", ")} ${moves.length === 1 ? "is" : "are"} now ${next.label}`,
      async () => { for (const move of moves) await giveTeam(move.team.id, move.state, next); },
      async () => { for (const move of moves) await giveTeam(move.team.id, teamRoleStateAfter(next), move.previous); },
    );
  }

  const holdingPeople = people.filter((person) => !person.isOwner && memberRoleEntry(memberRoleState(person), roles).value === role.value);
  const holdingTeams = teams.filter((team) => teamRoleEntry(teamRoleState(team), roles).value === role.value);

  return (
    <div className="flex flex-col gap-3" data-testid="role-who-has-it">
      {error ? <DenNotice tone="error" message={error} /> : null}
      <RoleHolders
        title="Who has this role"
        people={holdingPeople.map((person) => ({
          id: person.id,
          name: person.user.name || person.user.email,
          detail: person.joinedAt ? person.user.email : "Invite sent",
          lockReason: person.id === orgContext.currentMember.id ? OWN_ROLE_LOCK_REASON : peopleLockReason,
        }))}
        teams={holdingTeams.map((team) => ({
          id: team.id,
          name: team.name,
          detail: `Team, ${team.memberIds.length} ${team.memberIds.length === 1 ? "member" : "members"}`,
          lockReason: teamRoleLockReason(teamRoleState(team), member, roles, abilities),
        }))}
        // Nobody gives themselves a role, the owner needs none, and an invitation keeps the role it was sent with.
        addablePeople={people
          .filter((person) => !person.isOwner && person.joinedAt && person.id !== orgContext.currentMember.id && !holdingPeople.includes(person))
          .map((person) => ({ id: person.id, name: person.user.name || person.user.email, detail: `${person.user.email}, now ${memberRoleEntry(memberRoleState(person), roles).label}` }))}
        addableTeams={teams
          .filter((team) => !holdingTeams.includes(team))
          .map((team) => ({ id: team.id, name: team.name, detail: `${team.memberIds.length} ${team.memberIds.length === 1 ? "member" : "members"}, now ${teamRoleEntry(teamRoleState(team), roles).label}` }))}
        peopleLockReason={peopleLockReason}
        teamsLockReason={teamsLockReason}
        onAddPeople={(ids) => void givePeople(ids, role)}
        onAddTeams={(ids) => void giveTeams(ids, role)}
        onRemovePerson={(id) => void givePeople([id], member)}
        onRemoveTeam={(id) => void giveTeams([id], member)}
      />
    </div>
  );
}
