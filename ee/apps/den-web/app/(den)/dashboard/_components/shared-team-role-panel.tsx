"use client";

import Link from "next/link";
import { useState } from "react";
import { Check, Plus, ShieldCheck } from "lucide-react";
import { getPermissionDefinition, permissionDefaultKeys, type PermissionKey } from "@openwork/types/den/permissions";
import { DenButton } from "../../_components/ui/button";
import { DenNotice } from "../../_components/ui/notice";
import { DenSkeleton } from "../../_components/ui/skeleton";
import { getNewRoleRoute, getOrgAccessFlags, getPermissionSetRoute, type DenOrgTeam } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { IconTile } from "./access-rows";
import { RolePicker as SearchableRolePicker } from "./role-picker";
import { useDenToast } from "./den-toast";
import { ItemPanel, ItemRow, ItemRowsSkeleton, ItemSection, LinkButton } from "./item-list";
import { usePermissionSet, usePermissionSets, useSetTeamRole, type PermissionSetSummary } from "./permissions-data";
import {
  TEAM_ROLE_DESCRIPTIONS,
  TEAM_ROLE_LABELS,
  allowedKeys,
  sameSharedTeamRole,
  sharedTeamRole,
  sharedTeamRoleLockReason,
  sharedTeamRoleSteps,
  type SharedTeamRole,
  type SharedTeamRoleState,
  type TeamRoleAbilities,
} from "./team-roles";

/** Teams a set applies to (older responses only carry `team`). */
function setTeams(set: PermissionSetSummary): { id: string; name: string | null }[] {
  return set.teams.length > 0 ? set.teams : set.team ? [set.team] : [];
}

function teamNames(teams: readonly { name: string | null }[]): string {
  return teams.map((team) => team.name ?? "A deleted team").join(", ");
}

/**
 * sharedRoles: a team's one role (Member, Admin, or one of the organization's
 * custom roles), what it adds, and Change role as a searchable picker of every
 * role. A custom role can be on several teams; changing it here only changes
 * this team.
 */
export function SharedTeamRolePanel({ team }: { team: DenOrgTeam }) {
  const { orgContext, orgId, orgSlug } = useOrgDashboard();
  const access = orgContext
    ? getOrgAccessFlags(orgContext.currentMember.role, orgContext.currentMember.isOwner, orgContext.currentMember.permissions)
    : null;
  const setsQuery = usePermissionSets(orgId, true);
  const sets = setsQuery.data ?? [];
  const customSets = sets.filter((set) => set.kind === "team");
  const teamSet = customSets.find((set) => setTeams(set).some((entry) => entry.id === team.id)) ?? null;
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

  const otherTeams = teamSet ? setTeams(teamSet).filter((entry) => entry.id !== team.id) : [];
  const title = role.kind === "custom" && teamSet ? teamSet.name : TEAM_ROLE_LABELS[role.kind];
  const description = role.kind === "admin"
    ? `Everyone in ${team.name} is an admin`
    : role.kind === "custom"
      ? otherTeams.length > 0 ? `Custom role, also on ${teamNames(otherTeams)}` : "Custom role"
      : TEAM_ROLE_DESCRIPTIONS.member;
  const abilities: TeamRoleAbilities = {
    canManageAdminTeams: access?.canManageAdminTeams ?? false,
    canManagePermissions: access?.canManagePermissions ?? false,
  };

  return (
    <div className="flex flex-col gap-6" data-testid="team-role" data-role={role.kind}>
      {setsQuery.isError ? <DenNotice tone="error" message={setsQuery.error instanceof Error ? setsQuery.error.message : "Couldn't load this team's role."} /> : null}
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
              customSets={customSets}
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

type PickerOption = { role: SharedTeamRole; title: string; description: string };

/** Change role: every role in one searchable list, opened under the button. */
function RolePicker({ team, state, customSets, abilities, disabled, newRoleHref }: {
  team: DenOrgTeam;
  state: SharedTeamRoleState;
  customSets: PermissionSetSummary[];
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

  const builtIn: PickerOption[] = [
    { role: { kind: "member" }, title: TEAM_ROLE_LABELS.member, description: TEAM_ROLE_DESCRIPTIONS.member },
    { role: { kind: "admin" }, title: TEAM_ROLE_LABELS.admin, description: "Invite people, manage teams, and run connections and models" },
  ];
  const custom: PickerOption[] = customSets.map((set) => {
    const teams = setTeams(set);
    return {
      role: { kind: "custom", setId: set.id },
      title: set.name,
      description: teams.length ? `On ${teamNames(teams)}` : "No teams yet",
    };
  });
  const changed = !sameSharedTeamRole(choice, current);
  const chosenTitle = [...builtIn, ...custom].find((option) => sameSharedTeamRole(option.role, choice))?.title ?? "";

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

  const options = [...builtIn, ...custom].map((option) => ({
    value: option.role.kind === "custom" ? option.role.setId : option.role.kind,
    label: option.title,
    caption: option.description,
    lockReason: sameSharedTeamRole(option.role, current) ? null : sharedTeamRoleLockReason(state, option.role, abilities),
    disabled: !sameSharedTeamRole(option.role, current) && sharedTeamRoleLockReason(state, option.role, abilities) !== null,
  }));
  return <div className="w-[280px] max-w-full">
    <SearchableRolePicker
      value={choice.kind === "custom" ? choice.setId : choice.kind}
      onChange={(value) => setChoice(value === "member" ? { kind: "member" } : value === "admin" ? { kind: "admin" } : { kind: "custom", setId: value })}
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
