import type { ReactNode } from "react";
import { AdminOrganizationLayout } from "../../../../components/admin/admin-organization-page";

export default async function OrganizationLayout({ children, params }: { children: ReactNode; params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await params;
  return <AdminOrganizationLayout key={organizationId} organizationId={organizationId}>{children}</AdminOrganizationLayout>;
}
