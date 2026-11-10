"use client";

import { DenNotice } from "../../../_components/ui/notice";
import { DenSwitch } from "../../../_components/ui/switch";
import { getOrgAccessFlags, permissionLockReason } from "../../../_lib/den-org";
import { useOrgDashboard } from "../../_providers/org-dashboard-provider";
import { useConfigBlobSettings, useUpdateConfigBlobSettings } from "./config-blobs-data";

/** Settings › Config › Overview: rules for reviewing config changes. */
export function ConfigSettingsSection() {
  const { orgId, orgContext } = useOrgDashboard();
  const settings = useConfigBlobSettings(orgId);
  const update = useUpdateConfigBlobSettings(orgId);
  const canManage = orgContext
    ? getOrgAccessFlags(orgContext.currentMember.role, orgContext.currentMember.isOwner, orgContext.currentMember.permissions).canManageSettings
    : false;
  const checked = settings.data?.settings.requireSecondApprover ?? false;

  return (
    <section className="flex flex-col gap-4" aria-labelledby="config-review-title" data-testid="config-settings">
      <h2 id="config-review-title" className="text-[15px] font-semibold tracking-[-0.1px] text-gray-950">Review</h2>
      <div className="flex min-h-12 items-center justify-between gap-4">
        <div className="min-w-0">
          <p id="config-second-approver-label" className="text-[13px] font-medium text-gray-900">Require a second approver</p>
          <p className="text-[12px] text-gray-500">
            {canManage
              ? "Changes need two approvals from different people. The second can't come from the person who uploaded the change."
              : `Read only. ${permissionLockReason("organization.update")}`}
          </p>
        </div>
        <DenSwitch
          aria-label="Require a second approver"
          checked={checked}
          disabled={!canManage || !settings.data || update.isPending}
          onChange={(next) => update.mutate({ requireSecondApprover: next })}
          testId="config-require-second-approver"
        />
      </div>
      {settings.isError ? <DenNotice tone="error" message={settings.error.message} /> : null}
      {update.isError ? <DenNotice tone="error" message={update.error.message} /> : null}
    </section>
  );
}
