"use client";

import Link from "next/link";
import { useState } from "react";
import { Check, Plus, ShieldCheck } from "lucide-react";
import { getPermissionDefinition, permissionDefaultKeys, type PermissionKey } from "@openwork/types/den/permissions";
import { DenButton } from "../../_components/ui/button";
import { DenNotice } from "../../_components/ui/notice";
import { DenSkeleton } from "../../_components/ui/skeleton";
import { getNewRoleRoute, getOrgAccessFlags, getPermissionSetRoute, type DenOrgTeam } from "../../_lib/den-org";
import { roleTeamNames, type RoleListEntry } from "../../_lib/role-catalog";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { IconTile } from "./access-rows";
import { RolePicker as SearchableRolePicker } from "./role-picker";
import { useDenToast } from "./den-toast";
import { ItemPanel, ItemRow, ItemRowsSkeleton, ItemSection, LinkButton } from "./item-list";
import { useOrganizationRoles, usePermissionSet, useRoleGrantLocks } from "./permissions-data";
import {
  allowedKeys,
  teamRoleEntry,
  teamRoleOptions,
  teamRoleStateAfter,
  type TeamRoleAbilities,
  type TeamRoleState,
} from "./team-roles";
import { useGiveRole } from "./use-give-role";

/**
 * A team's one role, from the organization's role list (Member, Admin,
 * Billing manager, Super admin or a custom role), what it adds, and Change
 * role as a searchable picker of every role. A role can be on several teams;
 * changing it here only changes this team.
 */
export function SharedTeamRolePanel({ team }: { team: DenOrgTeam }) {
  const { orgContext, orgId, orgSlug } = useOrgDashboard();
  const access = orgContext
    ? getOrgAccessFlags(orgContext.currentMember.role, orgContext.currentMember.isOwner, orgContext.currentMember.permissions)
    : null;
  const organizationRoles = useOrganizationRoles(orgId, true);
  const { roles, sets } = organizationRoles;
  const state: TeamRoleState = { admin: team.grantsOrganizationAdmin, setId: organizationRoles.setIdByTeam.get(team.id) ?? null };
  const role = teamRoleEntry(state, roles);
  // The Admin switch gives the Admin permissions; a set the team holds gives its own.
  const linkedSetId = state.setId;
  const adminSet = sets.find((set) => set.kind === "admin_default") ?? null;
  const memberSet = sets.find((set) => set.kind === "member_default") ?? null;

  const linkedSetDetail = usePermissionSet(orgId, linkedSetId ?? "", Boolean(linkedSetId));
  const adminSetDetail = usePermissionSet(orgId, adminSet?.id ?? "", Boolean(adminSet));
  const memberSetDetail = usePermissionSet(orgId, memberSet?.id ?? "", Boolean(memberSet && memberSet.allowedCount > 0));
  const adminKeys: PermissionKey[] = adminSetDetail.data ? allowedKeys(adminSetDetail.data.permissions) : permissionDefaultKeys("admin");
  const memberKeys: PermissionKey[] = memberSetDetail.data ? allowedKeys(memberSetDetail.data.permissions) : permissionDefaultKeys("member");
  const linkedKeys: PermissionKey[] = linkedSetDetail.data ? allowedKeys(linkedSetDetail.data.permissions) : [];
  const alsoKeys = [...new Set([...(state.admin ? adminKeys : []), ...linkedKeys])].filter((key) => !memberKeys.includes(key));
  const loading = organizationRoles.loading || (linkedSetId !== null && linkedSetDetail.isPending);

  const isMember = role.kind === "built_in" && role.id === "member";
  const isAdmin = role.kind === "built_in" && role.id === "admin";
  const otherTeams = isMember || isAdmin ? [] : role.teams.filter((entry) => entry.id !== team.id);
  const title = role.label;
  const description = isMember
    ? role.summary
    : isAdmin
      ? `Everyone in ${team.name} is an admin`
      : `${role.kind === "custom" ? "Custom role" : "Built-in role"}${otherTeams.length > 0 ? `, also on ${roleTeamNames(otherTeams)}` : ""}`;
  const abilities: TeamRoleAbilities = {
    canManageAdminTeams: access?.canManageAdminTeams ?? false,
    canManagePermissions: access?.canManagePermissions ?? false,
    hasOwnerAuthority: (access?.isOwner ?? false) || (access?.isSuperAdmin ?? false),
  };
  // A role can only be given by someone who holds everything it grants.
  const grantLocks = useRoleGrantLocks(orgId, sets, orgContext?.currentMember.permissions ?? [], orgContext?.currentMember.isOwner ?? false);
  const roleKind = isMember ? "member" : isAdmin ? "admin" : "custom";

  return (
    <div className="flex flex-col gap-6" data-testid="team-role" data-role={roleKind}>
      {organizationRoles.error ? <DenNotice tone="error" message={organizationRoles.error instanceof Error ? organizationRoles.error.message : "Couldn't load this team's role."} /> : null}
      <ItemPanel>
        <div className="flex min-h-12 flex-wrap items-center gap-3 py-1.5">
          <IconTile icon={ShieldCheck} />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-[13px] font-medium leading-5 text-[var(--dls-text-primary)]" title={title} data-testid="team-role-name">{loading ? <DenSkeleton className="h-5 w-28" /> : title}</span>
            {loading ? <DenSkeleton className="h-[18px] w-48" /> : <span className="text-[12px] leading-4 text-[var(--dls-text-secondary)]">{description}</span>}
          </span>
          <span className="flex max-w-full flex-wrap gap-2">
            {!isMember && role.setId ? (
              <LinkButton size="sm" variant="secondary" href={getPermissionSetRoute(orgSlug, role.setId)} data-testid="team-role-open">Open role</LinkButton>
            ) : null}
            <RolePicker
              team={team}
              state={state}
              roles={roles}
              lockReasons={grantLocks}
              abilities={abilities}
              disabled={loading}
              newRoleHref={getNewRoleRoute(orgSlug)}
            />
          </span>
        </div>
      </ItemPanel>

      {loading ? (
        <ItemPanel><ItemRowsSkeleton label="Loading what this team can do" rows={3} /></ItemPanel>
      ) : alsoKeys.length > 0 ? (
        <ItemSection title={`${team.name} can also`} testId="team-role-also">
          <ItemPanel>
            {alsoKeys.map((key) => <ItemRow key={key} logo={<CheckMark />} title={getPermissionDefinition(key).label} />)}
          </ItemPanel>
        </ItemSection>
      ) : null}
    </div>
  );
}

function CheckMark() {
  return <span aria-hidden className="flex h-8 w-8 items-center justify-center text-gray-900"><Check className="h-4 w-4" strokeWidth={2} /></span>;
}

/** Change role: the organization's one role list in a searchable picker, opened under the button. */
function RolePicker({ team, state, roles, lockReasons, abilities, disabled, newRoleHref }: {
  team: DenOrgTeam;
  state: TeamRoleState;
  roles: readonly RoleListEntry[];
  lockReasons: ReadonlyMap<string, string | null>;
  abilities: TeamRoleAbilities;
  disabled: boolean;
  newRoleHref: string;
}) {
  const toast = useDenToast();
  const { orgId } = useOrgDashboard();
  const { giveTeam } = useGiveRole(orgId);
  const current = teamRoleEntry(state, roles);
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<string>(current.value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const options = teamRoleOptions({ roles, state, abilities, lockReasons });
  const chosen = roles.find((role) => role.value === choice) ?? current;
  const changed = chosen.value !== current.value;

  function close() {
    setOpen(false);
    setChoice(current.value);
    setError(null);
  }

  async function save() {
    if (!changed) return;
    const previous = current;
    setBusy(true);
    setError(null);
    try {
      await giveTeam(team.id, state, chosen);
      setOpen(false);
      toast({
        title: `${team.name} is now ${chosen.label}`,
        action: { label: "Undo", onClick: () => { void giveTeam(team.id, teamRoleStateAfter(chosen), previous); } },
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't change the role.");
    } finally {
      setBusy(false);
    }
  }

  return <div className="w-40 max-w-full">
    <SearchableRolePicker
      value={choice}
      onChange={setChoice}
      size="sm"
      options={options} label={`Role for ${team.name}`} trigger="Change role" disabled={disabled}
      testId="team-role" open={open} onOpenChange={(next) => next ? (setChoice(current.value), setOpen(true)) : close()}
      footer={<>
        {error ? <DenNotice tone="error" message={error} /> : null}
        <Link href={newRoleHref} className="mb-2 inline-flex items-center gap-1.5 px-2 py-1 text-[12px] text-gray-700"><Plus className="h-3.5 w-3.5" aria-hidden />Create role</Link>
        <div className="flex min-w-0 justify-end gap-2">
          <DenButton size="sm" variant="secondary" onClick={close}>Cancel</DenButton>
          <DenButton size="sm" disabled={!changed} loading={busy} onClick={() => void save()} className="min-w-0" title={changed ? `Change to ${chosen.label}` : undefined} data-testid="team-role-save">
            <span className="truncate">{changed ? `Change to ${chosen.label}` : "Change role"}</span>
          </DenButton>
        </div>
      </>}
    />
  </div>;
}
