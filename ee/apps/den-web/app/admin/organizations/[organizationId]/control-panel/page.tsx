import { redirect } from "next/navigation";

/** The Control panel became the Billing tab; old links keep working. */
export default async function OrganizationControlPanelRedirect({ params, searchParams }: { params: Promise<{ organizationId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { organizationId } = await params;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    for (const entry of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(key, entry);
  }
  redirect(`/admin/organizations/${encodeURIComponent(organizationId)}/billing${query.size ? `?${query}` : ""}`);
}
