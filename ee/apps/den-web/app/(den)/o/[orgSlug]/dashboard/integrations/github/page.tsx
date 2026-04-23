import { Suspense } from "react";
import { GithubIntegrationScreen } from "../../_components/github-integration-screen";

export const dynamic = "force-dynamic";

export default function GithubIntegrationPage() {
  return (
    <Suspense fallback={null}>
      <GithubIntegrationScreen />
    </Suspense>
  );
}
