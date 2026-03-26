import type { ReactNode } from "react";
import { OrgDashboardShell } from "./_components/org-dashboard-shell";
import { OrgDashboardProvider } from "./_providers/org-dashboard-provider";

export default function OrgDashboardLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: { orgSlug: string };
}) {
  return (
    <OrgDashboardProvider orgSlug={params.orgSlug}>
      <OrgDashboardShell>{children}</OrgDashboardShell>
    </OrgDashboardProvider>
  );
}
