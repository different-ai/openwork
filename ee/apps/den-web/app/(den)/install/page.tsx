import { Suspense } from "react";
import { InstallScreen } from "../_components/install-screen";
import { MemberAuthGuard } from "../_components/member-auth-guard";

export default function InstallPage() {
  return (
    <Suspense fallback={null}>
      <MemberAuthGuard route="/install">
        <InstallScreen />
      </MemberAuthGuard>
    </Suspense>
  );
}
