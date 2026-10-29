import { Suspense } from "react";
import { AdminOpportunitiesPage } from "../../../../components/admin/admin-opportunities-page";

export const metadata = { title: "Adoption opportunities | OpenWork admin" };

export default function AdoptionOpportunitiesPage() {
  return <Suspense><AdminOpportunitiesPage /></Suspense>;
}
