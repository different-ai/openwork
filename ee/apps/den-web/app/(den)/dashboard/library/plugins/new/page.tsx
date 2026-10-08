import { Suspense } from "react";
import { LibraryPluginCreateScreen } from "../../../_components/plugin-create-screen";

export default function LibraryNewPluginPage() {
  return (
    <Suspense fallback={null}>
      <LibraryPluginCreateScreen />
    </Suspense>
  );
}
