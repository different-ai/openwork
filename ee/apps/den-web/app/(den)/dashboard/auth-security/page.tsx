import { Suspense } from "react";
import { AuthSecurityScreen } from "../_components/auth-security-screen";

// AuthSecurityScreen reads the tab from the URL (useSearchParams), so it needs a Suspense boundary to prerender.
export default function AuthSecurityPage() {
  return (
    <Suspense fallback={null}>
      <AuthSecurityScreen />
    </Suspense>
  );
}
