"use client";

import { Download } from "lucide-react";
import { useRouter } from "next/navigation";
import { DenButton } from "../../_components/ui/button";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

const OPEN_APP_URL = "openwork://open";

/**
 * Members have exactly one job on the dashboard: install the app. The
 * authenticated install guide resolves the active workspace directly, so no
 * bearer token needs to appear in the page URL or browser history.
 */
export function MemberDashboardScreen() {
  const router = useRouter();
  const { activeOrg } = useOrgDashboard();

  const orgName = activeOrg?.name ?? "Your workspace";

  return (
    <div className="flex min-h-[72vh] items-center justify-center px-4" data-testid="member-dashboard">
      <div className="flex min-w-0 w-full max-w-xl flex-col items-center pb-12 text-center">
        <h1 className="max-w-full wrap-anywhere text-[20px] font-semibold leading-normal tracking-[-0.02em] text-gray-950">
          {`${orgName} is set up for you`}
        </h1>

        <DenButton
          className="mt-8"
          data-testid="member-download-app"
          icon={Download}
          onClick={() => router.push("/install")}
        >
          Get OpenWork
        </DenButton>

        <p className="mt-3 max-w-md text-[13px] leading-5 text-gray-500">
          Your team&apos;s models and plugins are included when you sign in.
        </p>

        <p className="mt-10 w-full border-t border-gray-100 pt-5 text-[13px] text-gray-500">
          Already installed?{" "}
          <a href={OPEN_APP_URL} className="font-medium text-gray-900 underline-offset-2 hover:underline">
            Open OpenWork
          </a>
        </p>
      </div>
    </div>
  );
}
