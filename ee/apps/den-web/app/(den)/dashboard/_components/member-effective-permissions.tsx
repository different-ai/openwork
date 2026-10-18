"use client";

import Link from "next/link";
import { getPermissionDefinition, isPermissionKey } from "@openwork/types/den/permissions";
import { DenButton } from "../../_components/ui/button";
import { DenNotice } from "../../_components/ui/notice";
import { getOrgAccessFlags, getPermissionSetRoute, orgFeatureEnabled, type DenOrgContext } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { useMemberPermissions, useSharedRolesOn, type MemberPermissions } from "./permissions-data";
import { PermissionAreaSection, PermissionRowsSkeleton, permissionAreas } from "./permissions-ui";
import { permissionSourceRoleLabel } from "./team-roles";

/**
 * Whether the signed-in member may see this member's effective permissions:
 * the feature is on, and they hold `permissions.view` or it is themselves.
 */
export function canViewMemberPermissions(orgContext: DenOrgContext | null, memberId: string): boolean {
  if (!orgContext || !orgFeatureEnabled(orgContext, "permissions")) return false;
  if (orgContext.currentMember.id === memberId) return true;
  return viewerCanViewPermissions(orgContext);
}

function viewerCanViewPermissions(orgContext: DenOrgContext): boolean {
  return getOrgAccessFlags(orgContext.currentMember.role, orgContext.currentMember.isOwner, orgContext.currentMember.permissions).canViewPermissions;
}

type Entry = MemberPermissions["permissions"][number];
type Source = Entry["sources"][number];

function SourceLink({ source, orgSlug, linked, teamRoles, sharedRoles }: { source: Source; orgSlug: string | null; linked: boolean; teamRoles: boolean; sharedRoles: boolean }) {
  // teamRoles: each source reads as the role that gives it.
  const label = teamRoles ? permissionSourceRoleLabel(source, { shared: sharedRoles }) : source.label;
  if (!source.setId || !linked) return <>{label}</>;
  return <Link className="underline-offset-2 hover:text-gray-900 hover:underline" href={getPermissionSetRoute(orgSlug, source.setId)}>{label}</Link>;
}

/** "Effective permissions" for one member, each with where it comes from. */
export function MemberEffectivePermissions({ memberId, memberName }: { memberId: string; memberName: string }) {
  const { orgId, orgSlug, orgContext } = useOrgDashboard();
  const canView = orgContext?.organization.id === orgId && canViewMemberPermissions(orgContext, memberId);
  const query = useMemberPermissions(orgId, memberId, canView);
  // Set pages need permissions.view; someone reading only their own sees plain labels.
  const linked = orgContext ? viewerCanViewPermissions(orgContext) : false;
  const teamRoles = orgContext ? orgFeatureEnabled(orgContext, "teamRoles") : false;
  const sharedRoles = useSharedRolesOn();

  // A retained panel must stop reading and hide cached private data immediately
  // when its organization or authorization changes.
  if (!canView) return <DenNotice tone="neutral" message="You can no longer view these permissions. Ask the organization owner for access." />;
  if (query.isPending) return <PermissionRowsSkeleton rows={4} label={`Loading permissions for ${memberName}`} />;
  if (query.isError) {
    return (
      <div className="flex flex-col items-start gap-2">
        <DenNotice tone="error" className="w-full" message={query.error instanceof Error ? query.error.message : "Couldn't load effective permissions."} />
        <DenButton variant="secondary" size="sm" disabled={query.isFetching} onClick={() => void query.refetch()}>Try again</DenButton>
      </div>
    );
  }

  const data = query.data;
  const byKey = new Map(data.permissions.flatMap((entry) => isPermissionKey(entry.key) ? [[entry.key, entry] satisfies [string, Entry]] : []));
  const areas = permissionAreas(new Set(byKey.keys()));

  return (
    <div className="flex flex-col gap-4" data-testid="member-effective-permissions" aria-label={`Effective permissions for ${memberName}`}>
      <p className="text-[13px] text-gray-600">
        {data.isOwner
          ? `${memberName} is the owner and can always do everything.`
          : byKey.size === 0
            ? `${memberName} has no organization permissions.`
            : `${memberName} has ${byKey.size} ${byKey.size === 1 ? "permission" : "permissions"}.`}
      </p>
      {data.isOwner ? null : areas.map((area) => (
        <PermissionAreaSection key={area.key} label={area.label}>
          {area.keys.map((key) => {
            const entry = byKey.get(key);
            if (!entry) return null;
            return (
              <div key={key} className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-0.5 py-1.5" data-testid="member-permission-row" data-permission-key={key}>
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-gray-900">{getPermissionDefinition(key).label}</span>
                <span className="text-[12px] text-gray-500">
                  {entry.sources.map((source, index) => (
                    <span key={`${source.kind}-${source.setId ?? index}`}>
                      {index > 0 ? ", " : null}
                      <SourceLink source={source} orgSlug={orgSlug} linked={linked} teamRoles={teamRoles} sharedRoles={sharedRoles} />
                    </span>
                  ))}
                </span>
              </div>
            );
          })}
        </PermissionAreaSection>
      ))}
    </div>
  );
}
