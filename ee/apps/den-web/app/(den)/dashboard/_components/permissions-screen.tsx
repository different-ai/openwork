"use client";

import { Plus } from "lucide-react";
import { DenButton } from "../../_components/ui/button";
import { getNewRoleRoute } from "../../_lib/den-org";
import { RolesTab, canCreateRole } from "./roles-tab";
import { PermissionsAccessState, PermissionsPage, usePermissionsAccess } from "./permissions-ui";

export function PermissionsScreen() {
  const permissions = usePermissionsAccess();
  if (permissions.state !== "ready") {
    return <PermissionsPage title="Roles" testId="permissions-landing"><PermissionsAccessState access={permissions} /></PermissionsPage>;
  }
  const create = canCreateRole({ canManageTeams: permissions.access.canManageTeams, canManagePermissions: permissions.access.canManagePermissions })
    ? <DenButton icon={Plus} href={getNewRoleRoute(permissions.orgSlug)} data-testid="roles-create">Create role</DenButton>
    : undefined;
  // Settings › Roles (only when Members is hidden) reuses the Members › Roles intro: a box in place of
  // "No custom roles yet" with feature intros on, unchanged with them off.
  return <PermissionsPage title="Roles" testId="permissions-landing"><RolesTab action={create} showIntro /></PermissionsPage>;
}
