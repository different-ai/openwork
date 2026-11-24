import { AdminOrganizationPage } from "../../../../../components/admin/admin-organization-page";

export const metadata = { title: "Organization usage | OpenWork admin" };

export default async function OrganizationUsagePage({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await params;
  return <AdminOrganizationPage key={organizationId} organizationId={organizationId} section="usage" />;
}
