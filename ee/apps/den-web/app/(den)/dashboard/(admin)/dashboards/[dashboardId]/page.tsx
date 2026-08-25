import { OrgDashboardDetailScreen } from "../../../_components/org-dashboard-detail-screen";

export default async function OrgDashboardDetailPage({ params }: { params: Promise<{ dashboardId: string }> }) {
  const { dashboardId } = await params;
  return <OrgDashboardDetailScreen dashboardId={dashboardId} />;
}
