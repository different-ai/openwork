import { OrgDashboardShell } from "../o/[orgSlug]/dashboard/_components/org-dashboard-shell";
import { OrgDashboardProvider } from "../o/[orgSlug]/dashboard/_providers/org-dashboard-provider";
import { DashboardQueryClientProvider } from "../o/[orgSlug]/dashboard/_providers/query-client-provider";

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
