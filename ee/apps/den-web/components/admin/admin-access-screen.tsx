"use client";

import { useEffect, useState } from "react";
import { DenButton, buttonVariants } from "../../app/(den)/_components/ui/button";
import { requestSignedInEmail, type AdminAccess } from "./admin-request";

export function AdminAccessScreen({ state, message, onRetry }: {
  state: Exclude<AdminAccess, "ready"> | "checking";
  message?: string;
  onRetry?: () => void;
}) {
  const [signedInEmail, setSignedInEmail] = useState<string | null>(null);
  useEffect(() => {
    if (state !== "forbidden") return;
    const controller = new AbortController();
    void requestSignedInEmail(controller.signal).then(email => {
      if (!controller.signal.aborted) setSignedInEmail(email);
    });
    return () => controller.abort();
  }, [state]);

  const title = state === "signed-out" ? "Sign in required"
    : state === "forbidden" ? "Admin access required"
    : state === "checking" ? "Checking admin access"
    : "Backoffice unavailable";
  const detail = state === "signed-out" ? "Sign in with an OpenWork admin account to continue."
    : state === "forbidden" ? message || "This account is not on the OpenWork admin allowlist."
    : state === "checking" ? undefined
    : message ?? "The backoffice could not be reached. Retry to check your access.";

  return (
    <section data-testid="admin-access-screen" className="rounded-2xl border border-gray-200 bg-white p-6">
      <h1 className="text-lg font-semibold text-gray-900" role={state === "checking" ? "status" : undefined}>{title}</h1>
      {detail ? <p className="mt-3 text-sm text-gray-600">{detail}</p> : null}
      {state === "forbidden" && signedInEmail ? <p data-testid="admin-access-account" className="mt-2 text-sm text-gray-600">Signed in as <span className="font-medium text-gray-900">{signedInEmail}</span>.</p> : null}
      {state !== "checking" ? (
        <div className="mt-6 flex flex-wrap gap-3">
          <a href="/?mode=sign-in" className={buttonVariants()}>Open sign-in page</a>
          {onRetry ? <DenButton variant="secondary" onClick={onRetry}>Retry</DenButton> : null}
        </div>
      ) : null}
    </section>
  );
}
