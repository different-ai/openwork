import type { Metadata } from "next";
import { headers } from "next/headers";
import { joinBaseUrl, readBaseUrlEnv } from "@openwork/types/url";

import { getManagedBrandIconUrl, orgFeatureEnabled, parseOrgContextPayload } from "../_lib/den-org";
import { DenToastProvider } from "./_components/den-toast";
import { OrgDashboardShell } from "./_components/org-dashboard-shell";
import { OrgDashboardProvider } from "./_providers/org-dashboard-provider";
import { DashboardQueryClientProvider } from "./_providers/query-client-provider";

async function getWorkspaceFaviconUrl(): Promise<string | null> {
  const apiBase = readBaseUrlEnv(process.env, "DEN_API_BASE");
  if (!apiBase) {
    return null;
  }

  const cookie = (await headers()).get("cookie");
  if (!cookie) {
    return null;
  }

  try {
    const response = await fetch(joinBaseUrl(apiBase, "v1/org"), {
      headers: { cookie },
      cache: "no-store",
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) {
      return null;
    }

    const orgContext = parseOrgContextPayload(await response.json());
    return orgFeatureEnabled(orgContext, "whiteLabel")
      ? getManagedBrandIconUrl(orgContext?.organization.metadata ?? null)
      : null;
  } catch {
    return null;
  }
}

export async function generateMetadata(): Promise<Metadata> {
  const iconUrl = await getWorkspaceFaviconUrl();
  return { icons: { icon: iconUrl ?? "/openwork-mark.svg" } };
}

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <DashboardQueryClientProvider>
      <OrgDashboardProvider>
        <DenToastProvider>
          <OrgDashboardShell>{children}</OrgDashboardShell>
        </DenToastProvider>
      </OrgDashboardProvider>
    </DashboardQueryClientProvider>
  );
}
