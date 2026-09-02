"use client";

import { Suspense, useEffect } from "react";
import { useSearchParams } from "next/navigation";

function CompleteContent() {
  const searchParams = useSearchParams();
  const intentId = searchParams.get("openworkSsoTest") ?? "";
  const failed = searchParams.has("error") || searchParams.has("failed");

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
    <main className="min-h-screen bg-[#0B1020] px-6 py-20 text-white">
      <div className="mx-auto max-w-xl rounded-[32px] border border-white/10 bg-white/5 p-8 text-center">
        <p className="text-[12px] font-semibold uppercase tracking-[0.24em] text-violet-200">SSO configuration test</p>
        <h1 className="mt-4 text-3xl font-semibold">Authentication test finished</h1>
        <p className="mt-3 text-white/70">Return to SSO settings to review the result. You can close this window.</p>
      </div>
    </main>
  );
}

export default function SsoTestCompletePage() {
  return <Suspense><CompleteContent /></Suspense>;
}
