import { AdminOpportunityOverview } from "../../../components/admin/admin-opportunity-overview";
import { redirect } from "next/navigation";

export const metadata = { title: "Opportunities | OpenWork admin" };

export default async function OpportunitiesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  // Keep saved links to the original filtered report useful after the move.
  const filters = ["days", "minMembers", "companyEmail", "setup", "outreach", "sort", "search", "page"];
  const query = new URLSearchParams();
  for (const key of filters) {
    const value = params[key];
    if (typeof value === "string") query.set(key, value);
  }
  if (query.size) redirect(`/admin/opportunities/adoption?${query}`);
  return <AdminOpportunityOverview />;
}
