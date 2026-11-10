"use client";

import Link from "next/link";
import { useState } from "react";
import { Check, Plus, ShieldCheck } from "lucide-react";
import { getPermissionDefinition, permissionDefaultKeys, type PermissionKey } from "@openwork/types/den/permissions";
import { DenButton } from "../../_components/ui/button";
import { DenNotice } from "../../_components/ui/notice";
import { DenSkeleton } from "../../_components/ui/skeleton";
import { getNewRoleRoute, getOrgAccessFlags, getPermissionSetRoute, orgFeatureEnabled, type DenOrgTeam } from "../../_lib/den-org";
import { roleList, roleSetTeams, roleTeamNames, type RoleListEntry } from "../../_lib/role-catalog";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { IconTile } from "./access-rows";
import { HelpTip } from "./help-tip";
import { TEAM_ROLE_HELP, teamRoleAddsNothingLine } from "./team-section-help";
import { useTeamSectionsHelp } from "./team-sections";
import { RolePicker as SearchableRolePicker } from "./role-picker";
import { useDenToast } from "./den-toast";
import { ItemPanel, ItemRow, ItemRowsSkeleton, ItemSection, LinkButton } from "./item-list";
import { usePermissionSet, usePermissionSets, useSetTeamRole } from "./permissions-data";
import {
  TEAM_ROLE_DESCRIPTIONS,
  TEAM_ROLE_LABELS,
  allowedKeys,
  sameSharedTeamRole,
  sharedTeamRole,
  sharedTeamRoleFromValue,
  sharedTeamRoleSteps,
  sharedTeamRoleValue,
  teamRoleOptions,
  type SharedTeamRole,
  type SharedTeamRoleState,
  type TeamRoleAbilities,
} from "./team-roles";

/**
 * sharedRoles: a team's one role (Member, Admin, or one of the organization's
 * custom roles), what it adds, and Change role as a searchable picker of every
 * role. A custom role can be on several teams; changing it here only changes
 * this team.
 */
export function SharedTeamRolePanel({ team }: { team: DenOrgTeam }) {
  const { orgContext, orgId, orgSlug } = useOrgDashboard();
  const help = useTeamSectionsHelp();
  const access = orgContext
    ? getOrgAccessFlags(orgContext.currentMember.role, orgContext.currentMember.isOwner, orgContext.currentMember.permissions)
    : null;
  const setsQuery = usePermissionSets(orgId, true);
  const sets = setsQuery.data ?? [];
  const customSets = sets.filter((set) => set.kind === "team");
  const teamSet = customSets.find((set) => roleSetTeams(set).some((entry) => entry.id === team.id)) ?? null;
  const adminSet = sets.find((set) => set.kind === "admin_default") ?? null;
  const memberSet = sets.find((set) => set.kind === "member_default") ?? null;
  const state: SharedTeamRoleState = { admin: team.grantsOrganizationAdmin, setId: teamSet?.id ?? null };
  const role = sharedTeamRole(state);

  const teamSetDetail = usePermissionSet(orgId, teamSet?.id ?? "", Boolean(teamSet));
  const adminSetDetail = usePermissionSet(orgId, adminSet?.id ?? "", Boolean(adminSet));
  const memberSetDetail = usePermissionSet(orgId, memberSet?.id ?? "", Boolean(memberSet && memberSet.allowedCount > 0));
  const adminKeys: PermissionKey[] = adminSetDetail.data ? allowedKeys(adminSetDetail.data.permissions) : permissionDefaultKeys("admin");
  const memberKeys: PermissionKey[] = memberSetDetail.data ? allowedKeys(memberSetDetail.data.permissions) : permissionDefaultKeys("member");
  const customKeys: PermissionKey[] = teamSetDetail.data ? allowedKeys(teamSetDetail.data.permissions) : [];
  const alsoKeys = (role.kind === "admin" ? adminKeys : role.kind === "custom" ? customKeys : []).filter((key) => !memberKeys.includes(key));
  const loading = setsQuery.isPending || (teamSet !== null && teamSetDetail.isPending);

  const otherTeams = teamSet ? roleSetTeams(teamSet).filter((entry) => entry.id !== team.id) : [];
  const title = role.kind === "custom" && teamSet ? teamSet.name : TEAM_ROLE_LABELS[role.kind];
  const description = role.kind === "admin"
    ? `Everyone in ${team.name} is an admin`
    : role.kind === "custom"
      ? otherTeams.length > 0 ? `Custom role, also on ${roleTeamNames(otherTeams)}` : "Custom role"
      : TEAM_ROLE_DESCRIPTIONS.member;
  const abilities: TeamRoleAbilities = {
    canManageAdminTeams: access?.canManageAdminTeams ?? false,
    canManagePermissions: access?.canManagePermissions ?? false,
  };

  return (
    <div className="flex flex-col gap-6" data-testid="team-role" data-role={role.kind}>
      {setsQuery.isError ? <DenNotice tone="error" message={setsQuery.error instanceof Error ? setsQuery.error.message : "Couldn't load this team's role."} /> : null}
      {help ? (
        <div className="-mb-3 flex items-center gap-1.5 px-1" data-testid="team-role-heading">
          <h2 className="text-[13px] font-medium text-gray-500">{`Role for ${team.name}`}</h2>
          <HelpTip label="Role">{TEAM_ROLE_HELP}</HelpTip>
        </div>
      ) : null}
      <ItemPanel>
        <div className="flex flex-wrap items-center gap-3.5 px-5 py-4">
          <IconTile icon={ShieldCheck} />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-[14px] font-medium leading-5 text-gray-900" title={title} data-testid="team-role-name">{loading ? <DenSkeleton className="h-5 w-28" /> : title}</span>
            {loading ? <DenSkeleton className="h-[18px] w-48" /> : <span className="text-[13px] leading-[18px] text-gray-500">{description}</span>}
          </span>
          <span className="flex max-w-full flex-wrap gap-2">
            {teamSet && role.kind === "custom" ? (
              <LinkButton size="sm" variant="secondary" href={getPermissionSetRoute(orgSlug, teamSet.id)} data-testid="team-role-open">Open role</LinkButton>
            ) : null}
            <RolePicker
              team={team}
              state={state}
              roles={roleList({ sets, readyMade: false })}
              showUnavailable={orgFeatureEnabled(orgContext, "readyMadeRoles")}
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
      ) : help && !setsQuery.isError ? (
        <ItemSection title={`${team.name} can also`} testId="team-role-also-none">
          <ItemPanel>
            <p className="px-5 py-4 text-[13px] leading-5 text-gray-600">{teamRoleAddsNothingLine(role.kind, team.name)}</p>
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
function RolePicker({ team, state, roles, showUnavailable, abilities, disabled, newRoleHref }: {
  team: DenOrgTeam;
  state: SharedTeamRoleState;
  roles: readonly RoleListEntry[];
  showUnavailable: boolean;
  abilities: TeamRoleAbilities;
  disabled: boolean;
  newRoleHref: string;
}) {
  const toast = useDenToast();
  const { orgId, updateTeam } = useOrgDashboard();
  const setTeamRole = useSetTeamRole(orgId ?? "");
  const current = sharedTeamRole(state);
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<SharedTeamRole>(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const options = teamRoleOptions({ roles, state, abilities, showUnavailable });
  const changed = !sameSharedTeamRole(choice, current);
  const chosenTitle = options.find((option) => option.value === sharedTeamRoleValue(choice))?.label ?? "";

  function close() {
    setOpen(false);
    setChoice(current);
    setError(null);
  }

  async function run(from: SharedTeamRoleState, to: SharedTeamRole) {
    for (const step of sharedTeamRoleSteps(from, to)) {
      if (step.kind === "set-admin") await updateTeam(team.id, { grantsOrganizationAdmin: step.value });
      else await setTeamRole.mutateAsync({ teamId: team.id, permissionSetId: step.setId });
    }
  }

  async function save() {
    if (!changed) return;
    const previous = current;
    const before = state;
    const after: SharedTeamRoleState = choice.kind === "admin"
      ? { admin: true, setId: null }
      : choice.kind === "custom" ? { admin: false, setId: choice.setId } : { admin: false, setId: null };
    setBusy(true);
    setError(null);
    try {
      await run(before, choice);
      setOpen(false);
        toast({
        title: `${team.name} is now ${chosenTitle}`,
        action: { label: "Undo", onClick: () => { void run(after, previous); } },
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't change the role.");
    } finally {
      setBusy(false);
    }
  }

  return <div className="w-[280px] max-w-full">
    <SearchableRolePicker
      value={sharedTeamRoleValue(choice)}
      onChange={(value) => setChoice(sharedTeamRoleFromValue(value) ?? current)}
      options={options} label={`Role for ${team.name}`} trigger="Change role" disabled={disabled}
      testId="team-role" open={open} onOpenChange={(next) => next ? (setChoice(current), setOpen(true)) : close()}
      footer={<>
        {error ? <DenNotice tone="error" message={error} /> : null}
        <Link href={newRoleHref} className="mb-2 inline-flex items-center gap-1.5 px-2 py-1 text-[12px] text-gray-700"><Plus className="h-3.5 w-3.5" aria-hidden />Create role</Link>
        <div className="flex min-w-0 justify-end gap-2">
          <DenButton size="sm" variant="secondary" onClick={close}>Cancel</DenButton>
          <DenButton size="sm" disabled={!changed} loading={busy} onClick={() => void save()} className="min-w-0" title={changed ? `Change to ${chosenTitle}` : undefined} data-testid="team-role-save">
            <span className="truncate">{changed ? `Change to ${chosenTitle}` : "Change role"}</span>
          </DenButton>
        </div>
      </>}
    />
  </div>;
}
