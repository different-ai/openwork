import { Suspense } from "react";
import { AuthSecurityLegacyRoute } from "../_components/auth-security-legacy-route";

export default function SsoPage() {
  return (
    <Suspense fallback={null}>
      <AuthSecurityLegacyRoute tab="sso" />
    </Suspense>
  );
}
