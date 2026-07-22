"use client";

import { Suspense, useEffect } from "react";
import { useSearchParams } from "next/navigation";

function CompleteFallback() {
  return (
    <main className="den-page flex min-h-[calc(100vh-2.5rem)] w-full items-center justify-center py-6">
      <div className="den-frame grid w-full max-w-[520px] gap-3 p-6 text-center md:p-8">
        <p className="den-eyebrow">Security check</p>
        <h1 className="den-title-lg">You&apos;re verified.</h1>
        <p className="den-copy">You can close this window and return to OpenWork.</p>
      </div>
    </main>
  );
}

function ReauthCompleteContent() {
  const searchParams = useSearchParams();
  const nonce = searchParams.get("nonce");
  const error = searchParams.get("error") || null;

  useEffect(() => {
    if (!window.opener) {
      return;
    }

    window.opener.postMessage(
      { type: "openwork:reauth-complete", nonce, error },
      window.location.origin,
    );
    window.close();
  }, [error, nonce]);

  return <CompleteFallback />;
}

export default function ReauthCompletePage() {
  return (
    <Suspense fallback={<CompleteFallback />}>
      <ReauthCompleteContent />
    </Suspense>
  );
}
