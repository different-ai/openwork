"use client";

import {
  CheckCircle2,
  CreditCard,
  Download,
  RefreshCw,
  Server,
  ShieldCheck,
  Users,
} from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  buildLocalMockBillingSummary,
  formatBillingPlanLabels,
  getBillingStatusLabel,
  getWorkspacePlanInlineEntitlementCopy,
  getWorkspacePlanEntitlementCopy,
  isLocalMockBillingEnabled,
} from "../_lib/billing-display";
import { isSamePathname } from "../_lib/client-route";
import { useDenFlow } from "../_providers/den-flow-provider";

// For local layout testing (no deploy needed)
// Enable with: NEXT_PUBLIC_DEN_MOCK_BILLING=1
const MOCK_CHECKOUT_URL = (process.env.NEXT_PUBLIC_DEN_MOCK_CHECKOUT_URL ?? "").trim() || null;

function LoadingPanel({ title, body }: { title: string; body: string }) {
  return (
    <section className="den-page py-4">
      <div className="den-frame-soft grid max-w-[44rem] gap-4 p-6">
        <h1 className="text-xl font-semibold tracking-normal text-[var(--dls-text-primary)]">{title}</h1>
        <p className="text-sm text-[var(--dls-text-secondary)]">{body}</p>
      </div>
    </section>
  );
}

function FeatureLine({
  icon: Icon,
  title,
  body,
}: {
  icon: typeof CheckCircle2;
  title: string;
  body?: string;
}) {
  return (
    <div className="flex gap-3">
      <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-gray-200 bg-gray-50 text-gray-900">
        <Icon className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />
      </div>
      <div className="grid min-w-0 gap-1">
        <p className="m-0 text-sm font-semibold text-[var(--dls-text-primary)]">{title}</p>
        {body ? <p className="m-0 break-words text-sm leading-6 text-[var(--dls-text-secondary)]">{body}</p> : null}
      </div>
    </div>
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

  const mockMode = isLocalMockBillingEnabled({
    flag: process.env.NEXT_PUBLIC_DEN_MOCK_BILLING,
    nodeEnv: process.env.NODE_ENV,
  });

  const billingSummary = mockMode ? buildLocalMockBillingSummary(MOCK_CHECKOUT_URL) : realBillingSummary;

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
  const showLoading = resuming || (billingBusy && !billingSummary && !mockMode);
  const checkoutHref = effectiveCheckoutUrl ?? billingSummary?.checkoutUrl ?? (mockMode ? MOCK_CHECKOUT_URL : null);
  const planLabels = formatBillingPlanLabels(billingPrice);
  const compactPlanAmountLabel =
    billingPrice && billingPrice.amount !== null
      ? `${planLabels.amount}/${billingPrice.recurringInterval ?? "billing cycle"}`
      : planLabels.inline;
  const billingScheduleLabel =
    billingPrice?.recurringInterval === "month" ? "billed monthly" : `billed ${planLabels.cadence}`;
  const hasActivePlan = Boolean(billingSummary?.hasActivePlan);
  const subscriptionStatus = getBillingStatusLabel(billingSummary);

  return (
    <section className="den-page grid gap-6 py-4 lg:py-6">
      <div className="den-frame overflow-hidden">
        <div className="grid gap-8 p-6 md:p-8 lg:grid-cols-[minmax(0,1fr)_360px] lg:p-10">
          <div className="flex flex-col justify-center gap-5">
            <p className="den-eyebrow">OpenWork Cloud</p>
            <h1 className="den-title-xl max-w-[14ch]">Purchase a plan before creating your workspace.</h1>
            <p className="den-copy max-w-2xl">
              Start with one workspace plan for {compactPlanAmountLabel}. Each plan {getWorkspacePlanInlineEntitlementCopy()}.
            </p>

            <div className="flex flex-wrap gap-3">
              {checkoutHref ? (
                <a href={checkoutHref} rel="noreferrer" className="den-button-primary w-full sm:w-auto">
                  <CreditCard className="h-4 w-4" aria-hidden="true" />
                  <span>Purchase plan</span>
                  {planLabels.available ? <span className="hidden sm:inline">— {compactPlanAmountLabel}</span> : null}
                </a>
              ) : (
                <button
                  type="button"
                  className="den-button-primary w-full sm:w-auto"
                  onClick={() => void refreshBilling({ includeCheckout: true, quiet: false })}
                  disabled={billingBusy || billingCheckoutBusy}
                >
                  <RefreshCw className="h-4 w-4" aria-hidden="true" />
                  Refresh purchase link
                </button>
              )}
              <a href="https://openworklabs.com/download" className="den-button-secondary w-full sm:w-auto">
                <Download className="h-4 w-4" aria-hidden="true" />
                Use desktop only
              </a>
            </div>

            <div className="flex flex-wrap items-center gap-3 text-sm text-[var(--dls-text-secondary)]">
              <span>{planLabels.available ? `${compactPlanAmountLabel} per workspace` : planLabels.inline}</span>
              <span aria-hidden="true">•</span>
              <span>{planLabels.available ? `${compactPlanAmountLabel} ${billingScheduleLabel}` : planLabels.inline}</span>
              <span className="hidden sm:inline" aria-hidden="true">•</span>
              <span className="hidden sm:inline">{user?.email ?? "Signed in"}</span>
            </div>
          </div>

          <div className="rounded-2xl border border-[#011627] bg-[#011627] p-5 text-white shadow-[0_24px_40px_-28px_rgba(15,23,42,0.5)]">
            <div className="mb-8 flex items-center justify-between gap-4">
              <span className="rounded-md border border-white/15 bg-white/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-white/75">
                Workspace plan
              </span>
              <ShieldCheck className="h-5 w-5 text-white/70" aria-hidden="true" />
            </div>
            <div className="grid gap-2">
              <div className="flex items-end gap-2">
                <span className="text-4xl font-semibold leading-none">{planLabels.amount}</span>
                <span className="pb-1 text-sm text-white/65">{planLabels.cadence}</span>
              </div>
              <p className="text-sm leading-6 text-white/70">
                {getWorkspacePlanEntitlementCopy()}
              </p>
            </div>
            <div className="mt-6 grid gap-3 border-t border-white/10 pt-5 text-sm text-white/75">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-white/70" aria-hidden="true" />
                Share setup across your team and org
              </div>
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-white/70" aria-hidden="true" />
                Background agents in alpha for selected workflows
              </div>
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-white/70" aria-hidden="true" />
                Custom LLM providers with team access controls
              </div>
            </div>
          </div>
        </div>
      </div>

      {billingError ? <div className="den-notice is-error">{billingError}</div> : null}
      {showLoading ? (
        <div className="den-frame-soft px-5 py-4 text-sm text-[var(--dls-text-secondary)]">
          Refreshing access state...
        </div>
      ) : null}
      {!billingSummary && !showLoading ? (
        <div className="den-notice is-info">
          Billing details are unavailable. Refresh the purchase link to retry.
        </div>
      ) : null}

      {billingSummary ? (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
          <div className="grid gap-6 lg:grid-cols-2">
            <article className="den-frame grid gap-6 p-6 md:p-7">
              <div className="grid gap-3">
                <span className="den-kicker w-fit">OpenWork Cloud</span>
                <h2 className="den-title-lg">Share your setup across your team.</h2>
                <p className="den-copy">
                  Manage your team&apos;s setup, invite teammates, and keep everything in sync.
                </p>
              </div>

              <div className="grid gap-4">
                <FeatureLine
                  icon={Users}
                  title="Share setup across your team and org"
                />
                <FeatureLine
                  icon={Server}
                  title="Background agents in alpha for selected workflows"
                />
                <FeatureLine
                  icon={ShieldCheck}
                  title="Custom LLM providers with team access controls"
                />
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

              <div className="grid gap-4">
                <FeatureLine
                  icon={Download}
                  title="Run locally for free"
                />
                <FeatureLine
                  icon={ShieldCheck}
                  title="Keep data on your machine"
                />
                <FeatureLine
                  icon={CheckCircle2}
                  title="Move into OpenWork Cloud later"
                />
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
              <h2 className="text-2xl font-semibold tracking-normal text-[var(--dls-text-primary)]">{subscriptionStatus}</h2>
              <p className="den-copy text-sm">
                {hasActivePlan ? "Your workspace plan is active." : "Purchase a plan to create your first workspace."}
              </p>
            </div>

            <div className="den-frame-inset grid gap-3 rounded-xl px-4 py-4">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium text-[var(--dls-text-primary)]">Plan</span>
                <span className={`den-status-pill ${hasActivePlan ? "is-positive" : "is-neutral"}`}>
                  {subscriptionStatus}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3 text-sm text-[var(--dls-text-secondary)]">
                <span>Price</span>
                <span className="font-medium text-[var(--dls-text-primary)]">{planLabels.inline}</span>
              </div>
              <div className="flex items-center justify-between gap-3 text-sm text-[var(--dls-text-secondary)]">
                <span>Invoices</span>
                <span className="font-medium text-[var(--dls-text-primary)]">{billingSummary.invoices.length}</span>
              </div>
            </div>

            <div className="grid gap-3">
              {checkoutHref && !hasActivePlan ? (
                <a href={checkoutHref} rel="noreferrer" className="den-button-primary w-full">
                  <CreditCard className="h-4 w-4" aria-hidden="true" />
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
                <RefreshCw className="h-4 w-4" aria-hidden="true" />
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
