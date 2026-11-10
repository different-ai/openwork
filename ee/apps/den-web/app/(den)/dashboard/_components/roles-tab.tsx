"use client";

import { LockKeyhole, ShieldCheck, ShieldPlus, Users } from "lucide-react";
import { type ReactNode, useState } from "react";
import { DenButton } from "../../_components/ui/button";
import { MemberListToolbar } from "./member-list-toolbar";
import { DenNotice } from "../../_components/ui/notice";
import {
  getNewRoleRoute,
  getOrgAccessFlags,
  getPermissionKeysRoute,
  getPermissionSetRoute,
  isSuperAdminRole,
  orgFeatureEnabled,
  permissionLockReason,
} from "../../_lib/den-org";
import { roleList, roleTeamNames, type BuiltInRoleId } from "../../_lib/role-catalog";
import { useFeatureIntro } from "../_features/feature-intros";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { IconTile } from "./access-rows";
import { ItemMenu, ItemPanel, ItemRow, ItemRowsSkeleton, ItemSection, LinkButton } from "./item-list";
import { usePermissionSets } from "./permissions-data";

function peopleLabel(count: number): string {
  return `${count} ${count === 1 ? "person" : "people"}`;
}

/**
 * Built-in roles, named custom roles (which can apply to several teams) and,
 * with readyMadeRoles, the ready-made roles nobody has created yet. The rows
 * come from the organization's one role list (`roleList`), the same list the
 * role pickers show.
 * `showIntro` (Members › Roles) lets the custom roles intro take the empty list's place.
 */
export function RolesTab({ action, showIntro = false }: { action?: ReactNode; showIntro?: boolean }) {
  const { orgContext, orgId, orgSlug } = useOrgDashboard();
  if (!orgContext) return null;
  const access = getOrgAccessFlags(orgContext.currentMember.role, orgContext.currentMember.isOwner, orgContext.currentMember.permissions);

  const createLock = canCreateRole(access) ? null : permissionLockReason(access.canManagePermissions ? "teams.manage" : "permissions.manage");
  return <RolesTabContent orgId={orgId} orgSlug={orgSlug} canViewSets={access.canViewPermissions} createLock={createLock} action={action} showIntro={showIntro} />;
}

/** Whether the signed-in person can create a role (a team and its permission set). */
export function canCreateRole(input: { canManageTeams: boolean; canManagePermissions: boolean }): boolean {
  return input.canManageTeams && input.canManagePermissions;
}

function RolesTabContent({ orgId, orgSlug, canViewSets, createLock, action, showIntro }: {
  orgId: string | null;
  orgSlug: string | null;
  canViewSets: boolean;
  /** Why the person can't create a role, or null when they can. */
  createLock: string | null;
  action?: ReactNode;
  showIntro: boolean;
}) {
  const { orgContext } = useOrgDashboard();
  const setsQuery = usePermissionSets(orgId, canViewSets);
  const [filter, setFilter] = useState("");
  if (!orgContext) return null;

  const matches = (name: string) => name.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase());
  const sets = setsQuery.data ?? [];
  // Ready-made roles need the custom roles to tell which already exist.
  const roles = roleList({ sets, readyMade: orgFeatureEnabled(orgContext, "readyMadeRoles") && canViewSets && setsQuery.data !== undefined });
  const builtInRoles = roles.flatMap((role) => role.kind === "built_in" && matches(role.label) ? [role] : []);
  const customRoles = roles.flatMap((role) => role.kind === "custom" && matches(role.label) ? [role] : []);
  const readyMadeRoles = roles.flatMap((role) => role.kind === "ready_made" && matches(role.label) ? [role] : []);
  // Known, unfiltered count of custom roles for the intro; null while loading, filtering or not allowed.
  const customRoleCount = canViewSets && setsQuery.data && !filter.trim() ? roles.filter((role) => role.kind === "custom").length : null;

  const owner = orgContext.members.find((member) => member.isOwner);
  const directAdmins = orgContext.members.filter((member) => !member.isOwner && member.userId !== null && member.role === "admin").length;
  const superAdmins = orgContext.members.filter((member) => !member.isOwner && member.userId !== null && isSuperAdminRole(member.role)).length;
  const adminTeams = orgContext.teams.filter((team) => team.grantsOrganizationAdmin);
  /** Who holds each built-in role. A new built-in role doesn't compile until it says who. */
  const heldBy: Record<BuiltInRoleId, string | undefined> = {
    member: "Everyone",
    admin: [directAdmins > 0 ? peopleLabel(directAdmins) : null, ...adminTeams.map((team) => team.name)].filter(Boolean).join(", ") || "Nobody yet",
    "super-admin": superAdmins > 0 ? peopleLabel(superAdmins) : "Nobody yet",
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
            {customRoles.map((role) => {
              const teams = role.teams.filter((entry) => orgContext.teams.some((team) => team.id === entry.id));
              return (
                <ItemRow
                  key={role.setId}
                  logo={<IconTile icon={Users} />}
                  title={role.label}
                  description={`${role.allowedCount} ${role.allowedCount === 1 ? "permission" : "permissions"}`}
                  status={teams.length > 0 ? roleTeamNames(teams) : "No teams yet"}
                  href={getPermissionSetRoute(orgSlug, role.setId)}
                  testId="role-row-custom"
                />
              );
            })}
          </ItemPanel>
        )}
      </ItemSection>
      </RolesIntroGate>

      {/* readyMadeRoles: roles to create in one step. Create role opens with the role's name and permissions filled in (C2). */}
      {readyMadeRoles.length > 0 ? (
      <ItemSection title="Ready-made roles" testId="roles-ready-made">
        <ItemPanel>
          {readyMadeRoles.map((role) => {
            const href = `${getNewRoleRoute(orgSlug)}?start=${role.id}`;
            return (
              <ItemRow
                key={role.id}
                logo={<IconTile icon={ShieldPlus} />}
                title={role.label}
                description={role.summary}
                wideAction
                // Locked, with why and who can change it (P4, C5).
                action={createLock
                  ? <DenButton size="sm" variant="secondary" icon={LockKeyhole} disabled title={createLock}>Create role</DenButton>
                  : <LinkButton size="sm" href={href} data-testid={`role-ready-made-create-${role.id}`}>Create role</LinkButton>}
                testId={`role-row-ready-made-${role.id}`}
              />
            );
          })}
        </ItemPanel>
      </ItemSection>
      ) : null}
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
