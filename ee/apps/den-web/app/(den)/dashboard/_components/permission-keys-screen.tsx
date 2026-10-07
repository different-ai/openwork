"use client";

import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { getPermissionDefinition, isPermissionKey } from "@openwork/types/den/permissions";
import { DenButton } from "../../_components/ui/button";
import { DenNotice } from "../../_components/ui/notice";
import { getPermissionKeyRoute, getPermissionKeysRoute, getPermissionSetRoute, getPermissionsRoute } from "../../_lib/den-org";
import { PermissionsRequestError, usePermissionKeyStatus } from "./permissions-data";
import {
  PermissionAreaSection,
  PermissionDescription,
  PermissionRowsSkeleton,
  PermissionStatusLabel,
  PermissionsAccessState,
  PermissionsPage,
  permissionAreas,
  usePermissionsAccess,
} from "./permissions-ui";

const rowClass = "group flex min-h-11 items-center gap-3 py-2 transition-colors hover:bg-gray-50/70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-400";

/** Every permission by area; each opens its status across sets. */
export function PermissionKeysScreen() {
  const permissions = usePermissionsAccess();
  if (permissions.state !== "ready") {
    return <PermissionsPage title="By permission" testId="permission-keys"><PermissionsAccessState access={permissions} /></PermissionsPage>;
  }
  return (
    <PermissionsPage title="By permission" back={{ href: getPermissionsRoute(permissions.orgSlug), label: "Permissions" }} testId="permission-keys">
      <div className="flex flex-col gap-6">
        {permissionAreas().map((area) => (
          <PermissionAreaSection key={area.key} label={area.label}>
            {area.keys.map((key) => {
              const definition = getPermissionDefinition(key);
              return (
                <Link key={key} href={getPermissionKeyRoute(permissions.orgSlug, key)} className={rowClass} data-testid="permission-key-row" data-permission-key={key}>
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-gray-900">{definition.label}</span>
                  {definition.sensitive ? <span className="shrink-0 text-[12px] text-gray-500">Needs a recent sign-in</span> : null}
                  <ChevronRight className="size-4 shrink-0 text-gray-300 transition-colors group-hover:text-gray-500" aria-hidden="true" strokeWidth={1.5} />
                </Link>
              );
            })}
          </PermissionAreaSection>
        ))}
      </div>
    </PermissionsPage>
  );
}

const SET_KIND_ORDER = { member_default: 0, admin_default: 1, team: 2 } as const;

/** One permission's status in Member, Admin and every team's permissions. */
export function PermissionKeyScreen({ permissionKey }: { permissionKey: string }) {
  const permissions = usePermissionsAccess();
  const ready = permissions.state === "ready" ? permissions : null;
  const query = usePermissionKeyStatus(ready?.orgId ?? null, permissionKey);
  const title = isPermissionKey(permissionKey) ? getPermissionDefinition(permissionKey).label : "Permission";

  if (!ready) {
    return <PermissionsPage title={title} testId="permission-key"><PermissionsAccessState access={permissions} /></PermissionsPage>;
  }
  const back = { href: getPermissionKeysRoute(ready.orgSlug), label: "By permission" };
  const sets = [...(query.data?.sets ?? [])].sort((a, b) => SET_KIND_ORDER[a.kind] - SET_KIND_ORDER[b.kind]);
  const allowedCount = sets.filter((set) => set.status === "allow").length;

  return (
    <PermissionsPage
      title={<span className="inline-flex items-center gap-1">{title}{isPermissionKey(permissionKey) ? <PermissionDescription permissionKey={permissionKey} /> : null}</span>}
      back={back}
      caption={query.data ? `Allowed in ${allowedCount} of ${sets.length}` : undefined}
      testId="permission-key"
    >
      {query.isError ? (
        <div className="flex flex-col items-start gap-2">
          <DenNotice
            tone="error"
            className="w-full"
            message={query.error instanceof PermissionsRequestError && query.error.code === "permission_not_found"
              ? "This permission doesn't exist. Go back to see every permission."
              : query.error instanceof Error ? query.error.message : "Couldn't load this permission."}
          />
          <DenButton variant="secondary" size="sm" disabled={query.isFetching} onClick={() => void query.refetch()}>Try again</DenButton>
        </div>
      ) : !query.data ? (
        <PermissionRowsSkeleton rows={3} />
      ) : (
        <PermissionAreaSection label="Where it's allowed" testId="permission-key-sets">
          {sets.map((set) => (
            <Link key={set.id} href={getPermissionSetRoute(ready.orgSlug, set.id)} className={rowClass} data-testid="permission-key-set-row" data-status={set.status}>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-[13px] font-medium text-gray-900">{set.name}</span>
                {set.kind === "team" ? <span className="truncate text-[12px] text-gray-500">{set.team?.name ?? "A deleted team"} team</span> : null}
              </span>
              <PermissionStatusLabel status={set.status} locked={set.locked} />
              <ChevronRight className="size-4 shrink-0 text-gray-300 transition-colors group-hover:text-gray-500" aria-hidden="true" strokeWidth={1.5} />
            </Link>
          ))}
        </PermissionAreaSection>
      )}
    </PermissionsPage>
  );
}
