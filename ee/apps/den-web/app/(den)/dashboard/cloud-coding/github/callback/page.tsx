import type { Metadata } from "next";
import { Suspense } from "react";
import { CloudCodingGithubCallbackScreen } from "../../../_components/cloud-coding/cloud-coding-github-callback-screen";
import { CloudCodingGithubCallbackView } from "../../../_components/cloud-coding/cloud-coding-github-callback-view";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { referrer: "no-referrer" };

export default function CloudCodingGithubCallbackPage() {
  return (
    <Suspense fallback={<CloudCodingGithubCallbackView phase="working" onBack={() => undefined} />}>
      <CloudCodingGithubCallbackScreen />
    </Suspense>
  );
}
