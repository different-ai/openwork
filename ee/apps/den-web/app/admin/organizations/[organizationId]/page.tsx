import { AdminOrganizationPage } from "../../../../components/admin/admin-organization-page";

export const metadata = { title: "Organization members | OpenWork admin" };

export default async function OrganizationPage({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await params;
  return <AdminOrganizationPage key={organizationId} organizationId={organizationId} section="members" />;
}
