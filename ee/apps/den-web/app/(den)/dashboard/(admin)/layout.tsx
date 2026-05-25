"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { getOrgAccessFlags } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

export default function AdminDashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const { orgContext, orgBusy } = useOrgDashboard();
  const access = getOrgAccessFlags(
    orgContext?.currentMember.role ?? "member",
    orgContext?.currentMember.isOwner ?? false,
  );

  useEffect(() => {
    if (orgContext && !access.isAdmin) {
      router.replace("/dashboard");
    }
  }, [access.isAdmin, orgContext, router]);

  if (orgBusy || !orgContext) {
    return (
      <div className="flex min-h-[320px] items-center justify-center px-6 text-[14px] text-gray-500">
        Checking workspace access...
      </div>
    );
  }

  if (!access.isAdmin) {
    return (
      <div className="flex min-h-[320px] items-center justify-center px-6 text-[14px] text-gray-500">
        Redirecting to your dashboard...
      </div>
    );
  }

  return children;
}
