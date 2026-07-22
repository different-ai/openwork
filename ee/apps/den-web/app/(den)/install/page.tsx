import { Suspense } from "react";
import { InstallScreen } from "../_components/install-screen";

export default function InstallPage() {
  return (
    <Suspense fallback={null}>
      <InstallScreen />
    </Suspense>
  );
}
