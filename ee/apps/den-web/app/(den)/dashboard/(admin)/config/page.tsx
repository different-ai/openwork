import { Suspense } from "react";
import { ConfigScreen } from "../../_components/config-blobs/config-screen";

// ConfigScreen reads the tab from the URL (useSearchParams), so it needs a Suspense boundary to prerender.
export default function ConfigPage() {
  return (
    <Suspense fallback={null}>
      <ConfigScreen />
    </Suspense>
  );
}
