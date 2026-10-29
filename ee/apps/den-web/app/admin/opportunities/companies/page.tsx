import { Suspense } from "react";
import { AdminSignupCompaniesPage } from "../../../../components/admin/admin-signup-companies-page";

export const metadata = { title: "Signups by company | OpenWork admin" };

export default function SignupCompaniesPage() {
  return <Suspense><AdminSignupCompaniesPage /></Suspense>;
}
