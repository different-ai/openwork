import { OrgDashboardShell } from "./_components/org-dashboard-shell";
import { OrgDashboardProvider } from "./_providers/org-dashboard-provider";
import { DashboardQueryClientProvider } from "./_providers/query-client-provider";

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
