import { Suspense } from "react";
import { PluginsScreen } from "../../_components/plugins-screen";

export default function PluginsPage() {
  return (
    <Suspense fallback={null}>
      <PluginsScreen />
    </Suspense>
  );
}
