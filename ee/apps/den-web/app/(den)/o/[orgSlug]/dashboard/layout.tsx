import { OrgDashboardShell } from "./_components/org-dashboard-shell";
import { OrgDashboardProvider } from "./_providers/org-dashboard-provider";
import { DashboardQueryClientProvider } from "./_providers/query-client-provider";

export default async function OrgDashboardLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;

  return (
    <DashboardQueryClientProvider>
      <OrgDashboardProvider orgSlug={orgSlug}>
        <OrgDashboardShell>{children}</OrgDashboardShell>
      </OrgDashboardProvider>
    </DashboardQueryClientProvider>
  );
}
