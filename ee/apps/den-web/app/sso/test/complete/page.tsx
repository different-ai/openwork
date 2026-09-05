"use client";

import { DenStatusScreen } from "../../../../components/den-status-screen";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

function CompleteContent() {
  const searchParams = useSearchParams();
  const [{ intentId, failed }] = useState(() => ({
    intentId: searchParams.get("openworkSsoTest") ?? "",
    failed: searchParams.has("error") || searchParams.has("failed"),
  }));

  useEffect(() => {
    window.history.replaceState(null, "", "/sso/test/complete");
    if (!window.opener) return;
    window.opener.postMessage(
      { type: "openwork:sso-test-complete", intentId, failed },
      window.location.origin,
    );
    window.close();
  }, [failed, intentId]);

  return (
    <DenStatusScreen
      title={failed ? "Authentication test failed" : "Authentication test finished"}
      description="Return to SSO settings to review the result. You can close this window."
    />
  );
}

export default function SsoTestCompletePage() {
  return <Suspense fallback={<DenStatusScreen title="Finishing your SSO test" description="Preparing the authentication result…" />}><CompleteContent /></Suspense>;
}
