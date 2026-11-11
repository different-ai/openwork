import { AdminOrganizationPage } from "../../../../../components/admin/admin-organization-page";

export const metadata = { title: "Organization devices | OpenWork admin" };

export default async function OrganizationDevicesPage({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await params;
  return <AdminOrganizationPage key={organizationId} organizationId={organizationId} section="devices" />;
}
