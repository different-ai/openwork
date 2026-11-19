"use client";

import { useState } from "react";
import { DenButton } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";
import { DenNotice } from "../../_components/ui/notice";
import { useDenToast } from "./den-toast";
import { useRenameRole, type PermissionSetDetail } from "./permissions-data";
import type { PermissionsAccess } from "./permissions-ui";

type ReadyAccess = Extract<PermissionsAccess, { state: "ready" }>;

/** A custom role's name, renamed in place. */
export function RoleNameField({ ready, set }: { ready: ReadyAccess; set: PermissionSetDetail }) {
  const toast = useDenToast();
  const rename = useRenameRole(ready.orgId, set.id);
  const [name, setName] = useState(set.name);
  const trimmed = name.trim();
  const changed = trimmed.length > 0 && trimmed !== set.name;
  const canManage = ready.access.canManagePermissions;

  async function save() {
    if (!changed) return;
    try {
      await rename.mutateAsync(trimmed);
      toast({ title: `Renamed to ${trimmed}` });
    } catch {
      return;
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor="role-name" className="text-[13px] font-medium text-gray-700">Role name</label>
      <div className="flex items-center gap-2">
        <DenInput
          id="role-name"
          className="max-w-sm"
          value={name}
          maxLength={120}
          disabled={!canManage}
          onChange={(event) => { rename.reset(); setName(event.target.value); }}
          onKeyDown={(event) => { if (event.key === "Enter") void save(); }}
          data-testid="role-name"
        />
        {changed ? <DenButton size="sm" loading={rename.isPending} onClick={() => void save()} data-testid="role-name-save">Rename</DenButton> : null}
      </div>
      {rename.error ? <DenNotice tone="error" message={rename.error.message} /> : null}
    </div>
  );
}
