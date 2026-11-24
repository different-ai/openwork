import { Suspense } from "react";
import { ConfigScreen } from "../../_components/config-blobs/config-screen";

export default function ConfigPage() {
  return (
    <Suspense fallback={null}>
      <ConfigScreen />
    </Suspense>
  );
}
