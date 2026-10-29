import { AdminOrganizationPage } from "../../../../../components/admin/admin-organization-page";

export const metadata = { title: "Organization insights | OpenWork admin" };

export default async function OrganizationInsightsPage({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await params;
  return <AdminOrganizationPage key={organizationId} organizationId={organizationId} section="insights" />;
}
