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
  permissionLockReason,
} from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { IconTile } from "./access-rows";
import { ItemMenu, ItemPanel, ItemRow, ItemRowsSkeleton, ItemSection } from "./item-list";
import { usePermissionSets } from "./permissions-data";
import { ADMIN_ROLE_SUMMARY } from "./team-roles";

function peopleLabel(count: number): string {
  return `${count} ${count === 1 ? "person" : "people"}`;
}

/** Built-in roles and named custom roles, which can apply to several teams. */
export function RolesTab({ action }: { action?: ReactNode }) {
  const { orgContext, orgId, orgSlug } = useOrgDashboard();
  if (!orgContext) return null;
  const access = getOrgAccessFlags(orgContext.currentMember.role, orgContext.currentMember.isOwner, orgContext.currentMember.permissions);

  return <RolesTabContent orgId={orgId} orgSlug={orgSlug} canViewSets={access.canViewPermissions} action={action} />;
}

/** Whether the signed-in person can create a role (a team and its permission set). */
export function canCreateRole(input: { canManageTeams: boolean; canManagePermissions: boolean }): boolean {
  return input.canManageTeams && input.canManagePermissions;
}

function RolesTabContent({ orgId, orgSlug, canViewSets, action }: {
  orgId: string | null;
  orgSlug: string | null;
  canViewSets: boolean;
  action?: ReactNode;
}) {
  const { orgContext } = useOrgDashboard();
  const setsQuery = usePermissionSets(orgId, canViewSets);
  const [filter, setFilter] = useState("");
  if (!orgContext) return null;

  const matches = (name: string) => name.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase());
  const sets = setsQuery.data ?? [];
  const memberSet = sets.find((set) => set.kind === "member_default");
  const adminSet = sets.find((set) => set.kind === "admin_default");
  const teamSets = sets.filter((set) => set.kind === "team" && matches(set.name));

  const owner = orgContext.members.find((member) => member.isOwner);
  const directAdmins = orgContext.members.filter((member) => !member.isOwner && member.userId !== null && member.role === "admin").length;
  const adminTeams = orgContext.teams.filter((team) => team.grantsOrganizationAdmin);
  const adminWho = [directAdmins > 0 ? peopleLabel(directAdmins) : null, ...adminTeams.map((team) => team.name)].filter(Boolean).join(", ") || "Nobody yet";

  return (
    <div data-testid="roles-tab">
      <MemberListToolbar collection="roles" value={filter} onChange={setFilter}
        action={action ?? <DenButton size="sm" icon={LockKeyhole} disabled title={permissionLockReason("permissions.manage")}>Create role</DenButton>}
        secondary={canViewSets ? <ItemMenu label="Role list actions" entries={[{ label: "By permission", href: getPermissionKeysRoute(orgSlug) }]} /> : undefined}
      />
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
            status={adminWho}
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
        {!canViewSets ? (
          <DenNotice tone="neutral" icon={LockKeyhole} message={permissionLockReason("permissions.view")} />
        ) : setsQuery.isPending ? (
          <ItemPanel><ItemRowsSkeleton label="Loading custom roles" rows={2} /></ItemPanel>
        ) : setsQuery.isError ? (
          <DenNotice tone="error" message={setsQuery.error instanceof Error ? setsQuery.error.message : "Couldn't load custom roles."} />
        ) : teamSets.length === 0 ? (
          <ItemPanel>
            <div className="px-5 py-6 text-[13px] text-gray-500" data-testid="roles-custom-empty">{filter.trim() ? "No custom roles match your filter." : "No custom roles yet."}</div>
          </ItemPanel>
        ) : (
          <ItemPanel>
            {teamSets.map((set) => {
              const teams = (set.teams.length > 0 ? set.teams : set.team ? [set.team] : []).filter((entry) => orgContext.teams.some((team) => team.id === entry.id));
              return (
                <ItemRow
                  key={set.id}
                  logo={<IconTile icon={Users} />}
                  title={set.name}
                  description={`${set.allowedCount} ${set.allowedCount === 1 ? "permission" : "permissions"}`}
                  status={teams.length > 0 ? teams.map((entry) => entry.name).join(", ") : "No teams yet"}
                  href={getPermissionSetRoute(orgSlug, set.id)}
                  testId="role-row-custom"
                />
              );
            })}
          </ItemPanel>
        )}
      </ItemSection>
      </div>
    </div>
  );
}
