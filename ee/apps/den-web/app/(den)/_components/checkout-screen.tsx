"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { isSamePathname } from "../_lib/client-route";
import { formatMoneyMinor } from "../_lib/den-flow";
import { useDenFlow } from "../_providers/den-flow-provider";

// For local layout testing (no deploy needed)
// Enable with: NEXT_PUBLIC_DEN_MOCK_BILLING=1
const MOCK_BILLING = process.env.NEXT_PUBLIC_DEN_MOCK_BILLING === "1";
const MOCK_CHECKOUT_URL = (process.env.NEXT_PUBLIC_DEN_MOCK_CHECKOUT_URL ?? "").trim() || null;

function formatSubscriptionStatus(value: string | null | undefined) {
  if (!value) return "Purchase required";
  return value
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function LoadingPanel({ title, body }: { title: string; body: string }) {
  return (
    <section className="den-page py-4">
      <div className="den-frame-soft grid max-w-[44rem] gap-4 p-6">
        <h1 className="text-xl font-semibold tracking-tight text-[var(--dls-text-primary)]">{title}</h1>
        <p className="text-sm text-[var(--dls-text-secondary)]">{body}</p>
      </div>
    </section>
  );
}

export function CheckoutScreen({ customerSessionToken }: { customerSessionToken: string | null }) {
  const router = useRouter();
  const pathname = usePathname();
  const handledReturnRef = useRef(false);
  const redirectingRef = useRef(false);
  const [resuming, setResuming] = useState(false);
  const [redirectMessage, setRedirectMessage] = useState<string | null>(null);
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
        checkoutRequired: true,
              checkoutUrl: MOCK_CHECKOUT_URL,
              portalUrl: null,
              price: { amount: 5000, currency: "usd", recurringInterval: "month", recurringIntervalCount: 1 },
        subscription: null,
        invoices: [],
        productId: null,
        benefitId: null,
      }
    : realBillingSummary;

  useEffect(() => {
    if (!sessionHydrated || resuming || user || mockMode) {
      return;
    }

    setRedirectMessage("Redirecting to sign in...");
    if (!isSamePathname(pathname, "/")) {
      router.replace("/");
    }
  }, [mockMode, pathname, resuming, router, sessionHydrated, user]);

  useEffect(() => {
    if (!sessionHydrated || !user || handledReturnRef.current || !customerSessionToken) {
      return;
    }

    handledReturnRef.current = true;
    setResuming(true);
    setRedirectMessage("Finishing your checkout...");

    void refreshCheckoutReturn(true)
      .then((target) => {
        if (target && !isSamePathname(pathname, target)) {
          router.replace(target);
          return;
        }

        setRedirectMessage(null);
        setResuming(false);
      })
      .catch(() => {
        setRedirectMessage(null);
        setResuming(false);
      });
  }, [customerSessionToken, pathname, refreshCheckoutReturn, router, sessionHydrated, user]);

  useEffect(() => {
    if (!sessionHydrated || !user || resuming) {
      return;
    }

    if (!billingSummary?.hasActivePlan && !effectiveCheckoutUrl && !billingBusy && !billingCheckoutBusy) {
      void refreshBilling({ includeCheckout: true, quiet: true });
    }
  }, [
    billingBusy,
    billingCheckoutBusy,
    billingSummary?.hasActivePlan,
    effectiveCheckoutUrl,
    refreshBilling,
    resuming,
    sessionHydrated,
    user,
  ]);

  useEffect(() => {
    if (
      !sessionHydrated ||
      !user ||
      resuming ||
      onboardingPending ||
      mockMode ||
      redirectingRef.current ||
      billingBusy ||
      billingCheckoutBusy ||
      !billingSummary ||
      (billingSummary.featureGateEnabled && !billingSummary.hasActivePlan)
    ) {
      return;
    }

    redirectingRef.current = true;
    void resolveUserLandingRoute()
      .then((target) => {
        if (target && !isSamePathname(pathname, target)) {
          setRedirectMessage("Redirecting to your workspace...");
          router.replace(target);
          return;
        }

        setRedirectMessage(null);
      })
      .finally(() => {
        redirectingRef.current = false;
      });
  }, [
    billingBusy,
    billingCheckoutBusy,
    billingSummary,
    mockMode,
    onboardingPending,
    pathname,
    resolveUserLandingRoute,
    resuming,
    router,
    sessionHydrated,
    user,
  ]);

  if (!sessionHydrated || (!user && !mockMode)) {
    return (
      <LoadingPanel
        title="Checking your billing session..."
        body="Loading your account and billing state before continuing."
      />
    );
  }

  if (redirectMessage) {
    return <LoadingPanel title="One moment." body={redirectMessage} />;
  }

  const billingPrice = billingSummary?.price ?? null;
  const showLoading = resuming || (billingBusy && !billingSummary && !MOCK_BILLING);
  const checkoutHref = effectiveCheckoutUrl ?? MOCK_CHECKOUT_URL ?? null;
  const planAmountLabel =
    billingPrice && billingPrice.amount !== null
      ? `${formatMoneyMinor(billingPrice.amount, billingPrice.currency)}/${billingPrice.recurringInterval}`
      : "$50.00/month";
  const subscription = billingSummary?.subscription ?? null;
  const subscriptionStatus = formatSubscriptionStatus(subscription?.status);

  return (
    <section className="den-page grid gap-6 py-4 lg:py-6">
      <div className="den-frame grid gap-6 p-6 md:p-8 lg:p-10">
        <div className="flex flex-col gap-4 lg:max-w-3xl">
          <div className="grid gap-3">
            <p className="den-eyebrow">OpenWork Cloud</p>
            <h1 className="den-title-xl max-w-[14ch]">Purchase a plan before creating your workspace.</h1>
            <p className="den-copy max-w-2xl">
              Start with one workspace plan for $50/month. Each plan includes up to 5 members and 1 hosted worker.
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            {checkoutHref ? (
              <a href={checkoutHref} rel="noreferrer" className="den-button-primary w-full sm:w-auto">
                Purchase plan — $50/month
              </a>
            ) : (
              <button
                type="button"
                className="den-button-primary w-full sm:w-auto"
                onClick={() => void refreshBilling({ includeCheckout: true, quiet: false })}
                disabled={billingBusy || billingCheckoutBusy}
              >
                Refresh purchase link
              </button>
            )}
            <a href="https://openworklabs.com/download" className="den-button-secondary w-full sm:w-auto">
              Use desktop only
            </a>
          </div>

          <div className="flex flex-wrap items-center gap-3 text-sm text-[var(--dls-text-secondary)]">
            <span>$50/month per workspace</span>
            <span aria-hidden="true">•</span>
            <span>{planAmountLabel} billed monthly</span>
            <span aria-hidden="true">•</span>
            <span>{user?.email ?? "Signed in"}</span>
          </div>
        </div>
      </div>

      {billingError ? <div className="den-notice is-error">{billingError}</div> : null}
      {showLoading ? (
        <div className="den-frame-soft px-5 py-4 text-sm text-[var(--dls-text-secondary)]">
          Refreshing access state...
        </div>
      ) : null}

      {billingSummary ? (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_320px]">
          <div className="grid gap-6">
            <article className="den-frame grid gap-6 p-6 md:p-7">
              <div className="grid gap-3">
                <span className="den-kicker w-fit">OpenWork Cloud</span>
                <h2 className="den-title-lg">Share your setup across your team.</h2>
                <p className="den-copy">
                  Manage your team&apos;s setup, invite teammates, and keep everything in sync.
                </p>
              </div>

              <div className="grid gap-3 text-sm text-[var(--dls-text-secondary)]">
                <div className="flex gap-3"><span className="mt-2 h-1.5 w-1.5 rounded-full bg-slate-300" />Share setup across your team and org</div>
                <div className="flex gap-3"><span className="mt-2 h-1.5 w-1.5 rounded-full bg-slate-300" />Background agents in alpha for selected workflows</div>
                <div className="flex gap-3"><span className="mt-2 h-1.5 w-1.5 rounded-full bg-slate-300" />Custom LLM providers with team access controls</div>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="den-frame-inset rounded-[1.5rem] p-4">
                  <p className="den-stat-label">Background agents</p>
                  <p className="mt-3 text-sm text-[var(--dls-text-secondary)]">
                    Keep selected workflows running in the background. Alpha.
                  </p>
                </div>
                <div className="den-frame-inset rounded-[1.5rem] p-4">
                  <p className="den-stat-label">LLM providers</p>
                  <p className="mt-3 text-sm text-[var(--dls-text-secondary)]">
                    Standardize provider access, model selection, and team rollout.
                  </p>
                </div>
              </div>
            </article>

            <article className="den-frame-soft grid gap-5 p-6 md:p-7">
              <div className="grid gap-3">
                <span className="den-kicker w-fit">Desktop app</span>
                <h2 className="den-title-lg">Stay local when you need to.</h2>
                <p className="den-copy">
                  Run locally for free, keep your data on your machine, and add OpenWork Cloud when your team is ready.
                </p>
              </div>

              <div className="grid gap-3 text-sm text-[var(--dls-text-secondary)]">
                <div className="flex gap-3"><span className="mt-2 h-1.5 w-1.5 rounded-full bg-slate-300" />Run locally for free</div>
                <div className="flex gap-3"><span className="mt-2 h-1.5 w-1.5 rounded-full bg-slate-300" />Keep data on your machine</div>
                <div className="flex gap-3"><span className="mt-2 h-1.5 w-1.5 rounded-full bg-slate-300" />Move into OpenWork Cloud later</div>
              </div>

              <div className="mt-auto pt-2">
                <a href="https://openworklabs.com/download" className="den-button-secondary w-full sm:w-auto">
                  Use desktop only
                </a>
              </div>
            </article>
          </div>

          <aside className="den-frame-soft grid h-fit gap-4 p-5 md:p-6">
            <div className="grid gap-2">
              <p className="den-eyebrow">Billing status</p>
              <h2 className="text-2xl font-semibold tracking-tight text-[var(--dls-text-primary)]">{subscriptionStatus}</h2>
              <p className="den-copy text-sm">
                {billingSummary.hasActivePlan ? "Your workspace plan is active." : "Purchase a plan to create your first workspace."}
              </p>
            </div>

            <div className="den-frame-inset grid gap-3 rounded-[1.5rem] px-4 py-4">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium text-[var(--dls-text-primary)]">Plan</span>
                <span className={`den-status-pill ${billingSummary.hasActivePlan ? "is-positive" : "is-neutral"}`}>
                  {subscriptionStatus}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3 text-sm text-[var(--dls-text-secondary)]">
                <span>Price</span>
                <span className="font-medium text-[var(--dls-text-primary)]">{planAmountLabel}</span>
              </div>
              <div className="flex items-center justify-between gap-3 text-sm text-[var(--dls-text-secondary)]">
                <span>Invoices</span>
                <span className="font-medium text-[var(--dls-text-primary)]">{billingSummary.invoices.length}</span>
              </div>
            </div>

            <div className="grid gap-3">
              {checkoutHref && !billingSummary.hasActivePlan ? (
                <a href={checkoutHref} rel="noreferrer" className="den-button-primary w-full">
                  Purchase plan
                </a>
              ) : null}
              {billingSummary.portalUrl ? (
                <a href={billingSummary.portalUrl} rel="noreferrer" target="_blank" className="den-button-secondary w-full">
                  Open billing portal
                </a>
              ) : null}
              <button
                type="button"
                className="den-button-secondary w-full"
                onClick={() => void refreshBilling({ includeCheckout: true, quiet: false })}
                disabled={billingBusy || billingCheckoutBusy}
              >
                Refresh billing
              </button>
            </div>

            <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm text-[var(--dls-text-secondary)]">
              {billingSummary.portalUrl ? (
                <a href={billingSummary.portalUrl} rel="noreferrer" target="_blank" className="font-medium text-[var(--dls-text-primary)] transition hover:opacity-70">
                  Billing portal
                </a>
              ) : null}
              <span>Invoices {billingSummary.invoices.length > 0 ? `(${billingSummary.invoices.length})` : ""}</span>
              <span>Monthly billing</span>
            </div>
          </aside>
        </div>
      ) : null}
    </section>
  );
}
