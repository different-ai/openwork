import { AuthSecurityLegacyRoute } from "../_components/auth-security-legacy-route";
import { SsoScreen } from "../_components/sso-screen";

export default function SsoPage() {
  return (
    <AuthSecurityLegacyRoute tab="sso">
      <SsoScreen />
    </AuthSecurityLegacyRoute>
  );
}
