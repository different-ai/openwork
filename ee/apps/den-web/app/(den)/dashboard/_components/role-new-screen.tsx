"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { PERMISSION_KEYS, type PermissionKey } from "@openwork/types/den/permissions";
import { DenButton } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";
import { DenNotice } from "../../_components/ui/notice";
import { DenSegmented } from "../../_components/ui/segmented";
import { DenStickyActionBar } from "../../_components/ui/sticky-action-bar";
import { getMembersRoute, getOrgAccessFlags, getPermissionSetRoute, permissionLockReason } from "../../_lib/den-org";
import {
  ROLE_STARTS,
  customRoleValue,
  isRoleStart,
  roleStartKeys,
  roleStartLabel,
  roleStartMissingLabels,
  type RoleStart,
} from "../../_lib/role-catalog";
import { useDenToast } from "./den-toast";
import { LinkButton } from "./item-list";
import { useCreateSharedRole, useOrganizationRoles, type PermissionStatus } from "./permissions-data";
import { RoleHolders } from "./role-holders";
import { memberRoleEntry, teamRoleEntry } from "./team-roles";
import { useGiveRole } from "./use-give-role";
import {
  PermissionEditor,
  PermissionsAccessState,
  PermissionsPage,
  usePermissionsAccess,
  type PermissionEditorRow,
  type PermissionsAccess,
} from "./permissions-ui";

import { useOrgDashboard } from "../_providers/org-dashboard-provider";

type ReadyAccess = Extract<PermissionsAccess, { state: "ready" }>;

/** Create a named role and give it to teams. `requestedStart` is the address's `?start=`, e.g. "billing". */
export function RoleNewScreen({ requestedStart = null }: { requestedStart?: string | null }) {
  const permissions = usePermissionsAccess();

  if (permissions.state !== "ready") {
    return <PermissionsPage title="Create role" testId="role-new"><PermissionsAccessState access={permissions} /></PermissionsPage>;
  }
  return <SharedRoleNewContent ready={permissions} requestedStart={requestedStart && isRoleStart(requestedStart) ? requestedStart : "member"} />;
}

/**
 * A role is created by name, given to any people and teams now (each one's
 * current role is replaced, as the rows say), and starts from Member, Admin,
 * Billing manager or everything, limited to what its creator holds.
 */
function SharedRoleNewContent({ ready, requestedStart }: { ready: ReadyAccess; requestedStart: RoleStart }) {
  const { orgContext } = useOrgDashboard();
  const router = useRouter();
  const toast = useDenToast();
  const create = useCreateSharedRole(ready.orgId);
  const organizationRoles = useOrganizationRoles(ready.orgId, true);
  const { roles } = organizationRoles;
  const { givePerson, giveTeam } = useGiveRole(ready.orgId);
  const access = orgContext ? getOrgAccessFlags(orgContext.currentMember.role, orgContext.currentMember.isOwner, orgContext.currentMember.permissions) : null;
  const [start, setStart] = useState<RoleStart>(requestedStart);
  const [name, setName] = useState("");
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [memberIds, setMemberIds] = useState<string[]>([]);
  // Switches the person changed by hand. Choosing another starting point keeps them.
  const [overrides, setOverrides] = useState<ReadonlyMap<PermissionKey, PermissionStatus>>(new Map());
  const base = new Set(roleStartKeys(start, ready.held));
  const allowed = new Set(PERMISSION_KEYS.filter((key) => (overrides.get(key) ?? (base.has(key) ? "allow" : "deny")) === "allow"));
  const missing = roleStartMissingLabels(start, ready.held);
  const back = { href: `${getMembersRoute(ready.orgSlug)}?tab=roles`, label: "Roles" };
  const trimmed = name.trim();

  // Nobody gives themselves a role, and the owner needs none.
  const people = (orgContext?.members ?? []).filter((member) => !member.isOwner && member.id !== orgContext?.currentMember.id).map((member) => ({
    id: member.id,
    name: member.user.name || member.user.email,
    detail: `${member.user.email}, now ${memberRoleEntry(organizationRoles.memberRoleState(member), roles).label}`,
  }));
  const teams = (orgContext?.teams ?? []).map((team) => ({
    id: team.id,
    name: team.name,
    detail: `${team.memberIds.length} ${team.memberIds.length === 1 ? "member" : "members"}, now ${teamRoleEntry(organizationRoles.teamRoleState(team), roles).label}`,
  }));
  const chosenNames = [
    ...memberIds.flatMap((id) => people.find((person) => person.id === id)?.name ?? []),
    ...teamIds.flatMap((id) => teams.find((team) => team.id === id)?.name ?? []),
  ];

  const rows: PermissionEditorRow[] = PERMISSION_KEYS.map((key) => {
    const status: PermissionStatus = allowed.has(key) ? "allow" : "deny";
    return { key, status, draft: status, lockedReason: ready.held.has(key) ? null : "You don't have this permission" };
  });

  function toggle(key: PermissionKey, next: PermissionStatus) {
    create.reset();
    setOverrides((current) => new Map(current).set(key, next));
  }

  function chooseStart(next: RoleStart) {
    create.reset();
    setStart(next);
  }

  async function submit() {
    if (!trimmed) return;
    try {
      const set = await create.mutateAsync({ name: trimmed, teamIds, memberIds, permissions: [...allowed].map((key) => ({ key, status: "allow" })) });
      // A person and a team hold one role: whoever was an admin becomes this role, as their row said.
      const created = { kind: "custom" as const, value: customRoleValue(set.id), label: set.name, setId: set.id, allowedCount: set.allowedCount, teams: [], directMemberIds: [] };
      for (const member of orgContext?.members ?? []) {
        if (memberIds.includes(member.id)) await givePerson(member.id, { ...organizationRoles.memberRoleState(member), setId: set.id }, created);
      }
      for (const team of orgContext?.teams ?? []) {
        if (teamIds.includes(team.id)) await giveTeam(team.id, { admin: team.grantsOrganizationAdmin, setId: set.id }, created);
      }
      toast({ title: `${trimmed} created` });
      router.replace(getPermissionSetRoute(ready.orgSlug, set.id));
    } catch {
      return;
    }
  }

  return (
    <PermissionsPage title="Create role" back={back} testId="role-new">
      <label className="flex max-w-sm flex-col gap-1.5">
        <span className="text-[13px] font-medium text-gray-700">Role name</span>
        <DenInput value={name} onChange={(event) => { create.reset(); setName(event.target.value); }} placeholder="Skill publisher" maxLength={120} data-testid="role-new-name" />
      </label>

      <RoleHolders
        title="Who gets this role"
        testId="role-new-holders"
        people={memberIds.flatMap((id) => people.find((person) => person.id === id) ?? [])}
        teams={teamIds.flatMap((id) => teams.find((team) => team.id === id) ?? [])}
        addablePeople={people.filter((person) => !memberIds.includes(person.id))}
        peopleLockReason={access?.canManageRoles ? null : permissionLockReason("members.update")}
        addableTeams={teams.filter((team) => !teamIds.includes(team.id))}
        onAddPeople={(ids) => { create.reset(); setMemberIds((current) => [...current, ...ids]); }}
        onAddTeams={(ids) => { create.reset(); setTeamIds((current) => [...current, ...ids]); }}
        onRemovePerson={(id) => { create.reset(); setMemberIds((current) => current.filter((entry) => entry !== id)); }}
        onRemoveTeam={(id) => { create.reset(); setTeamIds((current) => current.filter((entry) => entry !== id)); }}
        empty="Nobody yet. You can also give it later."
      />

      <div className="flex flex-col items-start gap-1.5" data-testid="role-new-start">
        <span className="text-[13px] font-medium text-gray-700">Start from</span>
        <DenSegmented
          aria-label="Start from"
          value={start}
          onChange={chooseStart}
          options={ROLE_STARTS.map((option) => ({ value: option, label: roleStartLabel(option) }))}
          optionTestId={(option) => `role-new-start-${option}`}
        />
        {/* Blocked, not an error: say what is left out and why (C5). */}
        {missing.length > 0 ? (
          <p className="text-[13px] text-gray-500" data-testid="role-new-start-missing">
            {`${roleStartLabel(start)} also has ${missing.join(", ")}. You don't have ${missing.length === 1 ? "that permission" : "those permissions"}, so this role starts without ${missing.length === 1 ? "it" : "them"}.`}
          </p>
        ) : null}
      </div>

      {create.error ? <DenNotice tone="error" message={create.error.message} /> : null}

      <PermissionEditor rows={rows} onToggle={toggle} />

      <DenStickyActionBar
        testId="role-new-save-bar"
        summary={trimmed ? (
          <span className="flex flex-col">
            <span className="font-medium text-gray-900">{`${allowed.size} ${allowed.size === 1 ? "permission" : "permissions"} selected`}</span>
            <span>{chosenNames.length > 0 ? `Given to ${chosenNames.join(", ")}` : "Nobody yet"}</span>
          </span>
        ) : <span>Name the role to save</span>}
      >
        <LinkButton variant="secondary" href={back.href}>Cancel</LinkButton>
        <DenButton disabled={!trimmed} loading={create.isPending} onClick={() => void submit()} data-testid="role-new-create">Create role</DenButton>
      </DenStickyActionBar>
    </PermissionsPage>
  );
}
