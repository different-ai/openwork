"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { formatMoneyMinor, formatRecurringInterval } from "../_lib/den-flow";
import { useDenFlow } from "../_providers/den-flow-provider";

// For local layout testing (no deploy needed)
// Enable with: NEXT_PUBLIC_DEN_MOCK_BILLING=1
const MOCK_BILLING = process.env.NEXT_PUBLIC_DEN_MOCK_BILLING === "1";
const MOCK_CHECKOUT_URL = (process.env.NEXT_PUBLIC_DEN_MOCK_CHECKOUT_URL ?? "").trim() || null;

export function CheckoutScreen({ customerSessionToken }: { customerSessionToken: string | null }) {
  const router = useRouter();
  const handledReturnRef = useRef(false);
  const [resuming, setResuming] = useState(false);
  const {
    user,
    sessionHydrated,
    billingSummary: realBillingSummary,
    billingBusy,
    billingCheckoutBusy,
    billingError,
    effectiveCheckoutUrl,
    onboardingPending,
    refreshBilling,
    refreshCheckoutReturn,
    resolveUserLandingRoute,
  } = useDenFlow();

  const mockMode = MOCK_BILLING && process.env.NODE_ENV !== "production";

  const billingSummary = MOCK_BILLING
    ? {
        featureGateEnabled: true,
        hasActivePlan: false,
        price: { amount: 5000, currency: "usd", recurringInterval: "month", recurringIntervalCount: 1 },
        subscription: null,
        invoices: [],
        account: { email: user?.email ?? "test@example.com", polarId: "123" }
      }
    : realBillingSummary;

  useEffect(() => {
    if (!sessionHydrated || resuming) {
      return;
    }
    if (!user) {
      if (mockMode) {
        return;
      }
      router.replace("/");
    }
  }, [mockMode, resuming, router, sessionHydrated, user]);

  useEffect(() => {
    if (!sessionHydrated || !user || handledReturnRef.current) {
      return;
    }

    if (!customerSessionToken) {
      return;
    }

    handledReturnRef.current = true;
    setResuming(true);
    void refreshCheckoutReturn(true).then((target) => {
      if (target === "/dashboard") {
        router.replace(target);
        return;
      }

      router.replace("/checkout");
      setResuming(false);
    });
  }, [customerSessionToken, refreshCheckoutReturn, router, sessionHydrated, user]);

  useEffect(() => {
    if (!sessionHydrated || !user || resuming) {
      return;
    }

    if (!billingSummary?.hasActivePlan && !effectiveCheckoutUrl && !billingBusy && !billingCheckoutBusy) {
      void refreshBilling({ includeCheckout: true, quiet: true });
    }
  }, [billingBusy, billingCheckoutBusy, billingSummary?.hasActivePlan, effectiveCheckoutUrl, refreshBilling, resuming, sessionHydrated, user]);

  useEffect(() => {
    if (!sessionHydrated || !user || resuming) {
      return;
    }

    if (!onboardingPending) {
      void resolveUserLandingRoute().then((target) => {
        if (target === "/dashboard" && !MOCK_BILLING) {
          router.replace(target);
        }
      });
    }
  }, [onboardingPending, resolveUserLandingRoute, resuming, router, sessionHydrated, user]);

  if (!sessionHydrated || (!user && !mockMode)) {
    return (
      <section className="mx-auto grid w-full max-w-[44rem] gap-4 rounded-[32px] border border-white/70 bg-white/92 p-6 shadow-[0_28px_80px_-44px_rgba(15,23,42,0.35)]">
        <p className="text-sm text-slate-500">Checking your billing session...</p>
      </section>
    );
  }

  const billingPrice = billingSummary?.price ?? null;
  const showLoading = resuming || (billingBusy && !billingSummary && !MOCK_BILLING);

  return (
    <section className="mx-auto flex w-full max-w-[40rem] flex-col gap-6 p-4 md:p-12">
      <div className="flex flex-col items-center text-center">
        <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.16em] text-gray-400">
          {onboardingPending ? "Finish billing to continue onboarding" : "Billing"}
        </p>
        <h1 className="text-3xl font-semibold tracking-tight text-[#011627] md:text-4xl">
          {onboardingPending ? "Unlock your Den worker." : "Manage your Den plan."}
        </h1>
        <p className="mt-4 max-w-[28rem] text-[16px] leading-relaxed text-gray-500">
          {onboardingPending
            ? "We wait for billing to confirm before resuming worker creation, so checkout returns land reliably on your dashboard."
            : "Review plan status, generate checkout links, and manage your existing Den subscription."}
        </p>
      </div>

      {billingError ? (
        <div className="rounded-[18px] border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{billingError}</div>
      ) : null}

      {showLoading ? <p className="text-center text-sm text-slate-500">Refreshing billing state...</p> : null}

      {billingSummary ? (
        <div className="rounded-[28px] border border-gray-200 bg-white p-8 shadow-sm">
          <div className="flex items-center gap-3 mb-4">
            <h3 className="text-xl font-semibold tracking-tight text-slate-900">Plan status</h3>
          </div>
          
          <p className="text-2xl font-semibold text-slate-900">
            {!billingSummary.featureGateEnabled
              ? "Billing disabled"
              : billingSummary.hasActivePlan
                ? "Active plan"
                : "Payment required"}
          </p>
          <p className="mt-2 text-[15px] leading-relaxed text-gray-500">
            {!billingSummary.featureGateEnabled
              ? "Cloud billing gates are disabled in this environment."
              : billingSummary.hasActivePlan
                ? "Your account can launch cloud workers right now."
                : "Complete checkout to unlock cloud worker launches."}
          </p>
          <p className="mt-4 text-sm font-semibold text-slate-900">
            {billingPrice && billingPrice.amount !== null
              ? `${formatMoneyMinor(billingPrice.amount, billingPrice.currency)} ${formatRecurringInterval(billingPrice.recurringInterval, billingPrice.recurringIntervalCount)}`
              : "Current plan amount is unavailable."}
          </p>

          {effectiveCheckoutUrl || (mockMode && MOCK_CHECKOUT_URL) ? (
            <div className="mt-6 rounded-[20px] border border-amber-200 bg-amber-50 p-6">
              <p className="text-base font-semibold text-amber-900">Checkout available</p>
              <p className="mt-2 text-[15px] leading-relaxed text-amber-800">Open a fresh checkout session, then return here to resume automatically.</p>
              <a
                href={effectiveCheckoutUrl ?? MOCK_CHECKOUT_URL ?? "#"}
                rel="noreferrer"
                className="mt-4 inline-flex items-center justify-center rounded-xl bg-amber-400 px-5 py-3 text-sm font-semibold text-amber-950 shadow-sm transition hover:bg-amber-500"
              >
                Continue to checkout
              </a>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
