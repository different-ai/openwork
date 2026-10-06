"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { FEATURES } from "@openwork/features";
import { DenNotice } from "../../_components/ui/notice";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

const deprecation = FEATURES.orgManagedDashboards.deprecated;
const removalDate = new Date(`${deprecation.removeBy}T00:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

/** Org-managed Dashboards are enabled per organization; old links bounce Home. */
export function OrgManagedDashboardsCapabilityGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { orgContext, orgBusy } = useOrgDashboard();
  const enabled = orgContext?.capabilities.orgManagedDashboards === true;

  useEffect(() => {
    if (orgContext && !enabled) {
      router.replace("/dashboard");
    }
  }, [enabled, orgContext, router]);

  if (orgBusy || !orgContext) {
    return (
      <div className="flex min-h-[320px] items-center justify-center px-6 text-[14px] text-gray-500">
        Checking workspace access...
      </div>
    );
  }

  if (!enabled) {
    return (
      <div className="flex min-h-[320px] items-center justify-center px-6 text-[14px] text-gray-500">
        Redirecting to your dashboard...
      </div>
    );
  }

  return (
    <>
      {/* Deprecation notice from the feature registry (packages/features/src/registry.ts). */}
      <div className="px-6 pt-6">
        <DenNotice tone="warning" message={`Organization-managed dashboards will be removed on ${removalDate}. Members keep their own Dashboard in the desktop app.`} />
      </div>
      {children}
    </>
  );
}
