import { OrgManagedDashboardsCapabilityGuard } from "../../_components/org-managed-dashboards-capability-guard";

export default function OrgDashboardsLayout({ children }: { children: React.ReactNode }) {
  return <OrgManagedDashboardsCapabilityGuard>{children}</OrgManagedDashboardsCapabilityGuard>;
}
