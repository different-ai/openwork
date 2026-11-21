import { Suspense } from "react";
import { AuthSecurityLegacyRoute } from "../_components/auth-security-legacy-route";

export default function ScimPage() {
  return (
    <Suspense fallback={null}>
      <AuthSecurityLegacyRoute tab="scim" />
    </Suspense>
  );
}
