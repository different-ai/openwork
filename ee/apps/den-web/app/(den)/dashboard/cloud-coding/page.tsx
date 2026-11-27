import { Suspense } from "react";
import { CloudCodingRoute } from "./route-screens";

export const dynamic = "force-dynamic";

export default function CloudCodingPage() {
  return <Suspense fallback={null}><CloudCodingRoute /></Suspense>;
}
