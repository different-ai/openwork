"use client";

import { LockKeyhole, ShieldCheck, Users } from "lucide-react";
import { type ReactNode, useState } from "react";
import { DenButton } from "../../_components/ui/button";
import { MemberListToolbar } from "./member-list-toolbar";
import { DenNotice } from "../../_components/ui/notice";
import {
  getOrgAccessFlags,
  getPermissionKeysRoute,
  getPermissionSetRoute,
  getTeamRoute,
  orgFeatureEnabled,
  permissionLockReason,
} from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { IconTile } from "./access-rows";
import { FilterInput, ItemMenu, ItemPanel, ItemRow, ItemRowsSkeleton, ItemSection, LinkButton } from "./item-list";
import { usePermissionSets, useSharedRolesOn } from "./permissions-data";
import { ADMIN_ROLE_SUMMARY } from "./team-roles";
import { AccessSummary } from "./access-source-summary";

const ROLE_PAGE_SIZE = 50;


function peopleLabel(count: number): string {
  return `${count} ${count === 1 ? "person" : "people"}`;
}

/**
 * Members › Roles (teamRoles). The built-in roles, and each team's custom
 * role, read from what Den already stores: member roles, Admin teams, and team
 * permission sets. Creating a role makes a team and its permission set.
 */
export function RolesTab({ action }: { action?: ReactNode }) {
  const { orgContext, orgId, orgSlug } = useOrgDashboard();
  if (!orgContext) return null;
  const access = getOrgAccessFlags(orgContext.currentMember.role, orgContext.currentMember.isOwner, orgContext.currentMember.permissions);
  const permissionsFeature = orgFeatureEnabled(orgContext, "permissions");
  return <RolesTabContent key={orgId} orgId={orgId} orgSlug={orgSlug} permissionsFeature={permissionsFeature} canViewSets={permissionsFeature && access.canViewPermissions} action={action} />;
}

/** Whether the signed-in person can create a role (a team and its permission set). */
export function canCreateRole(input: { permissionsFeature: boolean; canManageTeams: boolean; canManagePermissions: boolean }): boolean {
  return input.permissionsFeature && input.canManageTeams && input.canManagePermissions;
}

function RolesTabContent({ orgId, orgSlug, permissionsFeature, canViewSets, action }: {
  orgId: string | null;
  orgSlug: string | null;
  permissionsFeature: boolean;
  canViewSets: boolean;
  action?: ReactNode;
}) {
  const { orgContext } = useOrgDashboard();
  const setsQuery = usePermissionSets(orgId, canViewSets);
  // sharedRoles: a custom role has its own name and can be on several teams.
  const sharedRoles = useSharedRolesOn();
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(0);
  const changeFilter = (value: string) => { setFilter(value); setPage(0); };
  if (!orgContext) return null;
  const listToolbars = orgFeatureEnabled(orgContext, "memberListToolbars");
  const matches = (name: string) => name.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase());
  const sets = setsQuery.data ?? [];
  const memberSet = sets.find((set) => set.kind === "member_default");
  const adminSet = sets.find((set) => set.kind === "admin_default");
  const teamSets = sets.filter((set) => set.kind === "team" && (set.team || set.teams.length > 0 || sharedRoles) && matches(set.name));

  const currentPage = Math.min(page, Math.max(0, Math.ceil(teamSets.length / ROLE_PAGE_SIZE) - 1));
  const shownSets = teamSets.slice(currentPage * ROLE_PAGE_SIZE, (currentPage + 1) * ROLE_PAGE_SIZE);
  const owner = orgContext.members.find((member) => member.isOwner);
  const directAdmins = orgContext.members.filter((member) => !member.isOwner && member.userId !== null && member.role === "admin").length;
  const adminTeams = orgContext.teams.filter((team) => team.grantsOrganizationAdmin);
  const adminWho = [...(directAdmins > 0 ? [peopleLabel(directAdmins)] : []), ...adminTeams.map((team) => team.name)];

  const byPermission = canViewSets ? <LinkButton href={getPermissionKeysRoute(orgSlug)} variant="secondary" data-testid="roles-by-permission">By permission</LinkButton> : null;

  return (
    <div data-testid="roles-tab">
      {listToolbars ? <MemberListToolbar collection="roles" value={filter} onChange={changeFilter}
        action={action ?? <DenButton size="sm" icon={LockKeyhole} disabled title={permissionLockReason("permissions.manage")}>Create role</DenButton>}
        secondary={canViewSets ? <ItemMenu label="Role list actions" entries={[{ label: "By permission", href: getPermissionKeysRoute(orgSlug) }]} /> : undefined}
      /> : <div className="mb-6 flex flex-wrap items-center justify-between gap-2"><FilterInput value={filter} onChange={changeFilter} placeholder="Filter roles" /> <div className="flex gap-2">{byPermission}{action}</div></div>}
      <div className="flex flex-col gap-6">
      <ItemSection title="Built-in roles" testId="roles-built-in">
        <ItemPanel>
          {!["Member", "Admin", "Owner"].some(matches) ? <p className="px-5 py-6 text-[13px] text-gray-500">No built-in roles match your filter.</p> : null}
          {matches("Member") ? (
          <ItemRow
            logo={<IconTile icon={ShieldCheck} />}
            title="Member"
            description="What everyone can do"
            status="Everyone"
            href={memberSet ? getPermissionSetRoute(orgSlug, memberSet.id) : undefined}
            testId="role-row-member"
          />
          ) : null}
          {matches("Admin") ? (
          <ItemRow
            logo={<IconTile icon={ShieldCheck} />}
            title="Admin"
            description={ADMIN_ROLE_SUMMARY}
            status={<AccessSummary items={adminWho} label="Admin access sources" empty="Nobody yet" />}
            statusOnNarrow wrapStatus
            href={adminSet ? getPermissionSetRoute(orgSlug, adminSet.id) : undefined}
            testId="role-row-admin"
          />
          ) : null}
          {matches("Owner") ? (
          <ItemRow
            logo={<IconTile icon={ShieldCheck} />}
            title="Owner"
            description="Can do everything"
            status={owner ? (owner.user.name || owner.user.email) : undefined}
            testId="role-row-owner"
          />
          ) : null}
        </ItemPanel>
      </ItemSection>

      <ItemSection title="Custom roles" testId="roles-custom">
        {!permissionsFeature ? (
          <DenNotice tone="neutral" icon={LockKeyhole} message="Custom roles need Permissions, an Enterprise feature." />
        ) : !canViewSets ? (
          <DenNotice tone="neutral" icon={LockKeyhole} message={permissionLockReason("permissions.view")} />
        ) : setsQuery.isPending ? (
          <ItemPanel><ItemRowsSkeleton label="Loading custom roles" rows={2} /></ItemPanel>
        ) : setsQuery.isError ? (
          <DenNotice tone="error" message="Couldn't verify the complete role list. Try again before choosing a role." action={<DenButton size="sm" variant="secondary" loading={setsQuery.isFetching} onClick={() => void setsQuery.refetch()}>Try again</DenButton>} />
        ) : teamSets.length === 0 ? (
          <ItemPanel>
            <div className="px-5 py-6 text-[13px] text-gray-500" data-testid="roles-custom-empty">{listToolbars && filter.trim() ? "No custom roles match your filter." : "No custom roles yet."}</div>
          </ItemPanel>
        ) : (
          <ItemPanel>
            {shownSets.map((set) => {
              if (sharedRoles) {
                const teams = set.teams.length > 0 ? set.teams : set.team ? [set.team] : [];
                return (
                  <ItemRow
                    key={set.id}
                    logo={<IconTile icon={Users} />}
                    title={set.name}
                    description={`${set.allowedCount} ${set.allowedCount === 1 ? "permission" : "permissions"}`}
                    status={<AccessSummary items={teams.map((entry) => entry.name ?? "Unnamed team")} label={`Teams with ${set.name}`} empty="No teams yet" />}
                    statusOnNarrow wrapStatus
                    href={getPermissionSetRoute(orgSlug, set.id)}
                    testId="role-row-custom"
                  />
                );
              }
              const team = orgContext.teams.find((entry) => entry.id === set.team?.id);
              const memberCount = team?.memberIds.length ?? (set.appliesTo.kind === "team" ? set.appliesTo.memberCount : 0);
              return (
                <ItemRow
                  key={set.id}
                  logo={<IconTile icon={Users} />}
                  title={team?.name ?? set.team?.name ?? set.name}
                  description={`${set.allowedCount} ${set.allowedCount === 1 ? "permission" : "permissions"}`}
                  status={peopleLabel(memberCount)}
                  href={team ? getTeamRoute(orgSlug, team.id) : getPermissionSetRoute(orgSlug, set.id)}
                  testId="role-row-custom"
                />
              );
            })}
          </ItemPanel>
        )}
        {canViewSets && setsQuery.isSuccess ? <div className="flex flex-wrap items-center justify-between gap-2 text-[12px] text-gray-500" data-testid="roles-completeness">
          <span>{teamSets.length ? `${currentPage * ROLE_PAGE_SIZE + 1}–${Math.min((currentPage + 1) * ROLE_PAGE_SIZE, teamSets.length)} of ${teamSets.length}` : "0"} custom roles{filter.trim() ? " matching your filter" : ""}; all roles loaded</span>
          {teamSets.length > ROLE_PAGE_SIZE ? <div className="flex gap-2"><DenButton size="sm" variant="secondary" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous roles</DenButton><DenButton size="sm" variant="secondary" disabled={(currentPage + 1) * ROLE_PAGE_SIZE >= teamSets.length} onClick={() => setPage(currentPage + 1)}>Next roles</DenButton></div> : null}
        </div> : null}
      </ItemSection>
      </div>
    </div>
  );
}
