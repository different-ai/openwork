import { Suspense } from "react";
import { AuthSecurityLegacyRoute } from "../_components/auth-security-legacy-route";

// AuthSecurityLegacyRoute reads query params (useSearchParams), so it needs a Suspense boundary to prerender.
export default function SsoPage() {
  return (
    <Suspense fallback={null}>
      <AuthSecurityLegacyRoute tab="sso" />
    </Suspense>
  );
}
