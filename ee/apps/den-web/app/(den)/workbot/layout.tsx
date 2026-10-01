import { DashboardQueryClientProvider } from "../dashboard/_providers/query-client-provider";
import { OrgDashboardProvider } from "../dashboard/_providers/org-dashboard-provider";

/** Workbot is one full-height conversation: the dashboard's data providers, none of its chrome. */
export default function WorkbotLayout({ children }: { children: React.ReactNode }) {
  return (
    <DashboardQueryClientProvider>
      <OrgDashboardProvider>{children}</OrgDashboardProvider>
    </DashboardQueryClientProvider>
  );
}
