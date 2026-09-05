"use client";

import Link from "next/link";
import { DenStatusScreen } from "../../../components/den-status-screen";
import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { getSocialCallbackUrl, requestJson } from "../../(den)/_lib/den-flow";

export default function OrganizationSsoSignInPage() {
  const params = useParams<{ orgSlug: string }>();
  const searchParams = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const orgSlug = typeof params?.orgSlug === "string" ? params.orgSlug : "";

  const callbackURL = useMemo(() => searchParams.get("callbackURL") || getSocialCallbackUrl(), [searchParams]);
  const loginHint = useMemo(() => searchParams.get("loginHint") || undefined, [searchParams]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const { response, payload } = await requestJson("/api/auth/sign-in/sso", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            organizationSlug: orgSlug,
            callbackURL,
            loginHint,
          }),
        });

        if (!response.ok) {
          throw new Error(
            payload && typeof payload === "object" && "message" in payload && typeof payload.message === "string"
              ? payload.message
              : `Failed to start SSO sign-in (${response.status}).`,
          );
        }

        const nextUrl = payload && typeof payload === "object" && "url" in payload && typeof payload.url === "string" ? payload.url : "";
        if (!nextUrl) {
          throw new Error("SSO sign-in started without a redirect URL.");
        }

        if (!cancelled) {
          window.location.assign(nextUrl);
        }
      } catch (nextError) {
        if (!cancelled) {
          setError(nextError instanceof Error ? nextError.message : "Failed to start SSO sign-in.");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [callbackURL, loginHint, orgSlug]);

  return (
    <DenStatusScreen
      title={error ? "We couldn’t sign you in" : "Signing you in"}
      description={error ? "Return to sign in and try again, or contact your organization’s administrator." : "Taking you to your organization’s sign-in page."}
      status="Connecting to your identity provider…"
      error={error}
    >
      {error ? (
        <Link href="/" className="mt-6 inline-flex h-10 items-center justify-center rounded-full border border-[var(--dls-border)] px-4 text-[13px] font-medium transition-colors hover:bg-[var(--dls-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--dls-accent)]">
          Back to sign in
        </Link>
      ) : null}
    </DenStatusScreen>
  );
}
