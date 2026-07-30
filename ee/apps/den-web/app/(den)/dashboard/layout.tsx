import type { Metadata } from "next";
import { headers } from "next/headers";
import { joinBaseUrl, readBaseUrlEnv } from "@openwork/types/url";

import { getManagedBrandIconUrl, parseOrgListPayload } from "../_lib/den-org";
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
    const response = await fetch(joinBaseUrl(apiBase, "v1/me/orgs"), {
      headers: { cookie },
      cache: "no-store",
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) {
      return null;
    }

    const { orgs, activeOrgId } = parseOrgListPayload(await response.json());
    const activeOrg =
      (activeOrgId ? orgs.find((org) => org.id === activeOrgId) : null) ??
      orgs.find((org) => org.isActive) ??
      orgs[0] ??
      null;
    return activeOrg ? getManagedBrandIconUrl(activeOrg.metadata) : null;
  } catch {
    return null;
  }
}

export async function generateMetadata(): Promise<Metadata> {
  const iconUrl = await getWorkspaceFaviconUrl();
  return iconUrl ? { icons: { icon: iconUrl } } : {};
}

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <DashboardQueryClientProvider>
      <OrgDashboardProvider>
        <OrgDashboardShell>{children}</OrgDashboardShell>
      </OrgDashboardProvider>
    </DashboardQueryClientProvider>
  );
}
