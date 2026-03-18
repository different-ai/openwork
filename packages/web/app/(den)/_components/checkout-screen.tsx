"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  formatIsoDate,
  formatMoneyMinor,
  formatRecurringInterval,
  formatSubscriptionStatus,
  shortValue
} from "../_lib/den-flow";
import { useDenFlow } from "../_providers/den-flow-provider";

export function CheckoutScreen({ customerSessionToken }: { customerSessionToken: string | null }) {
  const router = useRouter();
  const handledReturnRef = useRef(false);
  const [resuming, setResuming] = useState(false);
  const {
    user,
    sessionHydrated,
    billingSummary,
    billingBusy,
    billingCheckoutBusy,
    billingSubscriptionBusy,
    billingError,
    effectiveCheckoutUrl,
    onboardingPending,
    refreshBilling,
    handleSubscriptionCancellation,
    refreshCheckoutReturn,
    resolveUserLandingRoute,
    signOut
  } = useDenFlow();

  useEffect(() => {
    if (!sessionHydrated || user || resuming) {
      return;
    }
    router.replace("/");
  }, [resuming, router, sessionHydrated, user]);

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
        if (target === "/dashboard") {
          router.replace(target);
        }
      });
    }
  }, [onboardingPending, resolveUserLandingRoute, resuming, router, sessionHydrated, user]);

  if (!sessionHydrated || !user) {
    return (
      <section className="mx-auto grid w-full max-w-[44rem] gap-4 rounded-[32px] border border-white/70 bg-white/92 p-6 shadow-[0_28px_80px_-44px_rgba(15,23,42,0.35)]">
        <p className="text-sm text-slate-500">Checking your billing session...</p>
      </section>
    );
  }

  const billingSubscription = billingSummary?.subscription ?? null;
  const billingPrice = billingSummary?.price ?? null;
  const showLoading = resuming || (billingBusy && !billingSummary);

  return (
    <section className="mx-auto flex w-full max-w-[58rem] flex-col gap-4 rounded-[32px] border border-white/70 bg-white/92 p-5 shadow-[0_28px_80px_-44px_rgba(15,23,42,0.35)] md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4 rounded-[28px] border border-[var(--dls-border)] bg-white p-5 shadow-[var(--dls-card-shadow)] md:p-6">
        <div className="max-w-[34rem] space-y-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
            {onboardingPending ? "Finish billing to continue onboarding" : "Billing"}
          </p>
          <h1 className="text-[2rem] font-semibold leading-[1.02] tracking-[-0.045em] text-[var(--dls-text-primary)] md:text-[2.5rem]">
            {onboardingPending ? "Unlock your Den worker." : "Manage your Den plan."}
          </h1>
          <p className="text-[15px] leading-7 text-[var(--dls-text-secondary)]">
            {onboardingPending
              ? "We wait for billing to confirm before resuming worker creation, so checkout returns land reliably on your dashboard."
              : "Review plan status, generate checkout links, and manage your existing Den subscription."}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="rounded-[12px] border border-slate-200 px-3 py-2 text-sm font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-60"
            onClick={() => void refreshBilling({ includeCheckout: true })}
            disabled={billingBusy || billingCheckoutBusy || billingSubscriptionBusy || resuming}
          >
            {billingCheckoutBusy ? "Refreshing checkout..." : "Refresh billing"}
          </button>
          <button
            type="button"
            className="rounded-[12px] bg-slate-900 px-3 py-2 text-sm font-semibold text-white transition hover:bg-black"
            onClick={() => router.push("/dashboard")}
          >
            Go to dashboard
          </button>
          <button
            type="button"
            className="rounded-[12px] border border-slate-200 px-3 py-2 text-sm font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
            onClick={() => void signOut()}
          >
            Log out
          </button>
        </div>
      </div>

      {billingError ? (
        <div className="rounded-[18px] border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{billingError}</div>
      ) : null}

      {showLoading ? <p className="text-sm text-slate-500">Refreshing billing state...</p> : null}

      {billingSummary ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
          <div className="space-y-4">
            <div className="rounded-[24px] border border-[var(--dls-border)] bg-white p-5 shadow-[var(--dls-card-shadow)]">
              <p className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">Plan status</p>
              <p className="mt-2 text-2xl font-semibold text-slate-900">
                {!billingSummary.featureGateEnabled
                  ? "Billing disabled"
                  : billingSummary.hasActivePlan
                    ? "Active plan"
                    : "Payment required"}
              </p>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                {!billingSummary.featureGateEnabled
                  ? "Cloud billing gates are disabled in this environment."
                  : billingSummary.hasActivePlan
                    ? "Your account can launch cloud workers right now."
                    : "Complete checkout to unlock cloud worker launches."}
              </p>
              <p className="mt-3 text-sm font-semibold text-slate-900">
                {billingPrice && billingPrice.amount !== null
                  ? `${formatMoneyMinor(billingPrice.amount, billingPrice.currency)} ${formatRecurringInterval(billingPrice.recurringInterval, billingPrice.recurringIntervalCount)}`
                  : "Current plan amount is unavailable."}
              </p>

              {effectiveCheckoutUrl ? (
                <div className="mt-4 rounded-[18px] border border-amber-200 bg-amber-50 p-4">
                  <p className="text-sm font-semibold text-amber-800">Checkout available</p>
                  <p className="mt-1 text-sm text-amber-700">Open a fresh checkout session, then return here to resume automatically.</p>
                  <a
                    href={effectiveCheckoutUrl}
                    rel="noreferrer"
                    className="mt-3 inline-flex rounded-[12px] border border-amber-300 bg-white px-3 py-2 text-xs font-semibold text-amber-800 transition hover:bg-amber-100"
                  >
                    Continue to checkout
                  </a>
                </div>
              ) : billingSummary.featureGateEnabled && !billingSummary.hasActivePlan ? (
                <div className="mt-4 rounded-[18px] border border-slate-200 bg-slate-50 p-4">
                  <p className="text-sm font-semibold text-slate-900">Need a checkout link?</p>
                  <p className="mt-1 text-sm text-slate-600">Generate a new checkout session for this account.</p>
                  <button
                    type="button"
                    className="mt-3 rounded-[12px] bg-slate-900 px-3 py-2.5 text-xs font-semibold text-white transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-60"
                    onClick={() => void refreshBilling({ includeCheckout: true })}
                    disabled={billingCheckoutBusy || billingBusy}
                  >
                    {billingCheckoutBusy ? "Generating checkout..." : "Generate checkout link"}
                  </button>
                </div>
              ) : null}
            </div>

            <div className="rounded-[24px] border border-[var(--dls-border)] bg-white p-5 shadow-[var(--dls-card-shadow)]">
              <div className="mb-3 flex items-center justify-between gap-2">
                <p className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">Invoices</p>
                <button
                  type="button"
                  className="rounded-[10px] border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-600 transition hover:border-slate-300 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-60"
                  onClick={() => void refreshBilling({ quiet: true })}
                  disabled={billingBusy || billingCheckoutBusy || billingSubscriptionBusy}
                >
                  Refresh invoices
                </button>
              </div>

              {billingSummary.invoices.length > 0 ? (
                <ul className="space-y-2">
                  {billingSummary.invoices.map((invoice) => (
                    <li key={invoice.id} className="rounded-[16px] border border-slate-200 bg-slate-50 px-4 py-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <p className="text-sm font-semibold text-slate-900">{invoice.invoiceNumber ?? shortValue(invoice.id)}</p>
                          <p className="text-xs text-slate-500">{formatIsoDate(invoice.createdAt)}</p>
                        </div>
                        <div className="text-right">
                          <p className="text-sm font-semibold text-slate-900">{formatMoneyMinor(invoice.totalAmount, invoice.currency)}</p>
                          <p className="text-xs text-slate-500">{formatSubscriptionStatus(invoice.status)}</p>
                        </div>
                      </div>
                      {invoice.invoiceUrl ? (
                        <a
                          href={invoice.invoiceUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-3 inline-flex rounded-[10px] border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:border-slate-400 hover:text-slate-900"
                        >
                          Open invoice
                        </a>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-slate-500">No invoices yet.</p>
              )}
            </div>
          </div>

          <div className="space-y-4">
            <div className="rounded-[24px] border border-[var(--dls-border)] bg-white p-5 shadow-[var(--dls-card-shadow)]">
              <p className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">Account</p>
              <p className="mt-2 break-all text-sm font-semibold text-slate-900">{user.email}</p>
              <p className="mt-2 text-xs text-slate-500">Product: {billingSummary.productId ? shortValue(billingSummary.productId) : "Not configured"}</p>
              <p className="text-xs text-slate-500">Benefit: {billingSummary.benefitId ? shortValue(billingSummary.benefitId) : "Not configured"}</p>
            </div>

            <div className="rounded-[24px] border border-[var(--dls-border)] bg-white p-5 shadow-[var(--dls-card-shadow)]">
              <p className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">Subscription</p>
              {billingSubscription ? (
                <>
                  <p className="mt-2 text-lg font-semibold text-slate-900">{formatSubscriptionStatus(billingSubscription.status)}</p>
                  <p className="mt-1 text-sm text-slate-600">
                    {formatMoneyMinor(billingSubscription.amount, billingSubscription.currency)} {formatRecurringInterval(billingSubscription.recurringInterval, billingSubscription.recurringIntervalCount)}
                  </p>
                  <p className="mt-2 text-xs text-slate-500">
                    {billingSubscription.cancelAtPeriodEnd
                      ? `Cancels on ${formatIsoDate(billingSubscription.currentPeriodEnd)}`
                      : `Renews on ${formatIsoDate(billingSubscription.currentPeriodEnd)}`}
                  </p>
                </>
              ) : (
                <p className="mt-2 text-sm text-slate-600">No active subscription found.</p>
              )}
            </div>

            <div className="rounded-[24px] border border-[var(--dls-border)] bg-white p-5 shadow-[var(--dls-card-shadow)]">
              <p className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">Manage subscription</p>
              {billingSummary.portalUrl ? (
                <a
                  href={billingSummary.portalUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-flex rounded-[10px] border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:border-slate-400 hover:text-slate-900"
                >
                  Open billing portal
                </a>
              ) : (
                <button
                  type="button"
                  className="mt-2 inline-flex rounded-[10px] border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:border-slate-400 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-60"
                  onClick={() => void refreshBilling({ quiet: true })}
                  disabled={billingBusy || billingCheckoutBusy || billingSubscriptionBusy}
                >
                  Refresh portal link
                </button>
              )}

              {billingSubscription ? (
                <button
                  type="button"
                  className={`mt-2 inline-flex rounded-[10px] px-3 py-2 text-xs font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-60 ${
                    billingSubscription.cancelAtPeriodEnd ? "bg-slate-700 hover:bg-slate-800" : "bg-rose-600 hover:bg-rose-700"
                  }`}
                  onClick={() => void handleSubscriptionCancellation(!billingSubscription.cancelAtPeriodEnd)}
                  disabled={billingSubscriptionBusy || billingBusy || billingCheckoutBusy}
                >
                  {billingSubscriptionBusy
                    ? "Updating..."
                    : billingSubscription.cancelAtPeriodEnd
                      ? "Resume auto-renew"
                      : "Cancel at period end"}
                </button>
              ) : null}

              <p className="mt-2 text-xs text-slate-500">You can also cancel from the billing portal at any time.</p>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
