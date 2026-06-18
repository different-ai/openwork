"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { getApiKeysRoute, getOrgAccessFlags } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

export default function AdminDashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { orgContext, orgBusy } = useOrgDashboard();
  const access = getOrgAccessFlags(
    orgContext?.currentMember.role ?? "member",
    orgContext?.currentMember.isOwner ?? false,
    orgContext?.roles,
  );
  const canUseAdminRoute = access.isAdmin || (pathname === getApiKeysRoute() && access.canManageApiKeys);

  useEffect(() => {
    if (orgContext && !canUseAdminRoute) {
      router.replace("/dashboard");
    }
  }, [canUseAdminRoute, orgContext, router]);

  if (orgBusy || !orgContext) {
    return (
      <div className="flex min-h-[320px] items-center justify-center px-6 text-[14px] text-gray-500">
        Checking workspace access...
      </div>
    );
  }

  if (!canUseAdminRoute) {
    return (
      <div className="flex min-h-[320px] items-center justify-center px-6 text-[14px] text-gray-500">
        Redirecting to your dashboard...
      </div>
    );
  }

  return children;
}
