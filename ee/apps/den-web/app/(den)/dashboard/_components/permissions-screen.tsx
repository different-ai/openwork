"use client";

import Link from "next/link";
import { ChevronRight, LockKeyhole, Plus } from "lucide-react";
import { PERMISSION_KEYS } from "@openwork/types/den/permissions";
import { DenButton } from "../../_components/ui/button";
import { DenNotice } from "../../_components/ui/notice";
import {
  getNewTeamPermissionsRoute,
  getPermissionKeysRoute,
  getPermissionSetRoute,
  permissionLockReason,
} from "../../_lib/den-org";
import { LinkButton } from "./item-list";
import { usePermissionSets, type PermissionSetSummary } from "./permissions-data";
import {
  PermissionAreaSection,
  PermissionRowsSkeleton,
  PermissionsAccessState,
  PermissionsPage,
  usePermissionsAccess,
} from "./permissions-ui";

function plural(count: number, one: string, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

/** Who a set applies to, as state (DESIGN.md P1). */
export function appliesToSummary(set: PermissionSetSummary): string {
  const appliesTo = set.appliesTo;
  if (appliesTo.kind === "everyone") return `Everyone in the organization, ${plural(appliesTo.memberCount, "member")}`;
  if (appliesTo.kind === "admins") {
    const teams = appliesTo.adminTeams.length;
    if (teams === 0 && appliesTo.directAdminCount === 0) return "Admins and Admin teams, none yet";
    return teams > 0
      ? `Admins and Admin teams, ${plural(appliesTo.directAdminCount, "admin")} and ${plural(teams, "Admin team")}`
      : `Admins and Admin teams, ${plural(appliesTo.directAdminCount, "admin")}`;
  }
  const teamName = appliesTo.team?.name ?? "A deleted team";
  return `${teamName} team, ${plural(appliesTo.memberCount, "member")}`;
}

function PermissionSetRow({ set, href }: { set: PermissionSetSummary; href: string }) {
  return (
    <Link
      href={href}
      data-testid="permission-set-row"
      data-permission-set-kind={set.kind}
      className="group flex min-h-12 items-center gap-3 py-2 transition-colors hover:bg-gray-50/70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-400"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[13px] font-medium text-gray-900">{set.name}</span>
        <span className="truncate text-[12px] text-gray-500">{appliesToSummary(set)}</span>
      </div>
      <span className="shrink-0 text-[12px] text-gray-700">{set.allowedCount} of {PERMISSION_KEYS.length} allowed</span>
      <ChevronRight className="size-4 shrink-0 text-gray-300 transition-colors group-hover:text-gray-500" aria-hidden="true" strokeWidth={1.5} />
    </Link>
  );
}

export function PermissionsScreen() {
  const permissions = usePermissionsAccess();
  const ready = permissions.state === "ready" ? permissions : null;
  const setsQuery = usePermissionSets(ready?.orgId ?? null, ready !== null);
  const byPermission = ready ? <LinkButton href={getPermissionKeysRoute(ready.orgSlug)} variant="secondary" size="sm">By permission</LinkButton> : undefined;

  if (!ready) {
    return <PermissionsPage title="Permissions" testId="permissions-landing"><PermissionsAccessState access={permissions} /></PermissionsPage>;
  }

  const canManage = ready.access.canManagePermissions;
  const sets = setsQuery.data ?? [];
  const defaults = sets.filter((set) => set.kind !== "team");
  const teamSets = sets.filter((set) => set.kind === "team");
  const newButton = canManage ? (
    <LinkButton href={getNewTeamPermissionsRoute(ready.orgSlug)} variant="secondary" size="sm" data-testid="new-team-permissions">
      <Plus className="size-3.5" aria-hidden="true" />
      Create team permissions
    </LinkButton>
  ) : (
    <DenButton variant="secondary" size="sm" icon={LockKeyhole} disabled aria-describedby="permissions-read-only">Create team permissions</DenButton>
  );

  return (
    <PermissionsPage title="Permissions" action={byPermission} testId="permissions-landing">
      {!canManage ? <DenNotice tone="neutral" icon={LockKeyhole} message={<span id="permissions-read-only">Read only. {permissionLockReason("permissions.manage")}</span>} /> : null}
      {setsQuery.isError ? (
        <div className="flex flex-col items-start gap-2">
          <DenNotice tone="error" message={setsQuery.error instanceof Error ? setsQuery.error.message : "Couldn't load permissions."} className="w-full" />
          <DenButton variant="secondary" size="sm" disabled={setsQuery.isFetching} onClick={() => void setsQuery.refetch()}>Try again</DenButton>
        </div>
      ) : setsQuery.isPending ? (
        <PermissionRowsSkeleton rows={4} />
      ) : (
        <>
          <div className="flex flex-col gap-2">
            <PermissionAreaSection label="Defaults" testId="permissions-defaults">
              {defaults.map((set) => <PermissionSetRow key={set.id} set={set} href={getPermissionSetRoute(ready.orgSlug, set.id)} />)}
            </PermissionAreaSection>
            <p className="inline-flex items-center gap-1.5 text-[12px] text-gray-500">
              <LockKeyhole className="size-3.5" aria-hidden="true" strokeWidth={1.5} />
              The owner can always do everything.
            </p>
          </div>
          <PermissionAreaSection label="Team permissions" meta={newButton} testId="permissions-teams">
            {teamSets.length === 0 ? (
              <div className="flex min-h-12 items-center py-3 text-[13px] text-gray-500" data-testid="permissions-teams-empty">
                No team permissions yet.
              </div>
            ) : teamSets.map((set) => <PermissionSetRow key={set.id} set={set} href={getPermissionSetRoute(ready.orgSlug, set.id)} />)}
          </PermissionAreaSection>
        </>
      )}
    </PermissionsPage>
  );
}
