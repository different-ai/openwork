"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Check, ShieldCheck } from "lucide-react";
import { getPermissionDefinition, permissionDefaultKeys } from "@openwork/types/den/permissions";
import { DenButton } from "../../_components/ui/button";
import { DenNotice } from "../../_components/ui/notice";
import { getOrgAccessFlags, getPermissionSetRoute, orgFeatureEnabled, permissionLockReason, type DenOrgTeam } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { IconTile } from "./access-rows";
import { useDenToast } from "./den-toast";
import { ItemPanel, ItemRow, ItemRowsSkeleton, ItemSection, LinkButton } from "./item-list";
import { useCreateTeamPermissions, usePermissionSet, usePermissionSets, useRemoveTeamPermissions } from "./permissions-data";
import { EVERYONE_CAN, allowedKeys, permissionSetTeams } from "./team-roles";
import { TeamAdminCheckbox } from "./team-admin-checkbox";

/** Each independently stored grant has its own action; no multi-request role replacement. */
export function TeamRolePanel({ team }: { team: DenOrgTeam }) {
  const { orgContext, orgId, orgSlug } = useOrgDashboard();
  const feature = orgContext ? orgFeatureEnabled(orgContext, "permissions") : false;
  const access = orgContext ? getOrgAccessFlags(orgContext.currentMember.role, orgContext.currentMember.isOwner, orgContext.currentMember.permissions) : null;
  const canView = access?.canViewPermissions ?? false;
  const sets = usePermissionSets(orgId, feature && canView);
  const teamSet = sets.data?.find((set) => set.kind === "team" && permissionSetTeams(set).some((entry) => entry.id === team.id));
  const memberSet = sets.data?.find((set) => set.kind === "member_default");
  const teamDetail = usePermissionSet(orgId, teamSet?.id ?? "", feature && canView && Boolean(teamSet));
  const memberDetail = usePermissionSet(orgId, memberSet?.id ?? "", feature && canView && Boolean(memberSet));
  const teamData = teamDetail.data?.id === teamSet?.id && teamDetail.data?.kind === "team" && permissionSetTeams(teamDetail.data).some((entry) => entry.id === team.id) ? teamDetail.data : null;
  const memberData = memberDetail.data?.id === memberSet?.id && memberDetail.data?.kind === "member_default" ? memberDetail.data : null;
  const verified = !feature || canView && sets.isSuccess && memberDetail.isSuccess && Boolean(memberData) && (!teamSet || teamDetail.isSuccess && Boolean(teamData));
  const loading = feature && canView && (sets.isPending || Boolean(teamSet && teamDetail.isPending) || Boolean(memberSet && memberDetail.isPending));
  const canShowRole = !feature || canView && Boolean(sets.data) && Boolean(memberData) && (!teamSet || Boolean(teamData));
  const memberKeys = !feature ? permissionDefaultKeys("member") : verified && memberData ? allowedKeys(memberData.permissions) : [];
  const customKeys = verified && teamData ? allowedKeys(teamData.permissions).filter((key) => !memberKeys.includes(key)) : [];
  const [showAll, setShowAll] = useState(false);
  const create = useCreateTeamPermissions(orgId ?? "");
  const remove = useRemoveTeamPermissions(orgId ?? "", teamSet?.id ?? "");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const toast = useDenToast();
  const router = useRouter();
  const busy = create.isPending || remove.isPending;
  const canManage = feature && verified && (access?.canManagePermissions ?? false);
  async function retry() { await sets.refetch(); if (teamSet) await teamDetail.refetch(); if (memberSet) await memberDetail.refetch(); }
  async function createRole() {
    if (!canManage) return;
    try {
      const set = await create.mutateAsync({ teamId: team.id, permissions: [] });
      router.push(getPermissionSetRoute(orgSlug, set.id));
    } catch { /* The draft and error remain visible. */ }
  }
  async function removeRole() {
    if (!canManage || !teamSet) return;
    try { await remove.mutateAsync(); setConfirmRemove(false); toast({ title: `Removed custom permissions from ${team.name}` }); } catch { /* Retain confirmation for retry. */ }
  }
  if (feature && !canView) return <div className="grid gap-4"><TeamAdminCheckbox team={team} /><DenNotice tone="neutral" message={permissionLockReason("permissions.view")} /></div>;
  return <div className="flex flex-col gap-6" data-testid="team-role" data-role={verified ? teamSet ? "custom" : "member" : "unknown"}>
    <TeamAdminCheckbox team={team} />
    {feature && !canView ? <DenNotice tone="neutral" message={permissionLockReason("permissions.view")} /> : null}
    {feature && canView && !loading && !verified ? <DenNotice tone="error" message={sets.data ? `Couldn't verify this team's permissions. Last verified ${new Date(sets.dataUpdatedAt).toLocaleString()}. Changes are blocked.` : "Couldn't verify this team's permissions. Changes are blocked."} action={<DenButton variant="secondary" size="sm" onClick={() => void retry()}>Try again</DenButton>} /> : null}
    <ItemPanel>
      <div className="flex flex-wrap items-center gap-3.5 px-5 py-4">
        <IconTile icon={ShieldCheck} />
        <span className="min-w-0 flex-1 break-words text-[14px] font-medium text-gray-900" data-testid="team-role-name">{!canShowRole ? "Role not verified" : teamSet ? "Custom permissions" : "No custom role"}</span>
        <span className="flex max-w-full flex-wrap gap-2">
          {canShowRole && teamSet ? <LinkButton size="sm" variant="secondary" href={getPermissionSetRoute(orgSlug, teamSet.id)} data-testid="team-role-edit">Edit permissions</LinkButton> : null}
          <DenButton size="sm" variant="secondary" disabled={!canManage || busy} title={!canManage ? feature ? permissionLockReason("permissions.manage") : "Custom roles need Permissions, an Enterprise feature." : undefined} onClick={() => teamSet ? setConfirmRemove(true) : void createRole()}>{teamSet ? "Remove custom role" : "Create custom role"}</DenButton>
        </span>
      </div>
      {confirmRemove && teamSet ? <div className="grid gap-3 border-t border-gray-100 px-5 py-4">
        <p className="text-[13px] text-gray-600">{team.name} will lose its custom permissions. Organization Admin access stays {team.grantsOrganizationAdmin ? "on" : "off"}. This cannot be undone.</p>
        <div className="flex flex-wrap justify-end gap-2"><DenButton size="sm" variant="secondary" disabled={busy} onClick={() => setConfirmRemove(false)}>Cancel</DenButton><DenButton size="sm" variant="destructive" disabled={!canManage} loading={busy} onClick={() => void removeRole()}>Remove custom role</DenButton></div>
      </div> : null}
    </ItemPanel>
    {create.error || remove.error ? <DenNotice tone="error" message={create.error?.message ?? remove.error?.message ?? "Couldn't save custom permissions."} /> : null}
    {loading ? <ItemPanel><ItemRowsSkeleton label="Loading what this team can do" rows={3} /></ItemPanel> : customKeys.length ? <ItemSection title={`${team.name}'s custom role allows`} testId="team-role-also"><ItemPanel>
      {(showAll ? customKeys : customKeys.slice(0, 6)).map((key) => <ItemRow key={key} logo={<CheckMark />} title={getPermissionDefinition(key).label} />)}
      {customKeys.length > 6 ? <div className="px-5 py-2.5"><DenButton variant="ghost" size="xs" onClick={() => setShowAll(!showAll)} aria-expanded={showAll}>{showAll ? "Show fewer" : `Show all ${customKeys.length}`}</DenButton></div> : null}
    </ItemPanel></ItemSection> : null}
    {verified ? <ItemSection title="Everyone can" testId="team-role-everyone"><ItemPanel>{EVERYONE_CAN.map((label) => <ItemRow key={label} logo={<CheckMark />} title={label} />)}{memberKeys.map((key) => <ItemRow key={key} logo={<CheckMark />} title={getPermissionDefinition(key).label} />)}</ItemPanel></ItemSection> : null}
  </div>;
}

function CheckMark() { return <span aria-hidden className="flex size-8 items-center justify-center text-gray-900"><Check className="size-4" /></span>; }
