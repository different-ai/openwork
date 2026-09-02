"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { denApiCredentials, denApiEndpoint } from "../../(den)/_lib/den-api-origin";

function completionUrl(intentId: string, failed = false) {
  const url = new URL("/sso/test/complete", window.location.origin);
  url.searchParams.set("openworkSsoTest", intentId);
  if (failed) url.searchParams.set("failed", "1");
  return url.toString();
}

function SsoTestStartContent() {
  const searchParams = useSearchParams();
  const intentId = searchParams.get("intentId")?.trim() ?? "";
  const organizationId = searchParams.get("organizationId")?.trim() ?? "";
  const [error, setError] = useState<string | null>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    if (!intentId || !organizationId) {
      setError("This SSO authentication test link is invalid. Return to SSO settings and start a new test.");
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const endpoint = denApiEndpoint(`/v1/sso/test/${encodeURIComponent(intentId)}/start`);
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "x-openwork-legacy-org-id": organizationId,
          },
          credentials: denApiCredentials(endpoint),
          body: JSON.stringify({}),
        });
        const payload: unknown = await response.json().catch(() => null);
        const url = typeof payload === "object" && payload !== null && "url" in payload && typeof payload.url === "string"
          ? payload.url
          : null;
        if (!response.ok || !url) {
          throw new Error("The SSO authentication test could not be started. Return to SSO settings and try again.");
        }
        if (!cancelled) window.location.assign(url);
      } catch (nextError) {
        if (cancelled) return;
        setError(nextError instanceof Error ? nextError.message : "The SSO authentication test could not be started.");
        window.setTimeout(() => window.location.assign(completionUrl(intentId, true)), 1200);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [intentId, organizationId]);

  return (
    <main className="min-h-screen bg-[#0B1020] px-6 py-20 text-white">
      <div className="mx-auto max-w-xl rounded-[32px] border border-white/10 bg-white/5 p-8 shadow-[0_30px_90px_-40px_rgba(0,0,0,0.6)] backdrop-blur">
        <p className="text-[12px] font-semibold uppercase tracking-[0.24em] text-violet-200">SSO configuration test</p>
        <h1 className="mt-4 text-3xl font-semibold tracking-[-0.04em]">Continue to your identity provider</h1>
        <p className="mt-3 text-[15px] leading-7 text-white/70">This test does not enable SSO or replace your current OpenWork session.</p>
        <div className={`mt-6 rounded-[20px] border px-4 py-3 text-[14px] ${error ? "border-red-400/40 bg-red-500/10 text-red-100" : "border-white/10 bg-black/20 text-white/70"}`}>
          {error ?? "Preparing the saved configuration for a real authentication test..."}
        </div>
      </div>
    </main>
  );
}

export default function SsoTestStartPage() {
  return <Suspense><SsoTestStartContent /></Suspense>;
}
