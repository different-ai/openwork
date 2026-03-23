"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { formatMoneyMinor } from "../_lib/den-flow";
import { useDenFlow } from "../_providers/den-flow-provider";

// For local layout testing (no deploy needed)
// Enable with: NEXT_PUBLIC_DEN_MOCK_BILLING=1
const MOCK_BILLING = process.env.NEXT_PUBLIC_DEN_MOCK_BILLING === "1";
const MOCK_CHECKOUT_URL = (process.env.NEXT_PUBLIC_DEN_MOCK_CHECKOUT_URL ?? "").trim() || null;
const TRIAL_DAYS = 14;

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
  const checkoutHref = effectiveCheckoutUrl ?? MOCK_CHECKOUT_URL ?? null;
  const planAmountLabel = billingPrice && billingPrice.amount !== null
    ? `${formatMoneyMinor(billingPrice.amount, billingPrice.currency)}/${billingPrice.recurringInterval}`
    : "$50.00/month";

  return (
    <section className="mx-auto flex w-full max-w-[74rem] flex-col gap-6 px-1 py-2 lg:px-3 lg:py-6">
      <div className="grid gap-5 rounded-[32px] border border-slate-200/80 bg-white p-6 md:p-8">
        <div className="grid gap-3 border-b border-[var(--dls-border)] pb-5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--dls-text-secondary)]">
            {onboardingPending ? "Finish setup" : "Den access"}
          </p>
          <h1 className="max-w-[12ch] text-[2.5rem] font-semibold leading-[0.95] tracking-[-0.06em] text-[var(--dls-text-primary)] md:text-[3.4rem]">
            Choose how to run Den
          </h1>
        </div>

        {billingError ? (
          <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{billingError}</div>
        ) : null}

        {showLoading ? <p className="text-sm text-[var(--dls-text-secondary)]">Refreshing access state...</p> : null}

        {billingSummary ? (
          <div className="grid gap-4 lg:grid-cols-2">
            <article className="flex flex-col gap-5 rounded-[28px] border border-slate-200 bg-white p-5 md:p-6">
              <div className="grid gap-2">
                <h2 className="text-[2rem] font-semibold leading-[0.98] tracking-[-0.05em] text-[var(--dls-text-primary)]">
                  Den Cloud
                </h2>
                <p className="text-[14px] leading-7 text-[var(--dls-text-secondary)]">
                  Zero setup. Run hosted workers instantly.
                </p>
              </div>

              <div className="grid gap-3">
                <div className="flex items-start gap-3 text-[14px] leading-6 text-[var(--dls-text-secondary)]">
                  <span className="mt-2 block h-1.5 w-1.5 shrink-0 rounded-full bg-slate-300"></span>
                  {TRIAL_DAYS}-day free trial
                </div>
                <div className="flex items-start gap-3 text-[14px] leading-6 text-[var(--dls-text-secondary)]">
                  <span className="mt-2 block h-1.5 w-1.5 shrink-0 rounded-full bg-slate-300"></span>
                  {planAmountLabel} after trial
                </div>
              </div>

              {checkoutHref ? (
                <div className="mt-auto pt-4">
                  <a
                    href={checkoutHref}
                    rel="noreferrer"
                    className="flex w-full items-center justify-center gap-2 rounded-full bg-[#011627] px-5 py-3 text-sm font-semibold text-white transition hover:bg-black"
                  >
                    Start free trial
                  </a>
                </div>
              ) : (
                <div className="mt-auto grid gap-3 pt-4">
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-[14px] leading-6 text-[var(--dls-text-secondary)]">
                    We are still preparing your trial link.
                  </div>
                  <button
                    type="button"
                    className="flex w-full items-center justify-center rounded-full border border-slate-200 bg-white px-5 py-3 text-sm font-medium text-[var(--dls-text-primary)] transition hover:bg-slate-50"
                    onClick={() => void refreshBilling({ includeCheckout: true, quiet: false })}
                    disabled={billingBusy || billingCheckoutBusy}
                  >
                    Refresh trial link
                  </button>
                </div>
              )}
            </article>

            <article className="flex flex-col gap-5 rounded-[28px] border border-slate-200 bg-slate-50 p-5 md:p-6">
              <div className="grid gap-2">
                <h2 className="text-[2rem] font-semibold leading-[0.98] tracking-[-0.05em] text-[var(--dls-text-primary)]">
                  Desktop App
                </h2>
                <p className="text-[14px] leading-7 text-[var(--dls-text-secondary)]">
                  Run locally for free.
                </p>
              </div>

              <div className="grid gap-3">
                <div className="flex items-start gap-3 text-[14px] leading-6 text-[var(--dls-text-secondary)]">
                  <span className="mt-2 block h-1.5 w-1.5 shrink-0 rounded-full bg-slate-300"></span>
                  Keep data on your machine
                </div>
                <div className="flex items-start gap-3 text-[14px] leading-6 text-[var(--dls-text-secondary)]">
                  <span className="mt-2 block h-1.5 w-1.5 shrink-0 rounded-full bg-slate-300"></span>
                  Add Cloud workers anytime
                </div>
              </div>

              <div className="mt-auto pt-4">
                <a
                  href="/"
                  className="flex w-full items-center justify-center gap-2 rounded-full border border-slate-200 bg-white px-5 py-3 text-sm font-medium text-[var(--dls-text-primary)] transition hover:bg-slate-100"
                >
                  Download app
                </a>
              </div>
            </article>
          </div>
        ) : null}
      </div>
    </section>
  );
}
