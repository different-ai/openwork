import { Suspense } from "react";
import { LibraryScreen } from "../_components/library-screen";

export default function LibraryPage() {
  return (
    <Suspense fallback={null}>
      <LibraryScreen />
    </Suspense>
  );
}
