"use client";

import { Dithering, MeshGradient } from "@paper-design/shaders-react";
import { ArrowRight, CheckCircle2, Monitor } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { isSamePathname } from "../_lib/client-route";
import { formatMoneyMinor } from "../_lib/den-flow";
import { useDenFlow } from "../_providers/den-flow-provider";

// For local layout testing (no deploy needed)
// Enable with: NEXT_PUBLIC_DEN_MOCK_BILLING=1
const MOCK_BILLING = process.env.NEXT_PUBLIC_DEN_MOCK_BILLING === "1";
const MOCK_CHECKOUT_URL = (process.env.NEXT_PUBLIC_DEN_MOCK_CHECKOUT_URL ?? "").trim() || null;
const TRIAL_DAYS = 14;

function formatSubscriptionStatus(value: string | null | undefined) {
  if (!value) return "Trial ready";
  return value
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function LoadingPanel({ title, body }: { title: string; body: string }) {
  return (
    <section className="den-page py-4">
      <div className="rounded-[28px] border border-gray-100 bg-white p-6 shadow-[0_10px_30px_-24px_rgba(15,23,42,0.22)] md:p-8">
        <div className="grid gap-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-400">
            OpenWork Cloud
          </p>
          <h1 className="text-[30px] font-semibold tracking-[-0.05em] text-gray-900">{title}</h1>
          <p className="text-[14px] leading-relaxed text-gray-500">{body}</p>
        </div>
        <div className="mt-6 h-2 overflow-hidden rounded-full bg-gray-100">
          <div className="h-full w-1/3 animate-pulse rounded-full bg-gray-900/80" />
        </div>
      </div>
    </section>
  );
}

function BenefitCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-2xl border border-gray-100 bg-white p-5">
      <p className="mb-2 text-[14px] font-medium text-gray-900">{title}</p>
      <p className="text-[13px] leading-[1.6] text-gray-500">{body}</p>
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
    if (!sessionHydrated || !user || resuming || onboardingPending || mockMode || redirectingRef.current) {
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
  }, [mockMode, onboardingPending, pathname, resolveUserLandingRoute, resuming, router, sessionHydrated, user]);

  if (!sessionHydrated || (!user && !mockMode)) {
    return (
      <LoadingPanel
        title="Checking billing access."
        body="Loading your account and billing state before we continue."
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
      <div className="relative overflow-hidden rounded-[32px] border border-gray-100 px-7 py-8 md:px-10 md:py-10">
        <div className="absolute inset-0 z-0">
          <Dithering
            speed={0}
            shape="warp"
            type="4x4"
            size={2.5}
            scale={1}
            frame={27618.9}
            colorBack="#00000000"
            colorFront="#FEFEFE"
            style={{ backgroundColor: "#18222F", width: "100%", height: "100%" }}
          >
            <MeshGradient
              speed={0.65}
              distortion={0.8}
              swirl={0.1}
              grainMixer={0}
              grainOverlay={0}
              frame={176868.9}
              colors={["#E0FCFF", "#1D7B9A", "#50F7D4", "#518EF0"]}
              style={{ width: "100%", height: "100%" }}
            />
          </Dithering>
        </div>

        <div className="relative z-10 grid gap-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
          <div className="grid gap-4 lg:max-w-3xl">
            <div className="flex items-center gap-3">
              <img src="/openwork-mark.svg" alt="OpenWork" className="h-9 w-auto" />
              <span className="text-[13px] font-medium text-white/80">OpenWork Cloud</span>
            </div>

            <div className="grid gap-3">
              <span className="inline-flex w-fit rounded-full border border-white/20 bg-white/15 px-3 py-1 text-[10px] font-medium uppercase tracking-[0.18em] text-white backdrop-blur-md">
                {TRIAL_DAYS}-day free trial
              </span>
              <h1 className="max-w-[12ch] text-[2.25rem] font-semibold leading-[0.95] tracking-[-0.06em] text-white md:text-[3rem]">
                Provision shared setups for your team.
              </h1>
              <p className="max-w-2xl text-[15px] leading-7 text-white/80">
                Share your setup across your org, launch background workspaces in alpha, and prepare for team-wide provider provisioning.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-3 lg:justify-end">
            {checkoutHref ? (
              <a
                href={checkoutHref}
                rel="noreferrer"
                className="inline-flex min-h-[48px] items-center justify-center gap-2 rounded-full bg-white px-5 py-3 text-[14px] font-medium text-gray-900 transition-colors hover:bg-gray-100"
              >
                Start free trial
                <ArrowRight className="h-4 w-4" />
              </a>
            ) : (
              <button
                type="button"
                className="inline-flex min-h-[48px] items-center justify-center rounded-full bg-white px-5 py-3 text-[14px] font-medium text-gray-900 transition-colors hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-60"
                onClick={() => void refreshBilling({ includeCheckout: true, quiet: false })}
                disabled={billingBusy || billingCheckoutBusy}
              >
                Refresh trial link
              </button>
            )}
            <a
              href="https://openworklabs.com/download"
              className="inline-flex min-h-[48px] items-center justify-center gap-2 rounded-full border border-white/20 bg-white/10 px-5 py-3 text-[14px] font-medium text-white backdrop-blur-md transition-colors hover:bg-white/15"
            >
              <Monitor className="h-4 w-4" />
              Use desktop only
            </a>
          </div>
        </div>
      </div>

      {billingError ? <div className="den-notice is-error">{billingError}</div> : null}
      {showLoading ? (
        <div className="rounded-2xl border border-gray-100 bg-white px-5 py-4 text-sm text-gray-500">
          Refreshing access state...
        </div>
      ) : null}

      {billingSummary ? (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_320px]">
          <div className="grid gap-6">
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              <BenefitCard title="Cloud sharing" body="Share setup across your team and org without reconfiguring every machine." />
              <BenefitCard title="Shared workspaces" body="Keep selected workflows running in the background for high-leverage team flows." />
              <BenefitCard title="Provider rollout" body="Prepare for team-wide LLM provider control and more consistent shared setups." />
            </div>

            <article className="rounded-[28px] border border-gray-100 bg-white p-6 shadow-[0_10px_30px_-24px_rgba(15,23,42,0.18)] md:p-7">
              <div className="grid gap-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-400">Plan summary</p>
                <h2 className="text-[30px] font-semibold tracking-[-0.05em] text-gray-900">
                  {billingSummary.hasActivePlan ? "Your Cloud plan is active." : `Start with a ${TRIAL_DAYS}-day trial.`}
                </h2>
                <p className="text-[14px] leading-relaxed text-gray-500">
                  {billingSummary.hasActivePlan
                    ? "Your team can keep using shared setups and cloud workflows without interruption."
                    : `Try OpenWork Cloud for ${TRIAL_DAYS} days, then continue at ${planAmountLabel}.`}
                </p>
              </div>

              <div className="mt-6 grid gap-3 text-sm text-gray-500">
                <div className="flex gap-3"><span className="mt-2 h-1.5 w-1.5 rounded-full bg-gray-300" />Share setup across your team and org</div>
                <div className="flex gap-3"><span className="mt-2 h-1.5 w-1.5 rounded-full bg-gray-300" />Background workspaces in alpha for selected workflows</div>
                <div className="flex gap-3"><span className="mt-2 h-1.5 w-1.5 rounded-full bg-gray-300" />Custom LLM providers for teams, coming soon</div>
              </div>

              <div className="mt-6 flex flex-wrap gap-3">
                {checkoutHref && !billingSummary.hasActivePlan ? (
                  <a
                    href={checkoutHref}
                    rel="noreferrer"
                    className="inline-flex items-center justify-center gap-2 rounded-full bg-gray-900 px-5 py-3 text-[14px] font-medium text-white transition-colors hover:bg-gray-800"
                  >
                    Start free trial
                    <ArrowRight className="h-4 w-4" />
                  </a>
                ) : null}
                {billingSummary.portalUrl ? (
                  <a
                    href={billingSummary.portalUrl}
                    rel="noreferrer"
                    target="_blank"
                    className="inline-flex items-center justify-center rounded-full border border-gray-200 bg-white px-5 py-3 text-[14px] font-medium text-gray-700 transition-colors hover:bg-gray-50"
                  >
                    Open billing portal
                  </a>
                ) : null}
              </div>
            </article>

            <article className="rounded-[28px] border border-gray-100 bg-white p-6 shadow-[0_10px_30px_-24px_rgba(15,23,42,0.18)] md:p-7">
              <div className="grid gap-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-400">Desktop app</p>
                <h2 className="text-[30px] font-semibold tracking-[-0.05em] text-gray-900">
                  Stay local when you need to.
                </h2>
                <p className="text-[14px] leading-relaxed text-gray-500">
                  Run locally for free, keep your data on your machine, and add OpenWork Cloud when your team is ready.
                </p>
              </div>

              <div className="mt-5 grid gap-3 text-sm text-gray-500">
                <div className="flex gap-3"><span className="mt-2 h-1.5 w-1.5 rounded-full bg-gray-300" />Run locally for free</div>
                <div className="flex gap-3"><span className="mt-2 h-1.5 w-1.5 rounded-full bg-gray-300" />Keep data on your machine</div>
                <div className="flex gap-3"><span className="mt-2 h-1.5 w-1.5 rounded-full bg-gray-300" />Move into OpenWork Cloud later</div>
              </div>

              <div className="mt-6 pt-1">
                <a
                  href="https://openworklabs.com/download"
                  className="inline-flex items-center justify-center gap-2 rounded-full border border-gray-200 bg-white px-5 py-3 text-[14px] font-medium text-gray-700 transition-colors hover:bg-gray-50"
                >
                  <Monitor className="h-4 w-4" />
                  Use desktop only
                </a>
              </div>
            </article>
          </div>

          <aside className="grid h-fit gap-4 rounded-[28px] border border-gray-100 bg-white p-5 shadow-[0_10px_30px_-24px_rgba(15,23,42,0.18)] md:p-6">
            <div className="grid gap-2">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-400">Billing status</p>
              <h2 className="text-2xl font-semibold tracking-tight text-gray-900">{subscriptionStatus}</h2>
              <p className="text-sm leading-relaxed text-gray-500">
                {billingSummary.hasActivePlan
                  ? "Your Cloud plan is active."
                  : `${TRIAL_DAYS}-day free trial before billing starts.`}
              </p>
            </div>

            <div className="grid gap-3 rounded-2xl border border-gray-100 bg-gray-50 px-4 py-4">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium text-gray-900">Plan</span>
                <span className={`den-status-pill ${billingSummary.hasActivePlan ? "is-positive" : "is-neutral"}`}>
                  {subscriptionStatus}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3 text-sm text-gray-500">
                <span>Price</span>
                <span className="font-medium text-gray-900">{planAmountLabel}</span>
              </div>
              <div className="flex items-center justify-between gap-3 text-sm text-gray-500">
                <span>Invoices</span>
                <span className="font-medium text-gray-900">{billingSummary.invoices.length}</span>
              </div>
            </div>

            <div className="grid gap-3">
              {checkoutHref && !billingSummary.hasActivePlan ? (
                <a
                  href={checkoutHref}
                  rel="noreferrer"
                  className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-gray-900 px-5 py-3 text-[14px] font-medium text-white transition-colors hover:bg-gray-800"
                >
                  Start free trial
                  <ArrowRight className="h-4 w-4" />
                </a>
              ) : null}
              {billingSummary.portalUrl ? (
                <a
                  href={billingSummary.portalUrl}
                  rel="noreferrer"
                  target="_blank"
                  className="inline-flex w-full items-center justify-center rounded-full border border-gray-200 bg-white px-5 py-3 text-[14px] font-medium text-gray-700 transition-colors hover:bg-gray-50"
                >
                  Open billing portal
                </a>
              ) : null}
              <button
                type="button"
                className="inline-flex w-full items-center justify-center rounded-full border border-gray-200 bg-white px-5 py-3 text-[14px] font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
                onClick={() => void refreshBilling({ includeCheckout: true, quiet: false })}
                disabled={billingBusy || billingCheckoutBusy}
              >
                Refresh billing
              </button>
            </div>

            <div className="flex flex-wrap gap-2 text-sm text-gray-500">
              {billingSummary.portalUrl ? (
                <a href={billingSummary.portalUrl} rel="noreferrer" target="_blank" className="font-medium text-gray-900 transition hover:opacity-70">
                  Billing portal
                </a>
              ) : null}
              <span>Invoices {billingSummary.invoices.length > 0 ? `(${billingSummary.invoices.length})` : ""}</span>
              <span className="inline-flex items-center gap-1 text-emerald-600">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Cancel anytime
              </span>
            </div>
          </aside>
        </div>
      ) : null}
    </section>
  );
}
