import { Suspense } from "react";
import { CloudCodingLinkRoute } from "../route-screens";

export const dynamic = "force-dynamic";

export default function CloudCodingLinkPage() {
  return <Suspense fallback={null}><CloudCodingLinkRoute /></Suspense>;
}
