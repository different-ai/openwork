import { Suspense } from "react";
import { LibraryUsageScreen } from "../../../_features/library-usage/library-usage-screen";

export default function LibraryUsageAnalyticsPage() {
  return <Suspense fallback={null}><LibraryUsageScreen /></Suspense>;
}
