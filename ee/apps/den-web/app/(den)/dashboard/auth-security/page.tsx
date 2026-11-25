import { Suspense } from "react";
import { AuthSecurityScreen } from "../_components/auth-security-screen";

export default function AuthSecurityPage() {
  return (
    <Suspense fallback={null}>
      <AuthSecurityScreen />
    </Suspense>
  );
}
