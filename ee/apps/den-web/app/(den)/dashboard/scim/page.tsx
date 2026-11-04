import { Suspense } from "react";
import { AuthSecurityLegacyRoute } from "../_components/auth-security-legacy-route";
import { ScimScreen } from "../_components/scim-screen";

// AuthSecurityLegacyRoute reads query params (useSearchParams), so it needs a Suspense boundary to prerender.
export default function ScimPage() {
  return (
    <Suspense fallback={null}>
      <AuthSecurityLegacyRoute tab="scim">
        <ScimScreen />
      </AuthSecurityLegacyRoute>
    </Suspense>
  );
}
