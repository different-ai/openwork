"use client";

import { DenStatusScreen } from "../../../components/den-status-screen";
import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { getRuntimeConfig } from "../../(den)/_lib/runtime-config";
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
        await getRuntimeConfig();
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
    <DenStatusScreen
      title={error ? "We couldn’t start the test" : "Testing your SSO connection"}
      description="This test does not enable SSO or replace your current OpenWork session."
      status="Preparing your organization’s sign-in page…"
      error={error}
    />
  );
}

export default function SsoTestStartPage() {
  return <Suspense fallback={<DenStatusScreen title="Testing your SSO connection" description="Preparing your organization’s sign-in page…" />}><SsoTestStartContent /></Suspense>;
}
