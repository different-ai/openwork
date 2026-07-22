"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, CreditCard, Loader2 } from "lucide-react";
import { DashboardPageTemplate } from "../../../../../_components/ui/dashboard-page-template";
import { DenButton } from "../../../../../_components/ui/button";
import { getBillingRoute, getInferenceRoute } from "../../../../../_lib/den-org";
import { requestJson } from "../../../../../_lib/den-flow";
import { useOrgDashboard } from "../../../../_providers/org-dashboard-provider";

const MAX_ATTEMPTS = 20;
const POLL_INTERVAL_MS = 3000;

function hasActiveStripeSubscription(payload: unknown) {
  if (!payload || typeof payload !== "object" || !("billing" in payload)) return false;
  const billing = (payload as { billing?: unknown }).billing;
  if (!billing || typeof billing !== "object" || !("stripe" in billing)) return false;
  const stripe = (billing as { stripe?: unknown }).stripe;
  return Boolean(stripe && typeof stripe === "object" && "hasActiveSubscription" in stripe && stripe.hasActiveSubscription === true);
}

export default function StripeCheckingPage() {
  const router = useRouter();
  const { activeOrg } = useOrgDashboard();
  const [failed, setFailed] = useState(false);
  const attemptsRef = useRef(0);
  const intervalRef = useRef<number | null>(null);
  // Inference checkouts started from the OpenWork Models page carry
  // `return=models` so the user lands back where they subscribed from and
  // sees the value unlocked, not the billing status page. Read from
  // window.location instead of useSearchParams to avoid the Suspense
  // requirement on this client-only page.
  const returnTarget = typeof window !== "undefined"
    ? new URLSearchParams(window.location.search).get("return")
    : null;
  const billingRoute = returnTarget === "models"
    ? getInferenceRoute(activeOrg?.slug)
    : getBillingRoute(activeOrg?.slug);

  useEffect(() => {
    let cancelled = false;

    function stop() {
      if (intervalRef.current !== null) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    }

    async function checkSubscription() {
      if (cancelled) return;
      attemptsRef.current += 1;
      try {
        const { response, payload } = await requestJson("/v1/billing", { method: "GET" }, 12000);
        if (cancelled) return;
        if (response.ok && hasActiveStripeSubscription(payload)) {
          stop();
          router.replace(billingRoute);
          return;
        }
      } catch {
        // Ignore and let the polling loop continue until MAX_ATTEMPTS.
      }
      if (attemptsRef.current >= MAX_ATTEMPTS) {
        stop();
        setFailed(true);
      }
    }

    void checkSubscription();
    intervalRef.current = window.setInterval(() => void checkSubscription(), POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      stop();
    };
  }, [billingRoute, router]);

  return (
    <DashboardPageTemplate
      icon={CreditCard}
      title="Confirming Stripe"
      description="Finishing your checkout and refreshing workspace access."
      colors={["#F5F3FF", "#312E81", "#635BFF", "#C4B5FD"]}
    >
      <section className="flex min-h-72 flex-col items-center justify-center gap-4 rounded-2xl border border-violet-100 bg-white p-12 text-center shadow-[0_8px_30px_-20px_rgba(49,46,129,0.45)]">
        {failed ? (
          <>
            <AlertCircle className="h-10 w-10 text-red-500" aria-hidden="true" />
            <p className="text-[17px] font-medium text-gray-950">We couldn&apos;t confirm the subscription yet</p>
            <p className="max-w-[480px] text-[14px] leading-6 text-gray-600">
              If your payment went through, refresh Stripe from the billing page or contact{" "}
              <a className="font-medium text-blue-600 hover:underline" href="mailto:team@openworklabs.com">team@openworklabs.com</a>.
            </p>
            <DenButton onClick={() => router.replace(billingRoute)}>Return to Stripe</DenButton>
          </>
        ) : (
          <>
            <Loader2 className="h-9 w-9 animate-spin text-[#635BFF]" aria-hidden="true" />
            <p className="text-[16px] font-medium text-gray-950">Stripe is confirming your subscription</p>
            <p className="max-w-sm text-[13px] leading-6 text-gray-500">This page updates automatically. You&apos;ll return to your workspace as soon as access is ready.</p>
          </>
        )}
      </section>
    </DashboardPageTemplate>
  );
}
