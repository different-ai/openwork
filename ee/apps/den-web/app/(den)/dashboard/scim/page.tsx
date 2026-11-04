import { AuthSecurityLegacyRoute } from "../_components/auth-security-legacy-route";
import { ScimScreen } from "../_components/scim-screen";

export default function ScimPage() {
  return (
    <AuthSecurityLegacyRoute tab="scim">
      <ScimScreen />
    </AuthSecurityLegacyRoute>
  );
}
