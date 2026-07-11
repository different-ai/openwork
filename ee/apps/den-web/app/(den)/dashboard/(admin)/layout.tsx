"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Loader2, ShieldCheck } from "lucide-react";
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
      <div className="flex min-h-[420px] items-center justify-center px-6" data-testid="admin-access-state" data-access-state="checking">
        <div className="w-full max-w-sm rounded-2xl border border-gray-200 bg-white p-6 shadow-[0_12px_40px_-28px_rgba(15,23,42,0.35)]">
          <div className="flex items-start gap-4">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-gray-100 text-gray-600">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            </div>
            <div>
              <p className="text-[15px] font-medium text-gray-950">Checking workspace access</p>
              <p className="mt-1 text-[13px] leading-5 text-gray-500">We’re confirming which settings are available to your account.</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!canUseAdminRoute) {
    return (
      <div className="flex min-h-[420px] items-center justify-center px-6" data-testid="admin-access-state" data-access-state="redirecting">
        <div className="w-full max-w-sm rounded-2xl border border-gray-200 bg-white p-6 shadow-[0_12px_40px_-28px_rgba(15,23,42,0.35)]">
          <div className="flex items-start gap-4">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700">
              <ShieldCheck className="size-5" aria-hidden="true" />
            </div>
            <div>
              <p className="text-[15px] font-medium text-gray-950">Your workspace is ready</p>
              <p className="mt-1 text-[13px] leading-5 text-gray-500">This setting is managed by workspace admins. Taking you back to your dashboard.</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return children;
}
