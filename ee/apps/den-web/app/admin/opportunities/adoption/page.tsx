import { Suspense } from "react";
import { AdminOpportunitiesPage } from "../../../../components/admin/admin-opportunities-page";

export const metadata = { title: "All active teams | OpenWork admin" };

export default function AdoptionOpportunitiesPage() {
  return <Suspense><AdminOpportunitiesPage /></Suspense>;
}
