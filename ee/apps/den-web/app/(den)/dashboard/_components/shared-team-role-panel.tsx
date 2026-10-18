"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Check, Plus, ShieldCheck } from "lucide-react";
import { getPermissionDefinition } from "@openwork/types/den/permissions";
import { DenButton } from "../../_components/ui/button";
import { DenNotice } from "../../_components/ui/notice";
import { DenSkeleton } from "../../_components/ui/skeleton";
import { getNewRoleRoute, getOrgAccessFlags, getPermissionSetRoute, permissionLockReason, type DenOrgTeam } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { IconTile } from "./access-rows";
import { RolePicker } from "./role-picker";
import { useDenToast } from "./den-toast";
import { ItemPanel, ItemRow, ItemRowsSkeleton, ItemSection, LinkButton } from "./item-list";
import { usePermissionSet, usePermissionSets, useSetTeamRole, type PermissionSetSummary } from "./permissions-data";
import { allowedKeys, permissionSetTeams } from "./team-roles";
import { TeamAdminCheckbox } from "./team-admin-checkbox";

/** Custom roles and organization Admin are independent grants, each saved by one request. */
export function SharedTeamRolePanel({ team }: { team: DenOrgTeam }) {
  const { orgContext, orgId, orgSlug } = useOrgDashboard();
  const access = orgContext ? getOrgAccessFlags(orgContext.currentMember.role, orgContext.currentMember.isOwner, orgContext.currentMember.permissions) : null;
  const canView = access?.canViewPermissions ?? false;
  const setsQuery = usePermissionSets(orgId, canView);
  const customSets = (setsQuery.data ?? []).filter((set) => set.kind === "team");
  const teamSet = customSets.find((set) => permissionSetTeams(set).some((entry) => entry.id === team.id)) ?? null;
  const memberSet = setsQuery.data?.find((set) => set.kind === "member_default");
  const teamDetail = usePermissionSet(orgId, teamSet?.id ?? "", canView && Boolean(teamSet));
  const memberDetail = usePermissionSet(orgId, memberSet?.id ?? "", canView && Boolean(memberSet));
  // Do not combine unrelated projections, even if a malformed response parses.
  const teamData = teamDetail.data?.id === teamSet?.id && teamDetail.data?.kind === "team" && permissionSetTeams(teamDetail.data).some((entry) => entry.id === team.id) ? teamDetail.data : null;
  const memberData = memberDetail.data?.id === memberSet?.id && memberDetail.data?.kind === "member_default" ? memberDetail.data : null;
  const verified = canView && setsQuery.isSuccess && Boolean(memberData) && memberDetail.isSuccess && (!teamSet || Boolean(teamData) && teamDetail.isSuccess);
  const loading = canView && (setsQuery.isPending || Boolean(teamSet && teamDetail.isPending) || Boolean(memberSet && memberDetail.isPending));
  const failed = canView && !loading && !verified;
  const canShowRole = canView && Boolean(setsQuery.data) && Boolean(memberData) && (!teamSet || Boolean(teamData));
  const title = canShowRole ? teamSet?.name ?? "No custom role" : "Role not verified";
  const extraKeys = verified && teamData && memberData ? allowedKeys(teamData.permissions).filter((key) => !allowedKeys(memberData.permissions).includes(key)) : [];
  async function retry() { await setsQuery.refetch(); if (teamSet) await teamDetail.refetch(); if (memberSet) await memberDetail.refetch(); }

  if (!canView) return <div className="grid gap-4"><TeamAdminCheckbox team={team} /><DenNotice tone="neutral" message={permissionLockReason("permissions.view")} /></div>;
  return <div className="flex flex-col gap-6" data-testid="team-role" data-role={verified ? teamSet ? "custom" : "member" : "unknown"}>
    <TeamAdminCheckbox team={team} />
    {!canView ? <DenNotice tone="neutral" message={permissionLockReason("permissions.view")} /> : null}
    {failed ? <DenNotice tone="error" message={setsQuery.data ? `Couldn't verify this team's role. Last verified ${new Date(setsQuery.dataUpdatedAt).toLocaleString()}. Changes are blocked until verification succeeds.` : "Couldn't verify this team's role. Changes are blocked until verification succeeds."} action={<DenButton size="sm" variant="secondary" onClick={() => void retry()}>Try again</DenButton>} /> : null}
    <ItemPanel>
      <div className="flex flex-wrap items-center gap-3.5 px-5 py-4">
        <IconTile icon={ShieldCheck} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="break-words text-[14px] font-medium leading-5 text-gray-900" data-testid="team-role-name">{loading && !setsQuery.data ? <DenSkeleton className="h-5 w-28" /> : title}</span>
          <span className="text-[13px] text-gray-500">{!canShowRole ? "Custom permissions not verified" : teamSet ? "Custom role" : "Only permissions available to everyone"}</span>
        </span>
        <span className="flex max-w-full flex-wrap gap-2">
          {canShowRole && teamSet ? <LinkButton size="sm" variant="secondary" href={getPermissionSetRoute(orgSlug, teamSet.id)}>Open role</LinkButton> : null}
          {canShowRole ? <CustomRolePicker team={team} setId={teamSet?.id ?? null} customSets={customSets} disabled={!verified} canManage={access?.canManagePermissions ?? false} newRoleHref={getNewRoleRoute(orgSlug)} /> : <DenButton size="sm" variant="secondary" disabled data-testid="team-role-change">Change custom role</DenButton>}
        </span>
      </div>
    </ItemPanel>
    {loading ? <ItemPanel><ItemRowsSkeleton label="Loading what this team can do" rows={3} /></ItemPanel> : extraKeys.length ? <ItemSection title={`${team.name}'s custom role allows`} testId="team-role-also"><ItemPanel>{extraKeys.map((key) => <ItemRow key={key} logo={<span aria-hidden className="flex size-8 items-center justify-center"><Check className="size-4" /></span>} title={getPermissionDefinition(key).label} />)}</ItemPanel></ItemSection> : null}
  </div>;
}

function CustomRolePicker({ team, setId, customSets, disabled, canManage, newRoleHref }: {
  team: DenOrgTeam; setId: string | null; customSets: PermissionSetSummary[]; disabled: boolean; canManage: boolean; newRoleHref: string;
}) {
  const { orgId } = useOrgDashboard();
  const saveRole = useSetTeamRole(orgId ?? "");
  const toast = useDenToast();
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<string | null>(setId);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const currentName = customSets.find((set) => set.id === setId)?.name;
  const chosenName = customSets.find((set) => set.id === choice)?.name ?? "No custom role";
  const changed = choice !== setId;
  async function save() {
    if (!changed || disabled || !canManage) return;
    try {
      await saveRole.mutateAsync({ teamId: team.id, permissionSetId: choice });
      if (!active.current) return;
      setOpen(false);
      toast({ title: choice ? `Assigned ${chosenName} to ${team.name}` : `Removed ${currentName} from ${team.name}` });
    } catch { /* Keep the selection and the actual error in place. */ }
  }
  return <div className="w-[280px] max-w-full"><RolePicker
    value={choice ?? "member"} onChange={(value) => { saveRole.reset(); setChoice(value === "member" ? null : value); }}
    options={[{ value: "member", label: "No custom role", caption: "Keeps permissions available to everyone" }, ...customSets.map((set) => ({ value: set.id, label: set.name, caption: permissionSetTeams(set).map((entry) => entry.name ?? "A deleted team").join(", ") || "No teams yet" }))].map((option) => ({ ...option, disabled: !canManage, lockReason: canManage ? null : permissionLockReason("permissions.manage") }))}
    label={`Custom role for ${team.name}`} trigger="Change custom role" disabled={disabled || saveRole.isPending}
    testId="team-role" open={open} onOpenChange={(next) => { if (!saveRole.isPending) { setChoice(setId); saveRole.reset(); setOpen(next); } }}
    footer={<>
      {changed ? <p className="mb-2 break-words text-[13px] text-gray-600">{currentName ? `${currentName} will be removed from ${team.name}. ` : ""}{choice ? `${chosenName} will apply to everyone in this team. ` : ""}Organization Admin access stays {team.grantsOrganizationAdmin ? "on" : "off"}.</p> : null}
      {saveRole.error ? <DenNotice tone="error" message={saveRole.error.message} /> : null}
      <Link href={newRoleHref} className="mb-2 inline-flex items-center gap-1.5 px-2 py-1 text-[12px] text-gray-700"><Plus className="size-3.5" aria-hidden />Create role</Link>
      <div className="flex justify-end gap-2"><DenButton size="sm" variant="secondary" disabled={saveRole.isPending} onClick={() => setOpen(false)}>Cancel</DenButton><DenButton size="sm" disabled={!changed || !canManage || disabled} loading={saveRole.isPending} onClick={() => void save()} data-testid="team-role-save">{choice ? "Assign role" : "Remove custom role"}</DenButton></div>
    </>}
  /></div>;
}
