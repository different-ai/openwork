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

function formatRecurringPrice(
  price: { amount: number | null; currency: string | null; recurringInterval: string | null } | null | undefined,
  fallback: string,
) {
  if (!price || price.amount === null || !price.currency) {
    return fallback;
  }

  const interval = price.recurringInterval === "month"
    ? "mo"
    : (price.recurringInterval ?? "period");

  return `${formatMoneyMinor(price.amount, price.currency)}/${interval}`;
}

function LoadingPanel({ title, body }: { title: string; body: string }) {
  return (
    <section className="den-page py-4 lg:py-6">
      <div className="den-frame-soft grid max-w-[44rem] gap-3 p-6 md:p-7">
        <p className="den-eyebrow">OpenWork Cloud</p>
        <h1 className="den-title-lg">{title}</h1>
        <p className="den-copy">{body}</p>
      </div>
    </section>
  );
}

function BulletList({ items }: { items: string[] }) {
  return (
    <div className="den-bullet-list">
      {items.map((item) => (
        <div key={item} className="den-bullet-item">
          <span className="den-bullet-dot" aria-hidden="true" />
          <span>{item}</span>
        </div>
      ))}
    </div>
  );
}

function FeatureInsetCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="den-frame-inset grid gap-3 rounded-[1.5rem] p-4">
      <p className="den-stat-label">{title}</p>
      <p className="m-0 text-sm leading-6 text-[var(--dls-text-secondary)]">{body}</p>
    </div>
  );
}

export function CheckoutScreen({ customerSessionToken }: { customerSessionToken: string | null }) {
  const router = useRouter();
  const pathname = usePathname();
  const handledReturnRef = useRef(false);
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
    effectiveWorkerCheckoutUrl,
    refreshBilling,
    refreshCheckoutReturn,
  } = useDenFlow();

  const mockMode = MOCK_BILLING && process.env.NODE_ENV !== "production";

  const billingSummary = MOCK_BILLING
    ? {
        featureGateEnabled: true,
        hasActivePlan: false,
        checkoutRequired: true,
        checkoutUrl: MOCK_CHECKOUT_URL,
        activeWorkerSubscriptions: 0,
        workerCheckoutUrl: MOCK_CHECKOUT_URL,
        workerCheckoutRequired: true,
        workerPrice: { amount: 5000, currency: "usd", recurringInterval: "month", recurringIntervalCount: 1 },
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

    const needsCheckoutUrl = billingSummary?.hasActivePlan
      ? !effectiveWorkerCheckoutUrl
      : !effectiveCheckoutUrl;

    if (needsCheckoutUrl && !billingBusy && !billingCheckoutBusy) {
      void refreshBilling({ includeCheckout: true, quiet: true });
    }
  }, [
    billingBusy,
    billingCheckoutBusy,
    billingSummary?.hasActivePlan,
    effectiveCheckoutUrl,
    effectiveWorkerCheckoutUrl,
    refreshBilling,
    resuming,
    sessionHydrated,
    user,
  ]);

  if (!sessionHydrated || (!user && !mockMode)) {
    return (
      <LoadingPanel
        title="Checking your billing session."
        body="Loading your account before continuing."
      />
    );
  }

  if (redirectMessage) {
    return <LoadingPanel title="One moment." body={redirectMessage} />;
  }

  const billingPrice = billingSummary?.price ?? null;
  const workerBillingPrice = billingSummary?.workerPrice ?? null;
  const showLoading = resuming || (billingBusy && !billingSummary && !MOCK_BILLING);
  const isWorkerCheckout = billingSummary?.hasActivePlan === true;
  const checkoutHref = isWorkerCheckout
    ? effectiveWorkerCheckoutUrl ?? MOCK_CHECKOUT_URL ?? null
    : effectiveCheckoutUrl ?? MOCK_CHECKOUT_URL ?? null;
  const planAmountLabel = formatRecurringPrice(billingPrice, "$50/mo");
  const workerAmountLabel = formatRecurringPrice(workerBillingPrice, "$50/mo");

  const heroTitle = isWorkerCheckout ? "Add cloud compute." : "Your team, one click away.";
  const heroCopy = isWorkerCheckout
    ? "Your team plan is active. Add capacity when you need more always-on work."
    : "From $50/mo for up to 5 people. Add cloud compute when you need it.";
  const primaryCtaLabel = checkoutHref
    ? (isWorkerCheckout ? `Add cloud compute — ${workerAmountLabel}` : `Start team plan — ${planAmountLabel}`)
    : (isWorkerCheckout ? "Refresh cloud compute link" : "Refresh checkout link");
  const metaItems = isWorkerCheckout
    ? ["Per worker add-on", "Billed monthly", user?.email ?? "Signed in"]
    : ["5 seats included", "Billed monthly", user?.email ?? "Signed in"];

  const primarySurface = isWorkerCheckout
    ? {
        kicker: "Cloud compute",
        title: "More room for always-on work.",
        copy: "Your team plan is live. Add capacity for cloud agents when workloads grow.",
        bullets: [
          "Scale compute one worker at a time",
          "Keep always-on workflows moving",
          "Add capacity only when the team needs it",
        ],
        cards: [
          { title: "Per worker", body: `${workerAmountLabel} billed monthly.` },
          { title: "Cloud agents", body: "Always-on workflows for the org. In alpha." },
        ],
      }
    : {
        kicker: "Team plan",
        title: "Everyone on the same page.",
        copy: "Push one config to your whole org. Add cloud agents or your own models whenever you're ready.",
        bullets: [
          "Shared config and tools across seats",
          "Cloud agents that run while you sleep",
          "Bring your own LLM provider soon",
        ],
        cards: [
          { title: "Cloud agents", body: "Always-on workflows for the org. In alpha." },
          { title: "Your models", body: "Connect your provider when the team is ready." },
        ],
      };

  return (
    <section className="den-page grid gap-6 py-4 lg:py-6">
      <div className="den-frame grid gap-6 p-6 md:p-8 lg:p-10">
        <div className="flex flex-col gap-4 lg:max-w-3xl">
          <div className="grid gap-3">
            <p className="den-eyebrow">OpenWork Cloud</p>
            <h1 className="den-title-xl max-w-[12ch]">{heroTitle}</h1>
            <p className="den-copy max-w-2xl">{heroCopy}</p>
          </div>

          <div className="flex flex-wrap gap-3">
            {checkoutHref ? (
              <a href={checkoutHref} rel="noreferrer" className="den-button-primary w-full sm:w-auto">
                {primaryCtaLabel}
              </a>
            ) : (
              <button
                type="button"
                className="den-button-primary w-full sm:w-auto"
                onClick={() => void refreshBilling({ includeCheckout: true, quiet: false })}
                disabled={billingBusy || billingCheckoutBusy}
              >
                {primaryCtaLabel}
              </button>
            )}

            {isWorkerCheckout ? (
              billingSummary?.portalUrl ? (
                <a href={billingSummary.portalUrl} rel="noreferrer" target="_blank" className="den-button-secondary w-full sm:w-auto">
                  Billing portal
                </a>
              ) : null
            ) : (
              <a href="https://openworklabs.com/download" className="den-button-secondary w-full sm:w-auto">
                Stay on desktop
              </a>
            )}
          </div>

          <div className="den-meta-row">
            {metaItems.map((item, index) => (
              <span key={`${item}-${index}`} className="flex items-center gap-3">
                {index > 0 ? <span aria-hidden="true">•</span> : null}
                <span>{item}</span>
              </span>
            ))}
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
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
          <article className="den-frame grid gap-6 p-6 md:p-7">
            <div className="grid gap-3">
              <span className="den-kicker w-fit">{primarySurface.kicker}</span>
              <h2 className="den-title-lg">{primarySurface.title}</h2>
              <p className="den-copy">{primarySurface.copy}</p>
            </div>

            <BulletList items={primarySurface.bullets} />

            <div className="grid gap-4 md:grid-cols-2">
              {primarySurface.cards.map((card) => (
                <FeatureInsetCard key={card.title} title={card.title} body={card.body} />
              ))}
            </div>
          </article>

          <article className="den-frame-soft grid gap-5 p-6 md:p-7">
            <div className="grid gap-3">
              <span className="den-kicker w-fit">Free desktop</span>
              <h2 className="den-title-lg">Start local, go cloud later.</h2>
              <p className="den-copy">
                Everything runs on your machine. Upgrade when the team grows.
              </p>
            </div>

            <BulletList
              items={[
                "Full product, zero cost",
                "Your data stays local",
                "Cloud is one click away when you're ready",
              ]}
            />

            <div className="mt-auto pt-2">
              <a href="https://openworklabs.com/download" className="den-button-secondary w-full sm:w-auto">
                Download desktop
              </a>
            </div>
          </article>
        </div>
      ) : null}
    </section>
  );
}
