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
  isSuperAdminRole,
  permissionLockReason,
} from "../../_lib/den-org";
import { permissionCountLabel, roleHeldByLabel, roleList, type BuiltInRoleId } from "../../_lib/role-catalog";
import { useFeatureIntro } from "../_features/feature-intros";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { IconTile } from "./access-rows";
import { ItemMenu, ItemPanel, ItemRow, ItemRowsSkeleton, ItemSection } from "./item-list";
import { usePermissionSets } from "./permissions-data";

/**
 * Built-in roles and custom roles, each with who holds it. The rows come from
 * the organization's one role list (`roleList`), the same list the role
 * pickers show.
 * `showIntro` (Members › Roles) lets the custom roles intro take the empty list's place.
 */
export function RolesTab({ action, showIntro = false }: { action?: ReactNode; showIntro?: boolean }) {
  const { orgContext, orgId, orgSlug } = useOrgDashboard();
  if (!orgContext) return null;
  const access = getOrgAccessFlags(orgContext.currentMember.role, orgContext.currentMember.isOwner, orgContext.currentMember.permissions);

  return <RolesTabContent orgId={orgId} orgSlug={orgSlug} canViewSets={access.canViewPermissions} action={action} showIntro={showIntro} />;
}

/** Whether the signed-in person can create a role (a team and its permission set). */
export function canCreateRole(input: { canManageTeams: boolean; canManagePermissions: boolean }): boolean {
  return input.canManageTeams && input.canManagePermissions;
}

function RolesTabContent({ orgId, orgSlug, canViewSets, action, showIntro }: {
  orgId: string | null;
  orgSlug: string | null;
  canViewSets: boolean;
  action?: ReactNode;
  showIntro: boolean;
}) {
  const { orgContext } = useOrgDashboard();
  const setsQuery = usePermissionSets(orgId, canViewSets);
  const [filter, setFilter] = useState("");
  if (!orgContext) return null;

  const matches = (name: string) => name.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase());
  const sets = setsQuery.data ?? [];
  const roles = roleList({ sets });
  const builtInRoles = roles.flatMap((role) => role.kind === "built_in" && matches(role.label) ? [role] : []);
  const customRoles = roles.flatMap((role) => role.kind === "custom" && matches(role.label) ? [role] : []);
  // Known, unfiltered count of custom roles for the intro; null while loading, filtering or not allowed.
  const customRoleCount = canViewSets && setsQuery.data && !filter.trim() ? roles.filter((role) => role.kind === "custom").length : null;

  const owner = orgContext.members.find((member) => member.isOwner);
  const directAdmins = orgContext.members.filter((member) => !member.isOwner && member.userId !== null && member.role === "admin").length;
  const superAdmins = orgContext.members.filter((member) => !member.isOwner && member.userId !== null && isSuperAdminRole(member.role)).length;
  // Only teams and people still in the organization count.
  const teamNames = (teams: readonly { id: string }[]) => teams.flatMap((entry) => orgContext.teams.find((team) => team.id === entry.id)?.name ?? []);
  const peopleCount = (memberIds: readonly string[]) => memberIds.filter((id) => orgContext.members.some((member) => member.id === id)).length;
  const linked = (id: BuiltInRoleId) => roles.find((role) => role.kind === "built_in" && role.id === id);
  // A team that holds Super admin is an Admin team too; it is listed once, under Super admin.
  const superAdminTeamIds = new Set((linked("super-admin")?.teams ?? []).map((team) => team.id));
  const adminTeams = orgContext.teams.filter((team) => team.grantsOrganizationAdmin && !superAdminTeamIds.has(team.id));
  /** Who holds each built-in role. A new built-in role doesn't compile until it says who. */
  const heldBy: Record<BuiltInRoleId, string | undefined> = {
    member: "Everyone",
    admin: roleHeldByLabel(directAdmins, adminTeams.map((team) => team.name)),
    "billing-manager": canViewSets ? roleHeldByLabel(peopleCount(linked("billing-manager")?.directMemberIds ?? []), teamNames(linked("billing-manager")?.teams ?? [])) : undefined,
    "super-admin": roleHeldByLabel(superAdmins, teamNames(linked("super-admin")?.teams ?? [])),
    owner: owner ? (owner.user.name || owner.user.email) : undefined,
  };

  return (
    <div data-testid="roles-tab">
      <MemberListToolbar collection="roles" value={filter} onChange={setFilter}
        action={action ?? <DenButton size="sm" icon={LockKeyhole} disabled title={permissionLockReason("permissions.manage")}>Create role</DenButton>}
        secondary={canViewSets ? <ItemMenu label="Role list actions" entries={[{ label: "By permission", href: getPermissionKeysRoute(orgSlug) }]} /> : undefined}
      />
      <div className="flex flex-col gap-6">
      <ItemSection title="Built-in roles" testId="roles-built-in">
        <ItemPanel>
          {builtInRoles.length === 0 ? <p className="px-5 py-6 text-[13px] text-gray-500">No built-in roles match your filter.</p> : null}
          {builtInRoles.map((role) => (
            <ItemRow
              key={role.id}
              logo={<IconTile icon={ShieldCheck} />}
              title={role.label}
              description={role.summary}
              status={heldBy[role.id]}
              href={role.setId ? getPermissionSetRoute(orgSlug, role.setId) : undefined}
              testId={`role-row-${role.id}`}
            />
          ))}
        </ItemPanel>
      </ItemSection>

      {/* With feature intros on and no custom roles yet, the intro replaces "No custom roles yet" (DESIGN.md I1). */}
      <RolesIntroGate enabled={showIntro} customRoles={customRoleCount}>
      <ItemSection title="Custom roles" testId="roles-custom">
        {!canViewSets ? (
          <DenNotice tone="neutral" icon={LockKeyhole} message={permissionLockReason("permissions.view")} />
        ) : setsQuery.isPending ? (
          <ItemPanel><ItemRowsSkeleton label="Loading custom roles" rows={2} /></ItemPanel>
        ) : setsQuery.isError ? (
          <DenNotice tone="error" message={setsQuery.error instanceof Error ? setsQuery.error.message : "Couldn't load custom roles."} />
        ) : customRoles.length === 0 ? (
          <ItemPanel>
            <div className="px-5 py-6 text-[13px] text-gray-500" data-testid="roles-custom-empty">{filter.trim() ? "No custom roles match your filter." : "No custom roles yet."}</div>
          </ItemPanel>
        ) : (
          <ItemPanel>
            {customRoles.map((role) => (
              <ItemRow
                key={role.setId}
                logo={<IconTile icon={Users} />}
                title={role.label}
                description={permissionCountLabel(role.allowedCount)}
                status={roleHeldByLabel(peopleCount(role.directMemberIds), teamNames(role.teams))}
                href={getPermissionSetRoute(orgSlug, role.setId)}
                testId="role-row-custom"
              />
            ))}
          </ItemPanel>
        )}
      </ItemSection>
      </RolesIntroGate>
      </div>
    </div>
  );
}

function RolesIntroGate({ enabled, customRoles, children }: { enabled: boolean; customRoles: number | null; children: ReactNode }) {
  if (!enabled) return <>{children}</>;
  return <RolesIntro customRoles={customRoles}>{children}</RolesIntro>;
}

/** The box sits in the section list's gap, so it drops its own top margin. */
function RolesIntro({ customRoles, children }: { customRoles: number | null; children: ReactNode }) {
  const intro = useFeatureIntro("members.roles", customRoles === null ? null : { customRoles });
  if (intro.size === "box") return <div className="-mt-6">{intro.element}</div>;
  return <>{children}</>;
}
