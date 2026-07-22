"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

export function McpConnectionsCapabilityGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { orgContext, orgBusy } = useOrgDashboard();
  const enabled = orgContext?.capabilities.mcpConnections === true;

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

  return <>{children}</>;
}
