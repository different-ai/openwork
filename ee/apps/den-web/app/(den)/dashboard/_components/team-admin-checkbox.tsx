"use client";

import { useState } from "react";
import { DenNotice } from "../../_components/ui/notice";
import { getOrgAccessFlags, type DenOrgTeam } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

export function TeamAdminCheckbox({ team }: { team: DenOrgTeam }) {
  const { orgContext, updateTeam, mutationBusy } = useOrgDashboard();
  const [error, setError] = useState<string | null>(null);
  const canManageRoles = orgContext && getOrgAccessFlags(orgContext.currentMember.role, orgContext.currentMember.isOwner).canManageRoles;
  return (
    <div className="mt-3 grid gap-2 text-[13px]">
      <label className="flex items-start gap-2 text-gray-700">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={team.grantsOrganizationAdmin}
          disabled={!canManageRoles || mutationBusy === "update-team"}
          onChange={async (event) => {
            setError(null);
            try {
              await updateTeam(team.id, { grantsOrganizationAdmin: event.target.checked });
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : "Could not update team Admin access.");
            }
          }}
        />
        <span>Grant organisation Admin to all members of {team.name}</span>
      </label>
      <p className="text-[12px] text-gray-500">
        Only owners and super-admins can change this. Admin access is inherited while a member belongs to this team; individual roles are unchanged.
        {team.managedByScim ? " Membership is managed by your identity provider. Disabling SCIM mapping or removing its group or provider clears this grant and requires reapproval." : ""}
      </p>
      {error ? <DenNotice tone="error" message={error} /> : null}
    </div>
  );
}
