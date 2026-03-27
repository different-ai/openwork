import type { ReactNode } from "react";
import { OrgDashboardShell } from "./_components/org-dashboard-shell";
import { OrgDashboardProvider } from "./_providers/org-dashboard-provider";

export default async function OrgDashboardLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;

  return (
    <OrgDashboardProvider orgSlug={orgSlug}>
      <OrgDashboardShell>{children}</OrgDashboardShell>
    </OrgDashboardProvider>
  );
}
